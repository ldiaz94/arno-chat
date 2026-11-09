/** ArnoProbe, the one Durable Object class. Its name picks its role: a session
 * ('code:<user>:<id>'), a user's index and profile ('index:<user>') or a sign-in
 * record ('auth:<id>'). Requests dispatch by "METHOD /path" (or "* /path" for any
 * method) to the role route tables; turns run from alarm(). */
import { DurableObject } from 'cloudflare:workers';
import { SECURITY, json } from './http.mjs';
import { plainChat } from './chat.mjs';
import { modelInput } from './attachments.mjs';
import { profile, credential, instructions, providerModel, searchConnection } from './account.mjs';
import { WEB_INSTRUCTIONS, WEB_TOOLS, research, citedSources } from './web.mjs';
import { ARTIFACT_INSTRUCTIONS, ARTIFACT_TOOLS, artifactTool } from './artifacts.mjs';
import { prices, priceOf, cost, costParts, webRates, WEB_RATES } from './prices.mjs';
import { storeRoutes } from './store-routes.mjs';
import { gatewayRoutes } from './gateway-routes.mjs';
import { sessionRoutes } from './session-routes.mjs';
import { pushRoutes, notifyOwner, turnNotice } from './push.mjs';

const ROUTES = { ...storeRoutes, ...pushRoutes, ...gatewayRoutes, ...sessionRoutes };

export class ArnoProbe extends DurableObject {
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
  }
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
  }
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
  }
  /** Shared persistent transcript/statistics path for plain and coding turns. */
  async saveTurn(result, prompt, snapshot, sourceRegistry, editAt) {
    await this.dropReplaced(await this.ctx.storage.get('job'));
    if (editAt) {
      const turns = await this.ctx.storage.list({ prefix: 'turn:' });
      await this.ctx.storage.delete([...turns].filter(([, t]) => t.at >= editAt).map(([k]) => k));
    }
    // Keep individual KV values bounded even with multi-byte code/log output.
    const clip = (s, n) => new TextDecoder().decode(new TextEncoder().encode(s || '').slice(0, n));
    result.summary = clip(result.summary, 16000);
    result.reasoning = clip(result.reasoning, 12000);
    result.diff = clip(result.diff, 40000);
    result.diagnostics = clip(result.diagnostics, 8000);
    if (new TextEncoder().encode(JSON.stringify({ prompt, ...result })).byteLength > 115000) {
      result.sources = (result.sources || []).map(s => ({
        ...s,
        excerpt: s.excerpt?.slice(0, 80),
      }));
      result.diff = clip(result.diff, 24000);
      result.diagnostics = clip(result.diagnostics, 4000);
      result.reasoning = clip(result.reasoning, 4000);
      result.truncated = true;
    }
    const stats = (await this.ctx.storage.get('stats')) || {
      turns: 0,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      measuredCalls: 0,
      totalMs: 0,
    };
    result.model ||= (await this.ctx.storage.get('session'))?.model;
    // Cost: the model's tokens at list price (null when unpriced) plus searches;
    // the parts are kept per turn and summed per session for the breakdown.
    const price = priceOf(await prices(), result.model),
      modelCost = cost(price, result.usage),
      session = await this.ctx.storage.get('session'),
      webKey =
        result.webUsage?.searches || result.webUsage?.reads
          ? await credential(
              this.env,
              session?.ownerId,
              await profile(this.env, session?.ownerId),
              'ollama',
            )
          : null,
      rates = webKey ? await webRates(webKey) : WEB_RATES,
      parts = costParts(price, result.usage, result.webUsage, rates),
      web = parts.search + parts.reads;
    result.usage.costParts = parts;
    result.usage.cost = modelCost == null && !web ? null : (modelCost || 0) + web;
    stats.cost = (stats.cost || 0) + (result.usage.cost || 0);
    stats.costParts = Object.fromEntries(
      Object.entries(parts).map(([k, v]) => [k, (stats.costParts?.[k] || 0) + (v || 0)]),
    );
    stats.unpriced =
      (stats.unpriced || 0) + Number(modelCost == null && !!result.usage.measuredCalls);
    await this.logRequests(session, result, price, rates);
    delete result.requestLog;
    stats.turns++;
    stats.calls += result.usage.calls;
    stats.measuredCalls += result.usage.measuredCalls;
    stats.inputTokens += result.usage.inputTokens || 0;
    stats.outputTokens += result.usage.outputTokens || 0;
    stats.totalMs += result.timing.totalMs;
    const records = { stats },
      legacy = await this.ctx.storage.get('history');
    stats.webSearches = (stats.webSearches || 0) + (result.webUsage?.searches || 0);
    stats.webReads = (stats.webReads || 0) + (result.webUsage?.reads || 0);
    if (sourceRegistry) {
      const meta = await this.ctx.storage.get('session');
      records.session = { ...meta, sources: sourceRegistry };
    }
    if (snapshot) records.snapshot = snapshot;
    if (legacy)
      for (let i = 0; i < legacy.length; i++)
        records['turn:' + String(legacy[i].at || i).padStart(16, '0') + ':legacy' + i] = legacy[i];
    records['turn:' + String(Date.now()).padStart(16, '0') + ':' + crypto.randomUUID()] = {
      prompt,
      ...result,
      at: Date.now(),
    };
    await this.ctx.storage.put(records);
    if (legacy) await this.ctx.storage.delete('history');
    await this.trimTurns();
  }
  /** Add this turn's requests (each model call, search and page read) to the
   * owner's request log in their index object; best effort, never fails a turn. */
  async logRequests(session, result, price, rates) {
    if (!session?.ownerId) return;
    const base = {
        sessionId: session.id || null,
        title: session.title || session.repo || '',
        model: result.model,
      },
      at = Date.now(),
      web = result.webUsage || {};
    const callCost = r => {
      if (!price) return null;
      const p = costParts(price, {
        measuredCalls: 1,
        inputTokens: r.input + r.cached + r.write,
        cachedTokens: r.cached,
        cacheWriteTokens: r.write,
        outputTokens: r.output,
      });
      return p.input + p.cached + p.cacheWrite + p.output;
    };
    const tool = (n, kind, model, cost) =>
      Array.from({ length: n || 0 }, () => ({
        ...base,
        at,
        kind,
        model,
        input: null,
        cached: null,
        output: null,
        cost,
      }));
    const requests = [
      ...(result.requestLog || []).map(r => ({
        ...base,
        at: r.at,
        kind: 'model',
        input: r.input + r.cached + r.write,
        cached: r.cached,
        output: r.output,
        cost: callCost(r),
      })),
      ...tool(web.searches, 'search', 'web_search', rates.search),
      ...tool(web.searxng, 'search', 'searxng', 0),
      ...tool(web.reads, 'read', 'web_fetch', rates.fetch),
    ];
    if (!requests.length) return;
    try {
      await this.env.PROBE.getByName('index:' + session.ownerId).fetch(
        'https://internal/usage/log',
        { method: 'POST', body: JSON.stringify({ requests }) },
      );
    } catch (e) {
      console.error(JSON.stringify({ event: 'usage_log_failed', error: String(e) }));
    }
  }
  /** Keep a failed or stopped turn in the transcript so it survives a reload
   * and can be retried. It never enters model context (see history). */
  async recordFailure(job, error) {
    await this.dropReplaced(job);
    const at = Date.now();
    await this.ctx.storage.put('turn:' + String(at).padStart(16, '0') + ':' + crypto.randomUUID(), {
      prompt: job.prompt,
      attachments: job.attachments || [],
      failed: true,
      error,
      at,
    });
    await this.trimTurns();
  }
  /** A retry names the failed turn it replaces (job.replaces, that turn's at);
   * the failed record goes once the retry's own outcome is saved. */
  async dropReplaced(job) {
    if (!job?.replaces) return;
    const turns = await this.ctx.storage.list({ prefix: 'turn:' });
    const keys = [...turns].filter(([, t]) => t.failed && t.at === job.replaces).map(([k]) => k);
    if (keys.length) await this.ctx.storage.delete(keys);
  }
  /** Retain the 20 most recent turns. */
  async trimTurns() {
    const all = await this.ctx.storage.list({ prefix: 'turn:' });
    if (all.size > 20) await this.ctx.storage.delete([...all.keys()].slice(0, all.size - 20));
  }
  /** editAt names the turn an edited message replaces: it and every later
   * turn are left out of the context, and dropped once the new answer saves. */
  async plainTurn(session, prompt, editAt) {
    this.inFlight = true;
    this.chatAbort = new AbortController();
    const timer = setTimeout(() => this.chatAbort?.abort(), 240000),
      began = Date.now();
    try {
      await this.phase('thinking', { workspace: 'chat', startupMs: 0 });
      const p = await profile(this.env, session.ownerId),
        selected = providerModel(session.model);
      const sources = [...(session.sources || [])],
        counts = { searches: 0, searxng: 0, reads: 0 },
        webKey = await credential(this.env, session.ownerId, p, 'ollama'),
        search = await searchConnection(this.env, session.ownerId, p);
      const previous = (await this.history()).filter(t => !editAt || t.at < editAt);
      const job = await this.ctx.storage.get('job'),
        jobId = job?.id,
        attached = job?.attachments || [],
        input = await modelInput(this.ctx.storage, prompt, attached),
        artifacts = [];
      const result = await plainChat({
        model: selected.id,
        provider: selected.provider,
        history: previous,
        prompt: input.text,
        images: input.images,
        toolSpecs: [...WEB_TOOLS, ...ARTIFACT_TOOLS],
        key: await credential(this.env, session.ownerId, p, selected.provider),
        instructions: [instructions(p), WEB_INSTRUCTIONS, ARTIFACT_INSTRUCTIONS]
          .filter(Boolean)
          .join('\n\n'),
        signal: this.chatAbort.signal,
        onRound: () => this.phase('thinking', { workspace: 'chat', startupMs: 0 }),
        onProgress: preview => this.progress({ ...preview, jobId }),
        runTool: async (name, args) => {
          if (/_artifact$/.test(name)) return artifactTool(this.ctx.storage, name, args, artifacts);
          await this.phase(name === 'web_search' ? 'searching' : 'reading', { workspace: 'chat' });
          const data = await research(name, args, { key: webKey, search, sources, counts });
          await this.phase('thinking', {
            workspace: 'chat',
            webCounts: { ...counts },
            sourceCount: sources.length,
          });
          return data;
        },
      });
      result.model = session.model;
      result.attachments = attached;
      result.artifacts = artifacts;
      result.sources = citedSources(result.summary, sources, previous);
      result.webUsage = counts;
      if ((await this.ctx.storage.get('job'))?.status === 'cancelled')
        throw Error('Chat cancelled');
      result.timing = {
        workspace: 'chat',
        startupMs: 0,
        executionMs: Date.now() - began,
        checkpointMs: 0,
        totalMs: Date.now() - began,
      };
      await this.phase('saving', { workspace: 'chat' });
      if ((await this.ctx.storage.get('job'))?.status === 'cancelled')
        throw Error('Chat cancelled');
      await this.saveTurn(result, prompt, null, sources, editAt);
      const current = await this.ctx.storage.get('session');
      if (
        current.title === 'General chat' &&
        !current.customTitle &&
        session.ownerId &&
        session.id
      ) {
        const meta = { ...current, title: prompt.slice(0, 70) };
        await this.ctx.storage.put('session', meta);
        await this.env.PROBE.getByName('index:' + session.ownerId).fetch(
          'https://internal/index/add',
          { method: 'POST', body: JSON.stringify(meta) },
        );
      }
      return json(result);
    } finally {
      clearTimeout(timer);
      this.chatAbort = null;
      this.inFlight = false;
    }
  }
  /** Read bounded recent turns; old sessions migrate lazily after a successful
   * checkpoint, so a failed model run never discards their prior transcript. */
  async history(withFailures = false) {
    const rows = await this.ctx.storage.list({ prefix: 'turn:', reverse: true, limit: 20 });
    const turns = rows.size
      ? [...rows.values()].reverse()
      : (await this.ctx.storage.get('history')) || [];
    return withFailures ? turns : turns.filter(t => !t.failed);
  }
  /** Persist phase updates for mobile polling; never revive a cancelled job. */
  async phase(stage, extra = {}) {
    const job = await this.ctx.storage.get('job');
    if (job?.status === 'running') await this.ctx.storage.put('job', { ...job, stage, ...extra });
  }
  /** Repair archive-based legacy sessions without adding account credentials.
   * Provenance comes from host session metadata, not from repository text. */
  async repoContext(session) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(session.repo)) return;
    const remote = 'https://github.com/' + session.repo + '.git';
    const existing = await this.exec(
      ['git', 'remote', 'get-url', 'origin'],
      { cwd: '/workspace/repo' },
      10,
    );
    if (existing.exitCode !== 0)
      await this.exec(['git', 'remote', 'add', 'origin', remote], { cwd: '/workspace/repo' }, 10);
  }
  async writeConfig(model) {
    const selected = providerModel(model),
      session = await this.ctx.storage.get('session'),
      preferences = await profile(this.env, session?.ownerId);
    let config =
      'provider = ' +
      // Arno speaks OpenAI's protocol to every other provider; the gateway
      // behind model.internal picks the real upstream and its quirks.
      ({ ollama: 'ollama-cloud', anthropic: 'claude', gemini: 'gemini' }[selected.provider] ||
        'openai') +
      '\nmodel = ' +
      selected.id +
      '\nurl = http://model.internal/v1\nkey =\nexecution_boundary = outer-sandbox\nsafety = auto\ncontext_files = no\nproject_map = no\nmax_tokens = 4096\n';
    config += 'mcp = web http://mcp.internal/web\ntrust = web_web_search web_web_read\n';
    for (const c of preferences.mcp || [])
      if (c.enabled && c.id !== 'web')
        config += 'mcp = ' + c.id + ' http://mcp.internal/' + c.id + '\n';
    const p = await this.ctx.container.exec(['tee', '/workspace/config/arno/config'], {
      stdin: 'pipe',
      stdout: 'ignore',
    });
    const writer = p.stdin.getWriter();
    await writer.write(new TextEncoder().encode(config));
    await writer.close();
    if ((await p.exitCode) !== 0) throw Error('Could not update model config');
  }
  async exec(argv, options = {}, seconds = 180) {
    const process = await this.ctx.container.exec(
      ['timeout', '--kill-after=5', String(seconds), ...argv],
      options,
    );
    const output = await process.output();
    const decode = bytes => new TextDecoder().decode(bytes);
    return {
      exitCode: output.exitCode,
      stdout: decode(output.stdout).slice(-50000),
      stderr: decode(output.stderr).slice(-12000),
    };
  }
  /** Reuse a live VM. Restore only when it has stopped; callers can report this
   * mode independently of the model's own latency. No repository is reimported. */
  async start(model) {
    const container = this.ctx.container;
    let mode = 'warm';
    if (!container.running) {
      const snapshot = await this.ctx.storage.get('snapshot');
      mode = snapshot ? 'restored' : 'new';
      container.start({
        ...(snapshot ? { containerSnapshot: snapshot } : { image: container.images.runner }),
        entrypoint: ['sleep', 'infinity'],
        enableInternet: false,
        instance: 'standard-1',
      });
    }
    await container.interceptOutboundHttp(
      'model.internal',
      this.ctx.exports.ModelGateway({ props: { task: this.ctx.id.toString(), model } }),
    );
    await container.interceptOutboundHttp(
      'mcp.internal',
      this.ctx.exports.McpGateway({ props: { task: this.ctx.id.toString() } }),
    );
    await container.setInactivityTimeout(30 * 60 * 1000);
    await this.ctx.storage.setAlarm(Date.now() + 35 * 60 * 1000);
    return mode;
  }
  /** Tell the owner's devices that a turn has ended. Never fails the turn;
   * each push request is bounded to 5 s. */
  async notify(result) {
    try {
      const session = await this.ctx.storage.get('session');
      if (!this.env.VAPID_KEY || !session?.ownerId) return;
      // Someone is watching this session's live stream: no push needed. Decided
      // here, not in the service worker, because a push that shows nothing can
      // get the subscription revoked (Safari) or a generic notice (Chrome).
      if (this.viewers?.size) return;
      const id = session.id || this.ctx.id.name?.split(':')[2];
      await notifyOwner(this.env, session.ownerId, turnNotice(session, id, result));
    } catch (e) {
      console.error(JSON.stringify({ event: 'push_failed', error: String(e) }));
    }
  }
  /** Stamps the session and its entry in the owner's list with the time of its
   * last turn, so an offline copy on another device knows it is stale. */
  async touch() {
    try {
      const session = await this.ctx.storage.get('session');
      if (!session?.ownerId || !session.id) return;
      const meta = { ...session, updatedAt: Date.now() };
      await this.ctx.storage.put('session', meta);
      await this.env.PROBE.getByName('index:' + session.ownerId).fetch(
        'https://internal/index/add',
        { method: 'POST', body: JSON.stringify(meta) },
      );
    } catch (e) {
      console.error(JSON.stringify({ event: 'touch_failed', error: String(e) }));
    }
  }
  async fetch(request) {
    const url = new URL(request.url);
    const route = ROUTES[request.method + ' ' + url.pathname] ?? ROUTES['* ' + url.pathname];
    return route ? route.call(this, request, url) : new Response('Not found', { status: 404 });
  }
  /** Alarms own the long-running turn, not the submitting browser request.
   * Mark running before execution; an interrupted alarm must not silently replay
   * commands with side effects. Cancelled jobs remain cancelled on every path. */
  async alarm() {
    const job = await this.ctx.storage.get('job');
    if (job?.status === 'queued') {
      await this.ctx.storage.put('job', { ...job, status: 'running' });
      try {
        const r = await this.fetch(
          new Request('https://internal/session/run', {
            method: 'POST',
            body: JSON.stringify({ prompt: job.prompt, editAt: job.editAt }),
          }),
        );
        const result = await r.json();
        const ok = r.ok && (!result.exitCode || result.exitCode === 0);
        if (!ok && !result.error) result.error = result.summary || 'The coding task failed.';
        const current = await this.ctx.storage.get('job');
        if (!ok && current?.status !== 'cancelled') await this.recordFailure(job, result.error);
        if (current?.status !== 'cancelled')
          await this.ctx.storage.put('job', {
            ...current,
            ...job,
            status: ok ? 'completed' : 'failed',
            result,
            finishedAt: Date.now(),
          });
        if (current?.status !== 'cancelled') {
          await this.touch();
          await this.notify(result);
        }
      } catch (e) {
        console.error(JSON.stringify({ event: 'turn_failed', error: String(e) }));
        const current = await this.ctx.storage.get('job');
        if (current?.status === 'cancelled') {
          if (this.ctx.container?.running) await this.ctx.container.destroy();
        } else {
          const error = 'The coding task failed. Your last checkpoint is preserved.';
          await this.recordFailure(job, error);
          await this.ctx.storage.put('job', { ...job, status: 'failed', result: { error } });
          await this.notify({ error });
        }
      }
      await this.ctx.storage.setAlarm(Date.now() + 35 * 60 * 1000);
      return;
    }
    if (job?.status === 'running') {
      const error = 'The task was interrupted. Retry from the last saved checkpoint.';
      await this.recordFailure(job, error);
      await this.ctx.storage.put('job', { ...job, status: 'failed', result: { error } });
      await this.notify({ error });
    }
    await this.ctx.storage.delete('modelQuota');
    if (this.ctx.container?.running) await this.ctx.container.destroy();
  }
}
