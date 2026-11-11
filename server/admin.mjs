/** Read-only access to the stored data for the deployment's operator, for
 * debugging from a terminal: every Durable Object's key-value storage, by
 * the object's name.
 *
 *   GET /admin/storage?name=index:<user>&prefix=turn:&limit=100
 *     Authorization: Bearer <ADMIN_TOKEN>
 *   worker.js -> adminRoute -> PROBE.getByName(name) GET /admin/storage
 *
 * Names: 'index:<user>' (the user's list of sessions, profile, usage) and
 * 'code:<user>:<id>' (one chat or coding session). Off unless the
 * ADMIN_TOKEN secret is set (wrangler secret put ADMIN_TOKEN). Depends on
 * http.mjs. Leaves out writing anything. */
import { json } from './http.mjs';

/** The most entries one request returns. */
const MAX_ENTRIES = 1000;

/** The Worker's /admin/ response: 404 unless the token matches. */
export async function adminRoute(request, env, url) {
  const given = new TextEncoder().encode(request.headers.get('Authorization') || ''),
    wanted = new TextEncoder().encode('Bearer ' + (env.ADMIN_TOKEN || ''));
  const ok =
    env.ADMIN_TOKEN &&
    given.byteLength === wanted.byteLength &&
    crypto.subtle.timingSafeEqual(given, wanted);
  const name = url.searchParams.get('name');
  if (!ok || request.method !== 'GET' || url.pathname !== '/admin/storage' || !name)
    return new Response('Not found', { status: 404 });
  console.log(JSON.stringify({ event: 'admin_read', name }));
  return env.PROBE.getByName(name).fetch(
    'https://internal/admin/storage' + url.search.replace(/([?&])name=[^&]*&?/, '$1'),
  );
}

/** The Durable Object's side, merged into its routes (probe/probe.mjs). */
export const adminRoutes = {
  /** The entries whose keys start with ?prefix, at most ?limit, as {key: value}. */
  async 'GET /admin/storage'(request, url) {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 200, MAX_ENTRIES);
    const entries = await this.ctx.storage.list({
      prefix: url.searchParams.get('prefix') || '',
      limit,
    });
    return json(Object.fromEntries(entries));
  },
};
