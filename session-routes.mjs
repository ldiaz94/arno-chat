/** Durable Object routes for a conversation session ('code:<user>:<id>'): its
 * lifecycle, turns, live events, file preview and publishable changes.
 * Called with this = the ArnoProbe instance. */
import { json } from './http.mjs';
import { modelAllowed } from './models.mjs';
import { EXPORT_FILES, validateFiles, WORKTREE_DIFF } from './publish.mjs';
import { buildPrompt } from './context.mjs';
import { READ_FILE, validPath } from './files.mjs';
import { citedSources } from './web.mjs';

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
  async 'POST /session/delete'() {
    const job = await this.ctx.storage.get('job');
    if (this.inFlight || (job && ['queued', 'running'].includes(job.status)))
      return json({ error: 'Stop the active task before deleting this conversation' }, 409);
    if (this.ctx.container?.running) await this.ctx.container.destroy();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return json({ deleted: true });
  },
  async 'POST /session/owner'(request) {
    const { ownerId } = await request.json(),
      session = await this.ctx.storage.get('session');
    if (!session) return json({ error: 'Session not found' }, 404);
    await this.ctx.storage.put('session', { ...session, ownerId });
    return new Response(null, { status: 204 });
  },
  async 'GET /session/files'(request, url) {
    const name = url.searchParams.get('path') || '';
    if (!validPath(name)) return json({ error: 'Invalid file path' }, 400);
    const session = await this.ctx.storage.get('session');
    if (!session || session.kind === 'chat')
      return json({ error: 'Open a repository to browse code' }, 400);
    if (!this.ctx.container.running) {
      const job = await this.ctx.storage.get('job');
      if (job && ['queued', 'running'].includes(job.status))
        return json({ error: 'Workspace is starting. Try again shortly.' }, 409);
      await this.start(session.model);
    }
    const p = await this.ctx.container.exec(['node', '-e', READ_FILE, name], {
      cwd: '/workspace/repo',
    });
    const result = await p.output();
    if (result.exitCode !== 0)
      return json(
        {
          error:
            'Cannot preview this path. Preview supports regular UTF-8 files up to 200 KB and no symlinks.',
        },
        400,
      );
    if (result.stdout.byteLength > 1500000) return json({ error: 'Preview too large' }, 413);
    return json(JSON.parse(new TextDecoder().decode(result.stdout)));
  },
  async 'POST /session/chat-init'(request) {
    const { model, ownerId, id } = await request.json();
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
  async 'GET /session/changes'() {
    const job = await this.ctx.storage.get('job');
    if (this.inFlight || (job && ['queued', 'running'].includes(job.status)))
      return json({ error: 'Wait for the task to finish before publishing' }, 409);
    const session = await this.ctx.storage.get('session');
    if (!session) return json({ error: 'Session not found' }, 404);
    if (!session.sourceSha)
      return json(
        {
          error:
            'This older session has no pinned source commit. Open a new session before publishing.',
        },
        409,
      );
    this.inFlight = true;
    try {
      await this.start(session.model);
      const p = await this.ctx.container.exec(['node', '-e', EXPORT_FILES], {
        cwd: '/workspace/repo',
      });
      const output = await p.output();
      if (output.exitCode !== 0)
        return json(
          {
            error: 'Unable to export changes. Only regular text files up to 1 MB are supported.',
          },
          400,
        );
      if (output.stdout.byteLength > 2000000) return json({ error: 'Changes too large' }, 413);
      const { files } = JSON.parse(new TextDecoder().decode(output.stdout));
      return json({
        files: validateFiles(files),
        repo: session.repo,
        ref: session.ref,
        sourceSha: session.sourceSha,
      });
    } finally {
      this.inFlight = false;
    }
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
    return this.ctx.storage.transaction(async txn => {
      const current = await txn.get('job');
      if (current?.id === body.id) return json(current, 202);
      if (current && ['queued', 'running'].includes(current.status))
        return json({ error: 'A turn is already running' }, 409);
      const session = await txn.get('session');
      if (!session) return json({ error: 'Session not found' }, 404);
      if (body.editAt && session.kind !== 'chat')
        return json({ error: 'Only chat messages can be edited' }, 400);
      const job = {
        id: body.id,
        prompt: body.prompt,
        editAt: body.editAt || null,
        replaces: body.replaces || null,
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
    });
  },
  async 'POST /session/init'(request) {
    const model = request.headers.get('X-Arno-Model');
    const repo = request.headers.get('X-Arno-Repo');
    const ref = request.headers.get('X-Arno-Ref');
    if (!(await modelAllowed(model)) || !repo || !ref || !request.body)
      return json({ error: 'Invalid session' }, 400);
    await this.start(model);
    await this.exec(
      [
        'sh',
        '-c',
        'rm -rf /workspace/repo /workspace/config /workspace/data; mkdir -p /workspace/repo /workspace/config/arno /workspace/data',
      ],
      {},
      30,
    );
    const unpack = await this.exec(
      ['tar', '-xz', '--strip-components=1', '-C', '/workspace/repo'],
      { stdin: request.body },
      120,
    );
    if (unpack.exitCode !== 0)
      return json({ error: 'Could not unpack repository', detail: unpack.stderr }, 400);
    const config = `provider = ollama-cloud\nmodel = ${model}\nurl = http://model.internal/v1\nkey =\nexecution_boundary = outer-sandbox\nsafety = auto\ncontext_files = no\nproject_map = no\nmax_tokens = 4096\n`;
    const write = await this.ctx.container.exec(['tee', '/workspace/config/arno/config'], {
      stdin: 'pipe',
      stdout: 'ignore',
    });
    const writer = write.stdin.getWriter();
    await writer.write(new TextEncoder().encode(config));
    await writer.close();
    await write.exitCode;
    const baseline = await this.exec(
      [
        'sh',
        '-c',
        "git init -q && git add -A && git -c user.name='Arno Remote' -c user.email='arno@localhost' commit -qm baseline",
      ],
      { cwd: '/workspace/repo' },
      120,
    );
    if (baseline.exitCode !== 0)
      return json({ error: 'Could not prepare git workspace', detail: baseline.stderr }, 500);
    await this.exec(['git', 'branch', '-M', ref], { cwd: '/workspace/repo' }, 10);
    const meta = {
      repo,
      ref,
      model,
      ownerId: request.headers.get('X-Arno-Owner') || null,
      remoteUrl: 'https://github.com/' + repo,
      sourceSha: request.headers.get('X-Arno-Sha') || null,
      createdAt: Date.now(),
    };
    if (meta.sourceSha)
      await this.exec(
        ['git', 'config', 'arno.sourceCommit', meta.sourceSha],
        { cwd: '/workspace/repo' },
        10,
      );
    await this.repoContext(meta);
    const snapshot = await this.ctx.container.snapshotContainer({});
    await this.ctx.storage.put({ session: meta, snapshot });
    return json(meta);
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
    this.inFlight = true;
    try {
      const began = Date.now(),
        turnId = crypto.randomUUID();
      await this.phase(this.ctx.container.running ? 'preparing' : 'restoring');
      const workspace = await this.start(session.model);
      if ((await this.ctx.storage.get('job'))?.status === 'cancelled')
        throw Error('Task cancelled');
      await this.writeConfig(session.model);
      await this.repoContext(session);
      const startupMs = Date.now() - began;
      await this.phase('thinking', { workspace, startupMs });
      const previous = await this.history();
      const taskPrompt = buildPrompt(session, previous, prompt);
      await this.ctx.storage.put('modelQuota', {
        used: 0,
        turnId,
        sources: session.sources || [],
        webCounts: { searches: 0, reads: 0 },
        deadline: Date.now() + 4 * 60 * 1000,
      });
      const modelBegan = Date.now();
      const process = await this.ctx.container.exec(
        ['timeout', '--kill-after=5', '240', '/usr/local/bin/arno', taskPrompt],
        {
          cwd: '/workspace/repo',
          env: {
            XDG_CONFIG_HOME: '/workspace/config',
            XDG_DATA_HOME: '/workspace/data',
            PYTHONDONTWRITEBYTECODE: '1',
          },
          stdin: 'pipe',
        },
      );
      const writer = process.stdin.getWriter();
      await writer.write(new TextEncoder().encode('y\ny\ny\n'));
      await writer.close();
      const output = await process.output();
      const executionMs = Date.now() - modelBegan;
      await this.phase('checkpointing', { workspace, startupMs, executionMs });
      const decode = bytes => new TextDecoder().decode(bytes);
      const stdout = decode(output.stdout).slice(-40000);
      const stderr = decode(output.stderr).slice(-10000);
      const diffResult = await this.exec(
        ['node', '-e', WORKTREE_DIFF],
        { cwd: '/workspace/repo' },
        30,
      );
      const result = {
        exitCode: output.exitCode,
        model: session.model,
        summary: (stdout || stderr || `Arno exited with code ${output.exitCode}`).slice(-12000),
        diff: diffResult.stdout.slice(-40000),
        diagnostics: stderr,
        reasoning:
          this.live?.jobId === (await this.ctx.storage.get('job'))?.id
            ? this.live?.reasoning || ''
            : '',
        timing: { startupMs, executionMs, workspace },
      };
      const q = await this.ctx.storage.get('modelQuota');
      result.usage = {
        calls: q?.used || 0,
        measuredCalls: q?.measuredCalls || 0,
        inputTokens: q?.measuredCalls ? q.inputTokens : null,
        outputTokens: q?.measuredCalls ? q.outputTokens : null,
        cachedTokens: q?.cachedTokens || 0,
        cacheWriteTokens: q?.cacheWriteTokens || 0,
      };
      result.sources = citedSources(result.summary, q?.sources || [], previous);
      result.webUsage = q?.webCounts || { searches: 0, reads: 0 };
      const checkpointBegan = Date.now();
      const snapshot = await this.ctx.container.snapshotContainer({});
      result.timing.checkpointMs = Date.now() - checkpointBegan;
      result.timing.totalMs = Date.now() - began;
      await this.saveTurn(result, prompt.trim(), snapshot, q?.sources || []);
      return json(result);
    } finally {
      this.inFlight = false;
      await this.ctx.storage.delete('modelQuota');
      await this.ctx.storage.setAlarm(Date.now() + 35 * 60 * 1000);
    }
  },
};
