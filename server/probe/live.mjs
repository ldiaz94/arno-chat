/** The live view of a running turn, part of ArnoProbe (probe.mjs): its preview
 * (text and thinking as the model streams them, and what a coding turn is
 * doing), sent to every open /events stream and kept for one that reconnects.
 * The durable job, not this, is the source of truth. Depends on ../http.mjs.
 * Leaves out the routes (session-routes.mjs) and the model's side (../gateways). */
import { SECURITY, json } from '../http.mjs';

/** How many recent steps the live view keeps, and how many of the running
 * turn's steps are kept in memory for its "All steps" list (too large to
 * save: a step holds its call and result). */
const STEPS = 6,
  ALL_STEPS = 500;

export const live = {
  /** Full bounded snapshots make SSE reconnects idempotent. This is a view of
   * the durable job, never its execution lifetime. Slow readers are disconnected
   * rather than allowing their buffers to grow without bound. */
  broadcast(preview, event = 'preview') {
    const frame = new TextEncoder().encode(
      'event: ' + event + '\ndata: ' + JSON.stringify(preview) + '\n\n',
    );
    for (const c of this.viewers || []) {
      try {
        if (c.desiredSize <= 0) {
          c.close();
          this.viewers.delete(c);
        } else c.enqueue(frame);
      } catch {
        this.viewers.delete(c);
      }
    }
  },
  /** What a turn is doing now (a tool call, a worker's step, a new round), for
   * the live view: the current step, and the last STEPS of them as {text, at}
   * for its timeline, plus {n, detail, done} for a coding turn's tool call
   * (serve.mjs activityOf), whose step is updated in place when its result
   * comes. Saved, as the preview is, at most once a second. */
  async activity(step) {
    const job = await this.ctx.storage.get('job');
    if (typeof step === 'string') step = { text: step };
    if (!step?.text || job?.status !== 'running') return;
    const text = step.text;
    const old =
      this.live?.jobId === job.id
        ? this.live
        : { jobId: job.id, round: 0, text: '', reasoning: '' };
    // A step's time is the view's, so a preview updated after it is newer.
    const at = Math.max(Date.now(), (old.updatedAt || 0) + 1);
    // A result for a call already listed (workers run side by side) updates
    // its step and leaves the current line as it is.
    const steps = old.steps || [],
      known = step.n != null ? steps.findIndex(s => s.n === step.n) : -1;
    // Every step of the turn, for GET /session/steps.
    if (this.allSteps?.jobId !== job.id) this.allSteps = { jobId: job.id, steps: [] };
    const all = this.allSteps.steps,
      seen = step.n != null ? all.findIndex(s => s.n === step.n) : -1;
    if (seen >= 0) all[seen] = { ...all[seen], ...step };
    else if (all.length < ALL_STEPS) all.push({ ...step, at: Date.now() });
    this.live = {
      ...old,
      activity: known < 0 ? text : old.activity,
      stepCount: this.allSteps.steps.length,
      steps:
        known < 0
          ? [...steps, { ...step, at }].slice(-STEPS)
          : steps.map((s, i) => (i === known ? { ...s, ...step } : s)),
      updatedAt: at,
    };
    this.broadcast(this.live);
    if (!this.liveSavedAt || Date.now() - this.liveSavedAt >= 1000) {
      this.liveSavedAt = Date.now();
      await this.ctx.storage.put('live', this.live);
    }
  },
  /** A coding turn's workers for the live view (serve.mjs workerOf): one
   * started, {n, model, task}; a step of one, {n, now}, counted; or {done},
   * every one still running over. Sent with the next activity or preview. */
  async worker(u) {
    const job = await this.ctx.storage.get('job');
    if (job?.status !== 'running') return;
    const old =
      this.live?.jobId === job.id
        ? this.live
        : { jobId: job.id, round: 0, text: '', reasoning: '' };
    let workers = old.workers || [];
    if (u.done) workers = workers.map(w => (w.done ? w : { ...w, done: true, now: '' }));
    else if (u.model)
      workers = [
        ...workers.filter(w => w.n !== u.n),
        { n: u.n, model: u.model, task: u.task, steps: 0, now: '', done: false },
      ];
    else
      workers = workers.map(w =>
        w.n === u.n ? { ...w, now: u.now.replace(/^Worker \S+: /, ''), steps: w.steps + 1 } : w,
      );
    this.live = { ...old, workers: workers.slice(-8) };
  },
  /** Take a model snapshot from the gateway as the new live view: ignored unless its turn is
   * running and its round is not older; text is clipped, and the view is saved at most once a
   * second (at once for the final one). */
  async progress(preview) {
    const job = await this.ctx.storage.get('job');
    if (job?.status !== 'running' || (preview.jobId && preview.jobId !== job.id)) return;
    const old = this.live?.jobId === job.id ? this.live : null;
    if (old && preview.round < old.round) return;
    this.live = {
      jobId: job.id,
      round: preview.round,
      text: String(preview.text || '').slice(0, 16000),
      reasoning: String(preview.reasoning || '').slice(0, 12000),
      activity: old?.activity || '',
      steps: old?.steps || [],
      stepCount: old?.stepCount || 0,
      workers: old?.workers || [],
      context: old?.context || 0,
      updatedAt: Math.max(Date.now(), (old?.updatedAt || 0) + 1),
    };
    if (new TextEncoder().encode(JSON.stringify(this.live)).byteLength > 100000) {
      this.live.text = this.live.text.slice(0, 8000);
      this.live.reasoning = this.live.reasoning.slice(0, 6000);
    }
    this.broadcast(this.live);
    if (preview.final || !this.liveSavedAt || Date.now() - this.liveSavedAt >= 1000) {
      this.liveSavedAt = Date.now();
      await this.ctx.storage.put('live', this.live);
    }
  },
  /** GET /session/events: an SSE stream of previews. Sends the saved preview first, a heartbeat
   * every 15 s, and allows at most 8 viewers. */
  async events() {
    const job = await this.ctx.storage.get('job');
    if (!job) return json({ error: 'No active conversation task' }, 404);
    const saved = this.live || (await this.ctx.storage.get('live'));
    this.viewers ||= new Set();
    if (this.viewers.size >= 8) return json({ error: 'Too many live viewers' }, 429);
    let controller, timer;
    const remove = () => {
      clearInterval(timer);
      this.viewers.delete(controller);
    };
    const stream = new ReadableStream({
      start: c => {
        controller = c;
        this.viewers.add(c);
        c.enqueue(new TextEncoder().encode('retry: 1500\n\n'));
        if (saved?.jobId === job.id)
          c.enqueue(
            new TextEncoder().encode('event: preview\ndata: ' + JSON.stringify(saved) + '\n\n'),
          );
        timer = setInterval(() => {
          try {
            if (c.desiredSize <= 0) {
              c.close();
              remove();
            } else c.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
          } catch {
            remove();
          }
        }, 15000);
      },
      cancel: remove,
    });
    return new Response(stream, {
      headers: { ...SECURITY, 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' },
    });
  },
};
