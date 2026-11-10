/** The live view of a running turn, part of ArnoProbe (probe.mjs): its preview
 * (text and thinking as the model streams them, and what a coding turn is
 * doing), sent to every open /events stream and kept for one that reconnects.
 * The durable job, not this, is the source of truth. Depends on ../http.mjs.
 * Leaves out the routes (session-routes.mjs) and the model's side (../gateways). */
import { SECURITY, json } from '../http.mjs';

export const live = {
  /** Full bounded snapshots make SSE reconnects idempotent. This is a view of
   * the durable job, never its execution lifetime. Slow readers are disconnected
   * rather than allowing their buffers to grow without bound. */
  broadcast(preview) {
    const frame = new TextEncoder().encode(
      'event: preview\ndata: ' + JSON.stringify(preview) + '\n\n',
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
  /** What a coding turn is doing now (a tool call, a worker's step), for the
   * live view; kept with the live preview, not stored. */
  async activity(text) {
    const job = await this.ctx.storage.get('job');
    if (!text || job?.status !== 'running') return;
    const old =
      this.live?.jobId === job.id
        ? this.live
        : { jobId: job.id, round: 0, text: '', reasoning: '' };
    this.live = {
      ...old,
      activity: text,
      updatedAt: Math.max(Date.now(), (old.updatedAt || 0) + 1),
    };
    this.broadcast(this.live);
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
