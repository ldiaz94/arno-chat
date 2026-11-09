/** Durable Object routes for the per-user and sign-in roles: the session index
 * and profile ('index:<user>'), the auth record and the pending OAuth state
 * ('auth:<id>'). Called with this = the ArnoProbe instance. */
import { json } from './http.mjs';

async function patchProfile(request, url) {
  const patch = await request.json();
  await this.ctx.storage.transaction(async txn => {
    const p = (await txn.get('profile')) || {};
    if (url.pathname === '/profile/key')
      p.keys = { ...(p.keys || {}), [patch.provider]: patch.value };
    else Object.assign(p, patch);
    await txn.put('profile', p);
  });
  return new Response(null, { status: 204 });
}

// The request log on 'index:<user>': one record per model request, search or
// page read, 'req:<time>:<n>', newest 1,000 kept.
const LOG_KEEP = 1000;

export const storeRoutes = {
  async 'POST /usage/log'(request) {
    const { requests } = await request.json();
    if (!Array.isArray(requests) || requests.length > 200)
      return json({ error: 'Invalid log' }, 400);
    const records = {};
    requests.forEach((r, i) => {
      records[
        'req:' +
          String(r.at || Date.now()).padStart(16, '0') +
          ':' +
          crypto.randomUUID().slice(0, 8) +
          i
      ] = r;
    });
    await this.ctx.storage.put(records);
    const all = await this.ctx.storage.list({ prefix: 'req:' });
    if (all.size > LOG_KEEP)
      await this.ctx.storage.delete([...all.keys()].slice(0, all.size - LOG_KEEP));
    return json({ logged: requests.length }, 201);
  },
  async 'GET /usage/list'() {
    const rows = await this.ctx.storage.list({ prefix: 'req:', reverse: true, limit: LOG_KEEP });
    return json({ requests: [...rows.values()] });
  },
  async 'POST /index/remove'(request) {
    const { id } = await request.json();
    await this.ctx.storage.delete('session:' + id);
    return new Response(null, { status: 204 });
  },
  async '* /profile/get'() {
    return json(
      (await this.ctx.storage.get('profile')) || {
        systemPrompt: '',
        skills: [],
        mcp: [],
        keys: {},
        models: [],
      },
    );
  },
  'POST /profile/patch': patchProfile,
  'POST /profile/key': patchProfile,
  async '* /index/list'() {
    const entries = await this.ctx.storage.list({ prefix: 'session:' });
    return json({ sessions: [...entries.values()].sort((a, b) => b.createdAt - a.createdAt) });
  },
  async '* /index/add'(request) {
    const entry = await request.json();
    await this.ctx.storage.put('session:' + entry.id, entry);
    return new Response(null, { status: 204 });
  },
  async 'POST /auth/put'(request) {
    const data = await request.json();
    await this.ctx.storage.put('auth', data);
    return new Response(null, { status: 204 });
  },
  async '* /auth/get'() {
    const auth = await this.ctx.storage.get('auth');
    if (!auth || auth.expiresAt < Date.now()) {
      if (auth) await this.ctx.storage.deleteAll();
      return new Response(null, { status: 404 });
    }
    return Response.json(auth);
  },
  async 'POST /auth/delete'() {
    await this.ctx.storage.deleteAll();
    return new Response(null, { status: 204 });
  },
  async 'POST /oauth/put'(request) {
    await this.ctx.storage.put('oauth', {
      ...(await request.json()),
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    return new Response(null, { status: 204 });
  },
  async 'POST /oauth/take'() {
    const value = await this.ctx.storage.get('oauth');
    await this.ctx.storage.delete('oauth');
    if (!value || value.expiresAt < Date.now()) return new Response(null, { status: 404 });
    return Response.json(value);
  },
};
