/** A conversation's records, part of ArnoProbe (probe.mjs): its turns (saved
 * with their usage and cost, the newest 1000 kept), failed and stopped turns, the
 * owner's request log, the job's phase, and the notice when a turn ends. Depends
 * on ../account.mjs (keys), ../prices.mjs (cost) and ../push.mjs (notices).
 * Leaves out running turns (../chat/turn.mjs, ../code/turn.mjs). */
import { profile, credential } from '../account.mjs';
import { prices, priceOf, cost, costParts, webRates, WEB_RATES } from '../prices.mjs';
import { notifyOwner, turnNotice } from '../push.mjs';
import { providerModel } from '../providers.mjs';
import { nameChat } from '../chat/title.mjs';

// Turns kept per conversation: in effect the whole of it. Each is its own
// storage value, clipped by saveTurn to about 115 kB, well under the 2 MB a
// Durable Object value may hold.
export const KEPT_TURNS = 1000;
// Turns read for the model's context (chat/chat.mjs and code/context.mjs take
// at most 20 of them, within 32,000 characters).
export const CONTEXT_TURNS = 20;

export const records = {
  /** Save a finished turn (plain or coding) with its usage and cost, and update the totals. editAt
   * drops the turns an edited message replaces; oversized fields are clipped. */
  async saveTurn(result, prompt, snapshot, sourceRegistry, editAt) {
    await this.dropReplaced(await this.ctx.storage.get('job'));
    if (editAt) {
      const turns = await this.ctx.storage.list({ prefix: 'turn:' }),
        replaced = [...turns].filter(([, t]) => t.at >= editAt).map(([k]) => k);
      // An edit far back replaces many turns; delete takes 128 keys at a time.
      for (let i = 0; i < replaced.length; i += 128)
        await this.ctx.storage.delete(replaced.slice(i, i + 128));
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
    const stats = await this.stats();
    await this.charge(result, stats);
    stats.turns++;
    stats.totalMs += result.timing.totalMs;
    const records = { stats },
      legacy = await this.ctx.storage.get('history');
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
  },
  /** Names the conversation from prompt and the answer to it, by its own
   * model (chat/title.mjs), when it has no name yet: a chat still called
   * "General chat", a coding session with none (its repository stands in).
   * A name the user gave is never replaced, even one given meanwhile. A chat
   * the model can't name is named after the prompt. */
  async nameIfNew(prompt, answer) {
    const s = await this.ctx.storage.get('session'),
      chat = s?.kind === 'chat';
    if (!s?.ownerId || !s.id || s.customTitle || (chat ? s.title !== 'General chat' : s.title))
      return;
    const p = await profile(this.env, s.ownerId),
      selected = providerModel(s.model);
    const named = await nameChat({
      model: selected.id,
      provider: selected.provider,
      key: await credential(this.env, s.ownerId, p, selected.provider),
      message: prompt,
      answer,
    });
    const latest = await this.ctx.storage.get('session'),
      title = named || (chat ? prompt.slice(0, 70) : '');
    if (latest.customTitle || !title) return;
    const meta = { ...latest, title };
    await this.ctx.storage.put('session', meta);
    await this.env.PROBE.getByName('index:' + s.ownerId).fetch('https://internal/index/add', {
      method: 'POST',
      body: JSON.stringify(meta),
    });
  },
  /** The session's running totals. */
  async stats() {
    return (
      (await this.ctx.storage.get('stats')) || {
        turns: 0,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        measuredCalls: 0,
        totalMs: 0,
      }
    );
  },
  /** Prices what a turn spent (result.usage, webUsage, requestLog, and its
   * page reviews, priced at their own model by chat/turn.mjs), sets its
   * usage.cost and costParts, adds it to the stats given and to the owner's
   * request log. A failed or stopped turn is charged too (chargeFailed). */
  async charge(result, stats) {
    result.model ||= (await this.ctx.storage.get('session'))?.model;
    // Cost: the model's tokens at list price (null when unpriced) plus searches;
    // the parts are kept per turn and summed per session for the breakdown.
    const rows = await prices(),
      price = priceOf(rows, result.model),
      // Workers' tokens (usage.byModel) at their models' prices, the rest at
      // the session model's.
      shares = Object.entries(result.usage.byModel || {}),
      own = { ...result.usage };
    for (const [, u] of shares)
      for (const k of [
        'inputTokens',
        'cachedTokens',
        'cacheWriteTokens',
        'outputTokens',
        'measuredCalls',
      ])
        own[k] = Math.max(0, (own[k] || 0) - (u[k] || 0));
    const costs = [cost(price, own), ...shares.map(([m, u]) => cost(priceOf(rows, m), u))],
      modelCost = costs.every(c => c == null) ? null : costs.reduce((n, c) => n + (c || 0), 0),
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
      parts = costParts(price, own, result.webUsage, rates),
      web = parts.search + parts.reads;
    for (const [m, u] of shares) {
      const p = costParts(priceOf(rows, m), u, null, rates);
      for (const k of ['input', 'cached', 'cacheWrite', 'output'])
        if (p[k] != null) parts[k] = (parts[k] || 0) + p[k];
    }
    const reviews = result.reviews || [];
    parts.review = reviews.reduce((n, r) => n + (r.cost || 0), 0);
    result.usage.calls += reviews.reduce((n, r) => n + r.usage.calls, 0);
    result.usage.costParts = parts;
    result.usage.cost =
      modelCost == null && !web && !parts.review ? null : (modelCost || 0) + web + parts.review;
    stats.cost = (stats.cost || 0) + (result.usage.cost || 0);
    stats.costParts = Object.fromEntries(
      Object.entries(parts).map(([k, v]) => [k, (stats.costParts?.[k] || 0) + (v || 0)]),
    );
    stats.unpriced =
      (stats.unpriced || 0) + Number(modelCost == null && !!result.usage.measuredCalls);
    await this.logRequests(session, result, price, rates);
    delete result.requestLog;
    delete result.reviews;
    stats.calls += result.usage.calls;
    stats.measuredCalls += result.usage.measuredCalls;
    stats.inputTokens += result.usage.inputTokens || 0;
    stats.outputTokens += result.usage.outputTokens || 0;
    stats.webSearches = (stats.webSearches || 0) + (result.webUsage?.searches || 0);
    stats.webReads = (stats.webReads || 0) + (result.webUsage?.reads || 0);
  },
  /** Charges what a turn that failed or was stopped had already spent (the
   * `spent` a chat turn's error carries): its model calls and web calls go
   * to the totals and the request log like a finished turn's, and its usage
   * onto the failed turn's record (the newest), for its card. Best effort. */
  async chargeFailed(spent) {
    try {
      const stats = await this.stats();
      await this.charge(spent, stats);
      await this.ctx.storage.put('stats', stats);
      const [[key, turn] = []] = await this.ctx.storage.list({
        prefix: 'turn:',
        reverse: true,
        limit: 1,
      });
      if (turn?.failed && !turn.usage)
        await this.ctx.storage.put(key, { ...turn, usage: spent.usage });
      console.log(
        JSON.stringify({
          event: 'failed_turn_cost',
          cost: spent.usage.cost,
          calls: spent.usage.calls,
        }),
      );
    } catch (e) {
      console.error(JSON.stringify({ event: 'failed_turn_cost_failed', error: String(e) }));
    }
  },
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
      // Each page review as one request, at its own model.
      ...(result.reviews || []).map(r => ({
        ...base,
        at,
        kind: 'model',
        model: r.model,
        input: r.usage.inputTokens,
        cached: r.usage.cachedTokens,
        output: r.usage.outputTokens,
        cost: r.cost,
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
  },
  /** Keep a failed or stopped turn in the transcript so it survives a reload
   * and can be retried. It never enters model context (see history). */
  async recordFailure(job, error, cause) {
    await this.logFailure(job, error, cause);
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
  },
  /** Logs a failed turn with what it ran on, to find it in the Worker's logs:
   * the session and its kind, the model (provider/name), the options, how long
   * it ran, the error shown and, when one was thrown, its cause. */
  async logFailure(job, error, cause) {
    const s = (await this.ctx.storage.get('session')) || {};
    console.error(
      JSON.stringify({
        event: 'turn_failed',
        session: s.id,
        kind: s.kind || 'code',
        model: s.model,
        repo: s.repo,
        options: job.options,
        ms: job.createdAt ? Date.now() - job.createdAt : null,
        error: String(error),
        ...(cause ? { cause: String(cause) } : {}),
      }),
    );
  },
  /** A retry names the failed turn it replaces (job.replaces, that turn's at);
   * the failed record goes once the retry's own outcome is saved. */
  async dropReplaced(job) {
    if (!job?.replaces) return;
    const turns = await this.ctx.storage.list({ prefix: 'turn:' });
    const keys = [...turns].filter(([, t]) => t.failed && t.at === job.replaces).map(([k]) => k);
    if (keys.length) await this.ctx.storage.delete(keys);
  },
  /** Retain the KEPT_TURNS most recent turns. */
  async trimTurns() {
    const all = await this.ctx.storage.list({ prefix: 'turn:' });
    if (all.size > KEPT_TURNS)
      await this.ctx.storage.delete([...all.keys()].slice(0, all.size - KEPT_TURNS));
  },
  /** The newest `limit` turns, oldest first; old sessions migrate lazily after
   * a successful checkpoint, so a failed model run never discards their prior
   * transcript. */
  async history(withFailures = false, limit = KEPT_TURNS) {
    const rows = await this.ctx.storage.list({ prefix: 'turn:', reverse: true, limit });
    const turns = rows.size
      ? [...rows.values()].reverse()
      : (await this.ctx.storage.get('history')) || [];
    return withFailures ? turns : turns.filter(t => !t.failed);
  },
  /** The finished turns a new turn's model sees as context: the newest
   * CONTEXT_TURNS, or, when it edits the message sent at editAt, the
   * CONTEXT_TURNS before that one. Only an edit reads the whole transcript. */
  async contextTurns(editAt) {
    if (!editAt) return this.history(false, CONTEXT_TURNS);
    return (await this.history()).filter(t => t.at < editAt).slice(-CONTEXT_TURNS);
  },
  /** Persist phase updates for mobile polling; never revive a cancelled job. */
  async phase(stage, extra = {}) {
    const job = await this.ctx.storage.get('job');
    if (job?.status === 'running') await this.ctx.storage.put('job', { ...job, stage, ...extra });
  },
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
  },
  /** Lists the session again in the owner's list as it now is (its artifacts
   * changed), without stamping it active. */
  async relist() {
    const session = await this.ctx.storage.get('session');
    if (!session?.ownerId || !session.id) return;
    await this.env.PROBE.getByName('index:' + session.ownerId).fetch('https://internal/index/add', {
      method: 'POST',
      body: JSON.stringify(session),
    });
  },
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
  },
};
