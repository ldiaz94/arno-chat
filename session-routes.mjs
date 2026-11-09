/** Durable Object routes for a conversation session ('code:<user>:<id>'): its
 * lifecycle, turns, live events, file preview and publishable changes.
 * Called with this = the ArnoProbe instance. */
import { SECURITY, json } from './http.mjs';
import { modelAllowed, contextWindow, acceptsImages } from './models.mjs';
import { attachmentsFor, saveAttachment, readAttachment } from './attachments.mjs';
import { listArtifacts } from './artifacts.mjs';
import { EXPORT_FILES, validateFiles, WORKTREE_DIFF } from './publish.mjs';
import { buildPrompt, sessionPrompt } from './context.mjs';
import { serveTurn, replyOf, transcriptOf, activityOf } from './serve.mjs';
import { READ_FILE, validPath } from './files.mjs';
import { citedSources } from './web.mjs';
import { checkOptions } from './web/options.mjs';
import { turnPlan, codeLimits } from './plan.mjs';
import { gitRemote } from './git.mjs';

/** Why a coding session's line can't go to arno, or '': the commands that
 * would undo what the host set up (its model, safety and process), or need a
 * terminal. The rest (/clear, /compact, /notes, /usage, /help, ...) go on. */
export function hostCommand(prompt) {
  const name = /^\/([a-z]+)/.exec(prompt.trim())?.[1];
  if (['model', 'models', 'provider'].includes(name))
    return 'Change the model with the model button';
  if (['budget', 'workers'].includes(name))
    return 'Set /' + name + ' in the options (sliders) button';
  if (['safety', 'quit', 'exit', 'attach', 'paste', 'stage'].includes(name))
    return '/' + name + ' is not available here';
  return '';
}
/** git log's fields for a commit, parted by unit separators. */
const LOG_FORMAT = '%H%x1f%an%x1f%at%x1f%s%x1f%D';

export const sessionRoutes = {
  /** The newest commits of the session's checkout: each with its author, time,
   * subject and refs, and whether it is only here (not yet on GitHub); and
   * how many files have uncommitted changes. */
  async 'GET /session/history'() {
    const refused = await this.wake();
    if (refused) return refused;
    const cwd = { cwd: '/workspace/repo' };
    const [log, local, status] = await Promise.all([
      this.exec(['git', 'log', '-n', '100', '--format=' + LOG_FORMAT, 'HEAD'], cwd, 20),
      this.exec(['git', 'rev-list', '-n', '100', 'HEAD', '--not', '--remotes'], cwd, 20),
      this.exec(['git', 'status', '--porcelain'], cwd, 20),
    ]);
    if (log.exitCode !== 0) return json({ error: 'Could not read the history' }, 500);
    const only = new Set(local.stdout.split('\n').filter(Boolean));
    const commits = log.stdout
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [sha, author, at, subject, refs] = line.split('\x1f');
        return { sha, author, at: Number(at) * 1000, subject, refs, local: only.has(sha) };
      });
    return json({ commits, uncommitted: status.stdout.split('\n').filter(Boolean).length });
  },
  /** One commit: its message and its patch, cut at 120 KB. Its files' contents
   * may still be on GitHub (a partial clone), so git may fetch them. */
  async 'GET /session/commit'(request, url) {
    const sha = url.searchParams.get('sha') || '';
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return json({ error: 'Invalid commit' }, 400);
    const refused = await this.wake();
    if (refused) return refused;
    const session = await this.ctx.storage.get('session');
    this.gitOpen = { repo: session.repo, ownerId: session.ownerId };
    try {
      const r = await this.exec(
        ['git', 'show', '--no-color', '--patch', '--format=%H%x1f%an%x1f%at%x1f%B%x1e', sha],
        { cwd: '/workspace/repo' },
        60,
      );
      if (r.exitCode !== 0) return json({ error: 'Could not read that commit' }, 404);
      const [head, ...rest] = r.stdout.split('\x1e'),
        [full, author, at, message] = head.split('\x1f');
      return json({
        sha: full,
        author,
        at: Number(at) * 1000,
        message: message.trim(),
        patch: rest.join('').replace(/^\n+/, '').slice(0, 120000),
      });
    } finally {
      this.gitOpen = null;
    }
  },
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
  async 'GET /session/files'(request, url) {
    const name = url.searchParams.get('path') || '';
    if (!validPath(name)) return json({ error: 'Invalid file path' }, 400);
    const refused = await this.wake();
    if (refused) return refused;
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
  /** A new coding session: the workspace's container starts, the repository
   * is cloned into it through the git gateway (git.mjs), and the first
   * checkpoint is taken. */
  async 'POST /session/init'(request) {
    const model = request.headers.get('X-Arno-Model');
    const repo = request.headers.get('X-Arno-Repo');
    const ref = request.headers.get('X-Arno-Ref');
    if (
      !(await modelAllowed(model)) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') ||
      !ref
    )
      return json({ error: 'Invalid session' }, 400);
    let github;
    try {
      github = JSON.parse(request.headers.get('X-Arno-GitHub') || 'null');
    } catch {
      github = null;
    }
    const ownerId = request.headers.get('X-Arno-Owner') || null;
    await this.start(model);
    await this.exec(
      [
        'sh',
        '-c',
        'rm -rf /workspace/repo /workspace/config /workspace/data; mkdir -p /workspace/config/arno /workspace/data',
      ],
      {},
      30,
    );
    if (github?.token) await this.keepGithub(ownerId, github);
    // The gateway serves this repository while the clone runs (gitOpen).
    this.gitOpen = { repo, ownerId };
    let clone;
    try {
      clone = await this.exec(
        [
          'git',
          'clone',
          '-q',
          '--filter=blob:none',
          '--branch',
          ref,
          gitRemote(repo),
          '/workspace/repo',
        ],
        {},
        170,
      );
    } finally {
      this.gitOpen = null;
    }
    if (clone.exitCode !== 0)
      return json({ error: 'Could not clone the repository', detail: clone.stderr }, 502);
    const head = await this.exec(['git', 'rev-parse', 'HEAD'], { cwd: '/workspace/repo' }, 10);
    const meta = {
      repo,
      ref,
      model,
      ownerId,
      remoteUrl: 'https://github.com/' + repo,
      sourceSha: head.stdout.trim() || request.headers.get('X-Arno-Sha') || null,
      createdAt: Date.now(),
    };
    await this.exec(
      [
        'sh',
        '-c',
        'git config arno.sourceCommit "$1" && git config arno.cloned true',
        'sh',
        meta.sourceSha,
      ],
      { cwd: '/workspace/repo' },
      10,
    );
    await this.gitSetup(meta);
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
      const options = (await this.ctx.storage.get('job'))?.options,
        plan = turnPlan(options),
        limits = codeLimits(options);
      await this.writeConfig(session.model, plan, options);
      await this.gitSetup(session);
      const startupMs = Date.now() - began;
      await this.phase('thinking', { workspace, startupMs });
      const previous = await this.history();
      // Attached files go into the workspace, outside the repository, and the
      // prompt names them: the prompt is a command-line argument, too small for
      // inlining.
      const attached = (await this.ctx.storage.get('job'))?.attachments || [];
      const paths = [];
      for (const meta of attached) {
        const file = await readAttachment(this.ctx.storage, meta.id),
          path = '/workspace/attachments/' + meta.id.slice(0, 8) + '-' + meta.name;
        if (!file) continue;
        await this.exec(['sh', '-c', 'mkdir -p /workspace/attachments && cat > "$1"', 'sh', path], {
          stdin: new Response(file.bytes).body,
        });
        paths.push(path);
      }
      const note = paths.length
        ? '\n\nAttached files (read them as needed):\n' + paths.join('\n')
        : '';
      // The model gateway reads the turn's options from here (/model-account).
      await this.ctx.storage.put('modelQuota', {
        used: 0,
        rounds: limits.rounds,
        turnId,
        options,
        sources: session.sources || [],
        webCounts: { searches: 0, reads: 0 },
        deadline: Date.now() + limits.timeLimit + 60000,
      });
      const refsBefore = await this.remoteRefs();
      const modelBegan = Date.now();
      const process = await this.ctx.container.exec(
        [
          'timeout',
          '--kill-after=10',
          String(limits.timeLimit / 1000 + 60),
          '/usr/local/bin/arno',
          '--serve',
        ],
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
      // arno's standard error (crashes, and what tools print) is kept short.
      let stderr = '';
      const drained = process.stderr
        ?.pipeThrough(new TextDecoderStream())
        .pipeTo(new WritableStream({ write: t => void (stderr = (stderr + t).slice(-10000)) }))
        .catch(() => {});
      const stop = new AbortController(),
        timer = setTimeout(() => stop.abort(), limits.timeLimit);
      let turn;
      try {
        turn = await serveTurn(process, {
          hello: { prompt: sessionPrompt(session) },
          conversation: session.arnoConversation,
          // A conversation arno no longer has (or a session from before it kept
          // them) starts again with the earlier turns as context.
          // A command goes as it is.
          line: loaded =>
            prompt.startsWith('/')
              ? prompt
              : loaded
                ? prompt + note
                : buildPrompt(session, previous, prompt + note),
          onEvent: e => this.activity(activityOf(e)),
          signal: stop.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const exitCode = await Promise.race([
        process.exitCode,
        new Promise(r => setTimeout(() => r(null), 15000)),
      ]);
      await drained;
      if (turn.conversation && turn.conversation !== session.arnoConversation)
        await this.ctx.storage.put('session', {
          ...(await this.ctx.storage.get('session')),
          arnoConversation: turn.conversation,
        });
      const executionMs = Date.now() - modelBegan;
      await this.phase('checkpointing', { workspace, startupMs, executionMs });
      const pushed = await this.followPush(refsBefore);
      const reply = replyOf(turn),
        failed = !reply && !turn.entries.length;
      const diffResult = await this.exec(
        ['node', '-e', WORKTREE_DIFF],
        { cwd: '/workspace/repo' },
        30,
      );
      const result = {
        exitCode: failed ? exitCode || 1 : 0,
        model: session.model,
        summary: (
          (turn.cancelled ? 'Stopped at the time limit. ' : '') +
          (reply || stderr || 'Arno ended without a reply (exit ' + exitCode + ').')
        ).slice(-12000),
        diff: diffResult.stdout.slice(-40000),
        diagnostics: (transcriptOf(turn) + (stderr ? '\n\n' + stderr : '')).slice(-40000),
        arno: turn.stats,
        pushed: pushed || undefined,
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
        lastInputTokens: q?.lastInputTokens ?? null,
      };
      result.requestLog = q?.requestLog || [];
      result.sources = citedSources(result.summary, q?.sources || [], previous);
      result.attachments = attached;
      result.webUsage = q?.webCounts || { searches: 0, reads: 0 };
      result.options = options;
      const checkpointBegan = Date.now();
      const snapshot = await this.ctx.container.snapshotContainer({});
      result.timing.checkpointMs = Date.now() - checkpointBegan;
      result.timing.totalMs = Date.now() - began;
      await this.saveTurn(result, prompt.trim(), snapshot, q?.sources || []);
      return json(result);
    } finally {
      this.inFlight = false;
      await this.ctx.storage.delete(['modelQuota', 'thinking']);
      await this.ctx.storage.setAlarm(Date.now() + 35 * 60 * 1000);
    }
  },
};
