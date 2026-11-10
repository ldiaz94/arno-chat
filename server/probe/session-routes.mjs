/** Durable Object routes for a conversation session ('code:<user>:<id>'): its
 * lifecycle, turns, live events, file preview and publishable changes.
 * Called with this = the ArnoProbe instance. */
import { SECURITY, json } from '../http.mjs';
import { hostCommand } from '../code/code-routes.mjs';
import { modelAllowed, contextWindow, acceptsImages } from '../models.mjs';
import { attachmentsFor, saveAttachment, readAttachment } from './attachments.mjs';
import { listArtifacts } from './artifacts.mjs';
import { checkOptions } from '../../web/options.mjs';

export const sessionRoutes = {
  async 'POST /session/rename'(request) {
    const { title } = await request.json();
    if (typeof title !== 'string' || !title.trim() || title.length > 100)
      return json({ error: 'Conversation names must be 1–100 characters' }, 400);
    const meta = await this.ctx.storage.get('session');
    if (!meta) return json({ error: 'Conversation not found' }, 404);
    const renamed = { ...meta, title: title.trim(), customTitle: true };
    await this.ctx.storage.put('session', renamed);
    return json(renamed);
  },
  /** Account deletion: stop whatever is running and delete everything this
   * session holds (transcript, attachments, artifacts, workspace snapshot
   * reference), even mid-turn. */
  async 'POST /session/wipe'() {
    this.chatAbort?.abort();
    if (this.ctx.container?.running) await this.ctx.container.destroy();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return json({ deleted: true });
  },
  async 'POST /session/delete'() {
    const job = await this.ctx.storage.get('job');
    if (this.inFlight || (job && ['queued', 'running'].includes(job.status)))
      return json({ error: 'Stop the active task before deleting this conversation' }, 409);
    if (this.ctx.container?.running) await this.ctx.container.destroy();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return json({ deleted: true });
  },
  /** Each message's request names the owner and brings their GitHub sign-in:
   * the token is kept sealed for the git gateway, so the session can fetch and
   * push for as long as the sign-in lasts. */
  async 'POST /session/owner'(request) {
    const { ownerId, id, github } = await request.json(),
      session = await this.ctx.storage.get('session');
    if (!session) return json({ error: 'Session not found' }, 404);
    await this.ctx.storage.put('session', { ...session, ownerId, id: session.id || id });
    if (github?.token && session.kind !== 'chat') await this.keepGithub(ownerId, github);
    return new Response(null, { status: 204 });
  },
  async 'POST /session/chat-init'(request) {
    const { model, ownerId, id } = await request.json();
    const existing = await this.ctx.storage.get('session');
    if (existing)
      return existing.ownerId === ownerId ? json(existing) : json({ error: 'Conflict' }, 409);
    if (!(await modelAllowed(model))) return json({ error: 'Unsupported model' }, 400);
    const meta = {
      id,
      ownerId,
      kind: 'chat',
      title: 'General chat',
      repo: 'General chat',
      model,
      createdAt: Date.now(),
    };
    await this.ctx.storage.put('session', meta);
    return json(meta);
  },
  /** The owner's answer to an MCP action a chat asked to make (approve). */
  async 'POST /session/approve'(request) {
    const { id, allow } = await request.json().catch(() => ({}));
    return this.ctx.storage.transaction(async txn => {
      const job = await txn.get('job');
      if (job?.status !== 'running' || job.approval?.id !== id || typeof allow !== 'boolean')
        return json({ error: 'Nothing is waiting for an answer' }, 409);
      await txn.put('job', { ...job, approval: { ...job.approval, allow } });
      return json({ ok: true });
    });
  },
  async 'POST /session/cancel'() {
    const job = await this.ctx.storage.get('job');
    if (!job || !['queued', 'running'].includes(job.status))
      return json({ error: 'No active task' }, 409);
    if (['checkpointing', 'saving'].includes(job.stage))
      return json({ error: 'This response is being saved. Please wait for it to finish.' }, 409);
    await this.ctx.storage.put('job', { ...job, status: 'cancelled', finishedAt: Date.now() });
    await this.recordFailure(job, 'Stopped before it finished.');
    this.chatAbort?.abort();
    await this.ctx.storage.delete('modelQuota');
    if (this.ctx.container?.running) await this.ctx.container.destroy();
    return json({ status: 'cancelled' });
  },
  async 'POST /session/suspend'() {
    const job = await this.ctx.storage.get('job');
    if (this.inFlight || (job && ['queued', 'running'].includes(job.status)))
      return json({ error: 'Task is running' }, 409);
    if (this.ctx.container?.running) await this.ctx.container.destroy();
    await this.ctx.storage.deleteAlarm();
    return json({ stopped: true });
  },
  async 'GET /session/job'() {
    const job = await this.ctx.storage.get('job');
    const live = this.live || (await this.ctx.storage.get('live'));
    return json(
      job ? { ...job, preview: live?.jobId === job.id ? live : undefined } : { status: 'idle' },
    );
  },
  async 'GET /session/events'() {
    return this.events();
  },
  async 'POST /attachments'(request) {
    try {
      const meta = await saveAttachment(
        this.ctx.storage,
        decodeURIComponent(request.headers.get('X-Filename') || 'file'),
        (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase(),
        new Uint8Array(await request.arrayBuffer()),
      );
      return json(meta, 201);
    } catch (e) {
      return json({ error: e.message }, 400);
    }
  },
  /** An attachment's bytes, as an inert download for text and inline for images. */
  async 'GET /attachments/get'(request, url) {
    const file = await readAttachment(this.ctx.storage, url.searchParams.get('id') || '');
    if (!file) return json({ error: 'Attachment not found' }, 404);
    return new Response(file.bytes, {
      headers: {
        ...SECURITY,
        'Content-Type': file.meta.kind === 'image' ? file.meta.type : 'text/plain; charset=utf-8',
        'Content-Disposition':
          (file.meta.kind === 'image' ? 'inline' : 'attachment') +
          "; filename*=UTF-8''" +
          encodeURIComponent(file.meta.name),
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, max-age=86400',
      },
    });
  },
  async 'GET /artifacts'() {
    return json({ artifacts: await listArtifacts(this.ctx.storage) });
  },
  async 'GET /artifacts/get'(request, url) {
    const artifact = await this.ctx.storage.get('artifact:' + (url.searchParams.get('id') || ''));
    return artifact ? json(artifact) : json({ error: 'Artifact not found' }, 404);
  },
  async 'POST /session/enqueue'(request) {
    const body = await request.json();
    if (
      typeof body.prompt !== 'string' ||
      !body.prompt.trim() ||
      body.prompt.length > 8000 ||
      !/^[-a-f0-9]{36}$/.test(body.id || '') ||
      (body.editAt != null && !Number.isSafeInteger(body.editAt)) ||
      (body.replaces != null && !Number.isSafeInteger(body.replaces))
    )
      return json({ error: 'Invalid message' }, 400);
    let attachments;
    try {
      attachments = await attachmentsFor(this.ctx.storage, body.attachments);
    } catch (e) {
      return json({ error: e.message }, 400);
    }
    if (attachments.some(a => a.kind === 'image')) {
      const meta = await this.ctx.storage.get('session');
      if (meta?.kind !== 'chat')
        return json(
          { error: 'Images work in regular chats; coding sessions take text files' },
          400,
        );
      if (!(await acceptsImages(meta.model)))
        return json({ error: 'This model does not accept images. Choose a vision model.' }, 400);
    }
    return this.ctx.storage.transaction(async txn => {
      const current = await txn.get('job');
      if (current?.id === body.id) return json(current, 202);
      if (current && ['queued', 'running'].includes(current.status))
        return json({ error: 'A turn is already running' }, 409);
      const session = await txn.get('session');
      if (!session) return json({ error: 'Session not found' }, 404);
      if (body.editAt && session.kind !== 'chat')
        return json({ error: 'Only chat messages can be edited' }, 400);
      const refused = session.kind !== 'chat' && hostCommand(body.prompt);
      if (refused) return json({ error: refused }, 400);
      const options = checkOptions(body.options, session.kind);
      if (!options) return json({ error: 'Invalid message options' }, 400);
      const job = {
        id: body.id,
        prompt: body.prompt,
        options,
        editAt: body.editAt || null,
        replaces: body.replaces || null,
        attachments,
        status: 'queued',
        createdAt: Date.now(),
      };
      await txn.put('job', job);
      await txn.setAlarm(Date.now() + 100);
      return json(job, 202);
    });
  },
  async 'POST /session/model'(request) {
    const job = await this.ctx.storage.get('job');
    if (job && ['queued', 'running'].includes(job.status))
      return json({ error: 'Wait for the current turn to finish' }, 409);
    if (this.inFlight) return json({ error: 'Wait for the current turn to finish' }, 409);
    this.inFlight = true;
    try {
      const session = await this.ctx.storage.get('session');
      if (!session) return json({ error: 'Session not found' }, 404);
      const { model } = await request.json();
      if (!(await modelAllowed(model))) return json({ error: 'Unsupported model' }, 400);
      await this.ctx.storage.put('session', { ...session, model });
      return json({ model });
    } finally {
      this.inFlight = false;
    }
  },
  async '* /session/get'() {
    const meta = await this.ctx.storage.get('session');
    if (!meta) return json({ error: 'Session not found' }, 404);
    return json({
      ...meta,
      remoteUrl: meta.remoteUrl || 'https://github.com/' + meta.repo,
      workspaceState: this.ctx.container?.running ? 'warm' : 'sleeping',
      stats: (await this.ctx.storage.get('stats')) || null,
      history: await this.history(true),
      contextWindow: await contextWindow(meta.model),
    });
  },
  async 'POST /session/run'(request) {
    if (this.inFlight) return json({ error: 'Arno is already working' }, 409);
    const session = await this.ctx.storage.get('session');
    if (!session) return json({ error: 'Session not found' }, 404);
    const { prompt, editAt } = await request.json();
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000)
      return json({ error: 'Invalid prompt' }, 400);
    if (this.inFlight) return json({ error: 'Arno is already working' }, 409);
    if (session.kind === 'chat') return this.plainTurn(session, prompt.trim(), editAt);
    return this.codeTurn(session, prompt.trim());
  },
};
