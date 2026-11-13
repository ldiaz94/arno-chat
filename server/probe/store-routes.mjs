/** Durable Object routes for the per-user and sign-in roles: the session index
 * and profile ('index:<user>'), the auth record and the pending OAuth state
 * ('auth:<id>'). Called with this = the ArnoProbe instance. Depends on
 * ../http.mjs and chat/memory.mjs. Leaves out the session routes (session-routes.mjs). */
import { json } from '../http.mjs';
import { refreshGithub } from '../auth.mjs';
import { changeMemories } from '../chat/memory.mjs';

/** Merge a JSON patch into the profile, or set one provider key (/profile/key), in one
 * transaction. */
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
  /** Add request-log records sent by a session (at most 200 at a time), then drop the oldest
   * beyond LOG_KEEP. */
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
  /** The extra repositories remembered for each main repository
   * (code/extras.mjs): {companions: {"owner/name": ["owner/other", …]}}. */
  async 'GET /companions'() {
    return json({ companions: (await this.ctx.storage.get('companions')) || {} });
  },
  /** Remembers, or forgets, an extra repository for a main one: {repo, extra, keep}. */
  async 'POST /companions'(request) {
    const { repo, extra, keep } = await request.json(),
      all = (await this.ctx.storage.get('companions')) || {},
      list = (all[repo] || []).filter(r => r !== extra);
    if (keep) list.push(extra);
    if (list.length) all[repo] = list.slice(0, 6);
    else delete all[repo];
    await this.ctx.storage.put('companions', all);
    return json({ companions: all });
  },
  /** The request log, newest first. */
  async 'GET /usage/list'() {
    const rows = await this.ctx.storage.list({ prefix: 'req:', reverse: true, limit: LOG_KEEP });
    return json({ requests: [...rows.values()] });
  },
  /** Remove a session from the owner's list. */
  async 'POST /index/remove'(request) {
    const { id } = await request.json();
    await this.ctx.storage.delete('session:' + id);
    return new Response(null, { status: 204 });
  },
  /** The profile, or an empty one for a new user. */
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
  /** Merge fields into the profile. */
  'POST /profile/patch': patchProfile,
  /** An MCP connection's token after an OAuth sign-in or refresh (mcp-oauth.mjs),
   * kept only if the connection still has the URL it was signed in to. */
  async 'POST /profile/mcp-token'(request) {
    const { id, url, token, oauth } = await request.json();
    await this.ctx.storage.transaction(async txn => {
      const p = (await txn.get('profile')) || {};
      p.mcp = (p.mcp || []).map(c => (c.id === id && c.url === url ? { ...c, token, oauth } : c));
      await txn.put('profile', p);
    });
    return new Response(null, { status: 204 });
  },
  /** Read memories ({recall: ids}, answering {facts: [{id, title, fact}]}),
   * or add or remove one (chat/memory.mjs changeMemories) in one transaction,
   * answering {id} of the one added; {error} when that fails. */
  async 'POST /profile/memory'(request) {
    const change = await request.json();
    try {
      if (change.recall) {
        const p = (await this.ctx.storage.get('profile')) || {},
          known = (p.memories || []).filter(m => change.recall.includes(m.id)),
          facts = await this.ctx.storage.get(known.map(m => 'memory:' + m.id));
        return json({
          facts: known.map(m => ({ id: m.id, title: m.title, fact: facts.get('memory:' + m.id) })),
        });
      }
      let id;
      await this.ctx.storage.transaction(async txn => {
        const p = (await txn.get('profile')) || {},
          { memories, put, drop } = changeMemories(p.memories, change);
        p.memories = memories;
        await txn.put({ profile: p, ...put });
        if (drop.length) await txn.delete(drop);
        id = Object.keys(put)[0]?.slice('memory:'.length);
      });
      return json({ id });
    } catch (e) {
      return json({ error: e.message });
    }
  },
  /** Set one provider's API key in the profile. */
  'POST /profile/key': patchProfile,
  /** Store the user's avatar image (bytes and type). */
  async 'PUT /avatar'(request) {
    const type = request.headers.get('Content-Type') || '';
    await this.ctx.storage.put('avatar', {
      type,
      bytes: new Uint8Array(await request.arrayBuffer()),
    });
    return new Response(null, { status: 204 });
  },
  /** Remove the avatar. */
  async 'DELETE /avatar'() {
    await this.ctx.storage.delete('avatar');
    return new Response(null, { status: 204 });
  },
  /** The avatar, served with headers that stop it running as a page. */
  async 'GET /avatar'() {
    const avatar = await this.ctx.storage.get('avatar');
    if (!avatar) return json({ error: 'No avatar' }, 404);
    return new Response(avatar.bytes, {
      headers: {
        'Content-Type': avatar.type,
        'Cache-Control': 'private, no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  },
  /** Remember a sign-in id for this user (the last 50), so account deletion can find them. */
  async 'POST /logins/add'(request) {
    const { id } = await request.json();
    const logins = ((await this.ctx.storage.get('logins')) || []).filter(l => l !== id);
    await this.ctx.storage.put('logins', [...logins, id].slice(-50));
    return new Response(null, { status: 204 });
  },
  /** Everything the per-user index object holds goes: profile, keys, search
   * connection, push subscriptions, request log, session list. Returns what
   * the caller still has to delete elsewhere (sessions, sign-ins). */
  async 'POST /account/wipe'() {
    const sessions = [...(await this.ctx.storage.list({ prefix: 'session:' })).values()].map(
      s => s.id,
    );
    const logins = (await this.ctx.storage.get('logins')) || [];
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return json({ sessions, logins });
  },
  /** The owner's sessions, most recently active first. */
  async '* /index/list'() {
    const entries = await this.ctx.storage.list({ prefix: 'session:' });
    // Most recently active first: touch() stamps updatedAt after each turn.
    const active = s => s.updatedAt || s.createdAt;
    return json({ sessions: [...entries.values()].sort((a, b) => active(b) - active(a)) });
  },
  /** Add or update a session's entry in the owner's list. */
  async '* /index/add'(request) {
    const entry = await request.json();
    await this.ctx.storage.put('session:' + entry.id, entry);
    return new Response(null, { status: 204 });
  },
  /** Store a sign-in record (auth:<id> object). */
  async 'POST /auth/put'(request) {
    const data = await request.json();
    await this.ctx.storage.put('auth', data);
    return new Response(null, { status: 204 });
  },
  /** The sign-in record; 404, and the record is erased, once it has expired.
   * A GitHub token within 5 minutes of expiring is refreshed first, once for
   * all the requests waiting on it: GitHub takes each refresh token once. */
  async '* /auth/get'() {
    let auth = await this.ctx.storage.get('auth');
    if (!auth || auth.expiresAt < Date.now()) {
      if (auth) await this.ctx.storage.deleteAll();
      return new Response(null, { status: 404 });
    }
    if (auth.refreshToken && auth.tokenExpiresAt < Date.now() + 5 * 60000) {
      this.refreshing ??= refreshGithub(this.env, auth)
        .then(async fresh => (await this.ctx.storage.put('auth', fresh), fresh))
        .finally(() => (this.refreshing = null));
      auth = await this.refreshing;
    }
    return Response.json(auth);
  },
  /** Sign out: erase the sign-in record. */
  async 'POST /auth/delete'() {
    await this.ctx.storage.deleteAll();
    return new Response(null, { status: 204 });
  },
  /** Keep the pending OAuth state for 10 minutes. */
  async 'POST /oauth/put'(request) {
    await this.ctx.storage.put('oauth', {
      ...(await request.json()),
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    return new Response(null, { status: 204 });
  },
  /** Return the pending OAuth state and delete it, so it works once; 404 if missing or expired. */
  async 'POST /oauth/take'() {
    const value = await this.ctx.storage.get('oauth');
    await this.ctx.storage.delete('oauth');
    if (!value || value.expiresAt < Date.now()) return new Response(null, { status: 404 });
    return Response.json(value);
  },
};
