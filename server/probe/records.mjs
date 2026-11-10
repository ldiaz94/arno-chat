/** A conversation's records, part of ArnoProbe (probe.mjs): its turns (saved
 * with their usage and cost, the newest 20 kept), failed and stopped turns, the
 * owner's request log, the job's phase, and the notice when a turn ends. Depends
 * on ../account.mjs (keys), ../prices.mjs (cost) and ../push.mjs (notices).
 * Leaves out running turns (../chat/turn.mjs, ../code/turn.mjs). */
import { profile, credential } from '../account.mjs';
import { prices, priceOf, cost, costParts, webRates, WEB_RATES } from '../prices.mjs';
import { notifyOwner, turnNotice } from '../push.mjs';

export const records = {
  /** Save a finished turn (plain or coding) with its usage and cost, and update the totals. editAt
   * drops the turns an edited message replaces; oversized fields are clipped. */
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
  },
  /** A retry names the failed turn it replaces (job.replaces, that turn's at);
   * the failed record goes once the retry's own outcome is saved. */
  async dropReplaced(job) {
    if (!job?.replaces) return;
    const turns = await this.ctx.storage.list({ prefix: 'turn:' });
    const keys = [...turns].filter(([, t]) => t.failed && t.at === job.replaces).map(([k]) => k);
    if (keys.length) await this.ctx.storage.delete(keys);
  },
  /** Retain the 20 most recent turns. */
  async trimTurns() {
    const all = await this.ctx.storage.list({ prefix: 'turn:' });
    if (all.size > 20) await this.ctx.storage.delete([...all.keys()].slice(0, all.size - 20));
  },
  /** Read bounded recent turns; old sessions migrate lazily after a successful
   * checkpoint, so a failed model run never discards their prior transcript. */
  async history(withFailures = false) {
    const rows = await this.ctx.storage.list({ prefix: 'turn:', reverse: true, limit: 20 });
    const turns = rows.size
      ? [...rows.values()].reverse()
      : (await this.ctx.storage.get('history')) || [];
    return withFailures ? turns : turns.filter(t => !t.failed);
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
