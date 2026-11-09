/** Durable Object routes for a session ('code:<user>:<id>') called back by the
 * model and MCP gateways and the container's web tools: per-turn quotas,
 * progress, usage and research state. Called with this = the ArnoProbe instance. */
import { json } from './http.mjs';

export const gatewayRoutes = {
  async '* /web-state'(request) {
    const q = await this.ctx.storage.get('modelQuota');
    if (!q || q.deadline < Date.now()) return json({ error: 'No active research task' }, 403);
    if (request.method === 'POST') {
      const state = await request.json();
      await this.ctx.storage.transaction(async txn => {
        const current = await txn.get('modelQuota');
        if (!current) return;
        await txn.put('modelQuota', {
          ...current,
          sources: state.sources,
          webCounts: state.counts,
        });
      });
      return new Response(null, { status: 204 });
    }
    return json({ sources: q.sources || [], counts: q.webCounts || { searches: 0, reads: 0 } });
  },
  async '* /model-account'() {
    return json({ ownerId: (await this.ctx.storage.get('session'))?.ownerId || null });
  },
  async 'POST /mcp-permit'() {
    const allowed = await this.ctx.storage.transaction(async txn => {
      const q = await txn.get('modelQuota');
      if (!q || q.deadline < Date.now() || (q.mcpUsed || 0) >= 50) return false;
      q.mcpUsed = (q.mcpUsed || 0) + 1;
      await txn.put('modelQuota', q);
      return true;
    });
    return allowed
      ? json({ ownerId: (await this.ctx.storage.get('session'))?.ownerId || null })
      : new Response('Denied', { status: 429 });
  },
  async 'POST /model-permit'() {
    let turnId = '',
      round = 0;
    const allowed = await this.ctx.storage.transaction(async txn => {
      const quota = await txn.get('modelQuota');
      if (!quota || quota.deadline < Date.now() || quota.used >= 16) return false;
      quota.used += 1;
      round = quota.used;
      turnId = quota.turnId || '';
      await txn.put('modelQuota', quota);
      return true;
    });
    return new Response(null, {
      status: allowed ? 204 : 429,
      headers: { 'X-Turn-Id': turnId, 'X-Model-Round': String(round) },
    });
  },
  async 'POST /model-progress'(request) {
    const preview = await request.json(),
      q = await this.ctx.storage.get('modelQuota');
    if (!q || q.turnId !== preview.turnId || q.deadline < Date.now() || preview.round !== q.used)
      return new Response(null, { status: 409 });
    await this.progress(preview);
    return new Response(null, { status: 204 });
  },
  async 'POST /model-usage'(request) {
    const { turnId, usage } = await request.json();
    await this.ctx.storage.transaction(async txn => {
      const q = await txn.get('modelQuota');
      if (!q || q.turnId !== turnId) return;
      const safe = n => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
      q.inputTokens = (q.inputTokens || 0) + safe(usage.prompt_tokens);
      q.outputTokens = (q.outputTokens || 0) + safe(usage.completion_tokens);
      q.cachedTokens = (q.cachedTokens || 0) + safe(usage.cached_tokens);
      q.cacheWriteTokens = (q.cacheWriteTokens || 0) + safe(usage.cache_write_tokens);
      q.measuredCalls = (q.measuredCalls || 0) + 1;
      await txn.put('modelQuota', q);
    });
    return new Response(null, { status: 204 });
  },
};
