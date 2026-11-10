/** Web Push without a payload: when a turn ends, the server sends an empty push
 * signed with VAPID (RFC 8292); the service worker (web/sw.js) then fetches the
 * notice from GET /api/notifications/latest with the user's cookie. No
 * conversation text ever passes through a push service, so there is no RFC 8291
 * payload encryption to do.
 *
 *   alarm() ends a turn ─► notifyOwner ─► index:<user> /push/latest-put
 *                                     └─► POST <endpoint> (empty, VAPID JWT)
 *   browser push ─► sw.js ─► GET /api/notifications/latest ─► showNotification
 *
 * The VAPID key is env.VAPID_KEY, a P-256 private JWK (x, y, d). Subscriptions
 * and the latest notice live in the user's index object ('index:<user>').
 *
 * Depends on http.mjs. Leaves out payload encryption, and web/sw.js. */
import { json, boundedJson } from './http.mjs';

/** Push services a subscription may point at; anything else is refused, so a
 * subscription cannot make the Worker POST to an arbitrary host (SSRF). */
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
];
/** Devices kept per user; a newer subscription pushes out the oldest. */
const MAX_SUBSCRIPTIONS = 10;

/** Bytes as unpadded base64url, the encoding VAPID and push keys use. */
const b64url = bytes =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
/** The bytes of an unpadded base64url string. */
const unb64url = text =>
  Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
/** Text as UTF-8 bytes. */
const utf8 = text => new TextEncoder().encode(text);

/** True for an HTTPS URL on a known push service, without credentials or port. */
export function pushEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    PUSH_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))
  );
}

/** The browser's applicationServerKey: the uncompressed point 0x04||x||y. */
export function publicKey(jwk) {
  return b64url([4, ...unb64url(jwk.x), ...unb64url(jwk.y)]);
}

/** A VAPID JWT for one push service origin, valid 12 hours. WebCrypto's ECDSA
 * signature is the raw r||s that ES256 wants. */
export async function vapidJwt(jwk, audience, subject, now = Date.now()) {
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const part = value => b64url(utf8(JSON.stringify(value)));
  const unsigned =
    part({ typ: 'JWT', alg: 'ES256' }) +
    '.' +
    part({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject });
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    utf8(unsigned),
  );
  return unsigned + '.' + b64url(signature);
}

/** Turn text into one plain line: drop code blocks, links' targets and Markdown
 * symbols, collapse whitespace, cut to n characters. */
function plain(text, n) {
  const line = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`>~|[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > n ? line.slice(0, n - 1) + '…' : line;
}

/** The notice for a finished turn: the conversation title, the start of the
 * answer (or the error) and the link that reopens the conversation. */
export function turnNotice(session, sessionId, result) {
  return {
    title: plain(session.title || session.repo || 'Arno', 60),
    body: plain(result?.error || result?.summary, 120) || 'Your reply is ready.',
    url: '/?session=' + encodeURIComponent(sessionId || ''),
    at: Date.now(),
  };
}

/** Call an internal route of the user's index object; a body makes it a POST. */
const internal = (index, path, body) =>
  index.fetch(
    new Request(
      'https://internal' + path,
      body ? { method: 'POST', body: JSON.stringify(body) } : undefined,
    ),
  );

/** Store the notice and send an empty push to each of the owner's devices.
 * Subscriptions the push service reports gone (404, 410) are deleted. Each
 * request is bounded to 5 s; returns the number of pushes accepted. */
export async function notifyOwner(env, ownerId, notice, upstream = fetch) {
  if (!env.VAPID_KEY || !ownerId) return 0;
  const index = env.PROBE.getByName('index:' + ownerId);
  const { origin, subscriptions } = await (await internal(index, '/push/list')).json();
  if (!subscriptions.length) return 0;
  await internal(index, '/push/latest-put', notice);
  const jwk = JSON.parse(env.VAPID_KEY),
    k = publicKey(jwk),
    tokens = new Map();
  const results = await Promise.allSettled(
    subscriptions.map(async ({ endpoint }) => {
      const audience = new URL(endpoint).origin;
      if (!tokens.has(audience)) tokens.set(audience, vapidJwt(jwk, audience, origin));
      const r = await upstream(endpoint, {
        method: 'POST',
        headers: {
          Authorization: 'vapid t=' + (await tokens.get(audience)) + ', k=' + k,
          TTL: '3600',
          Urgency: 'normal',
          'Content-Length': '0',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      await r.body?.cancel();
      if (r.status === 404 || r.status === 410)
        await internal(index, '/push/unsubscribe', { endpoint });
      return r.ok;
    }),
  );
  return results.filter(r => r.status === 'fulfilled' && r.value).length;
}

/** Internal routes of the per-user index object ('index:<user>'). Stored as
 * 'push' = {origin, subscriptions: [{endpoint, at}]} and 'notice'. */
export const pushRoutes = {
  /** Remembers a device's endpoint (newest last, at most MAX_SUBSCRIPTIONS) and the app's origin. */
  async 'POST /push/subscribe'(request) {
    const { endpoint, origin } = await request.json();
    await this.ctx.storage.transaction(async txn => {
      const push = (await txn.get('push')) || { subscriptions: [] };
      const kept = push.subscriptions.filter(s => s.endpoint !== endpoint);
      kept.push({ endpoint, at: Date.now() });
      await txn.put('push', { origin, subscriptions: kept.slice(-MAX_SUBSCRIPTIONS) });
    });
    return new Response(null, { status: 204 });
  },
  /** Forgets a device's endpoint. */
  async 'POST /push/unsubscribe'(request) {
    const { endpoint } = await request.json();
    await this.ctx.storage.transaction(async txn => {
      const push = await txn.get('push');
      if (!push) return;
      push.subscriptions = push.subscriptions.filter(s => s.endpoint !== endpoint);
      await txn.put('push', push);
    });
    return new Response(null, { status: 204 });
  },
  /** The origin and subscriptions, for notifyOwner. */
  async 'GET /push/list'() {
    return json((await this.ctx.storage.get('push')) || { subscriptions: [] });
  },
  /** Keeps the latest notice for the service worker to fetch. */
  async 'POST /push/latest-put'(request) {
    await this.ctx.storage.put('notice', await request.json());
    return new Response(null, { status: 204 });
  },
  /** The latest notice, or 404 when there is none. */
  async 'GET /push/latest'() {
    const notice = await this.ctx.storage.get('notice');
    return notice ? json(notice) : json({ error: 'No notification' }, 404);
  },
};

/** The signed-in /api/ routes, merged into api.mjs's table. */
export const pushApiRoutes = {
  /** The public VAPID key the browser subscribes with (404 when unset). */
  async 'GET /api/push/key'(request, env) {
    if (!env.VAPID_KEY) return json({ error: 'Notifications are not configured' }, 404);
    return json({ key: publicKey(JSON.parse(env.VAPID_KEY)) });
  },
  /** Saves a browser's push subscription, if it is on a known push service. */
  async 'POST /api/push/subscribe'(request, env, url, auth) {
    const { endpoint } = await boundedJson(request, 4000);
    if (!pushEndpoint(endpoint)) return json({ error: 'Unsupported push service' }, 400);
    await internal(env.PROBE.getByName('index:' + auth.user.id), '/push/subscribe', {
      endpoint,
      origin: url.origin,
    });
    return json({ subscribed: true });
  },
  /** Removes a browser's push subscription. */
  async 'POST /api/push/unsubscribe'(request, env, url, auth) {
    const { endpoint } = await boundedJson(request, 4000);
    if (typeof endpoint !== 'string') return json({ error: 'Missing endpoint' }, 400);
    await internal(env.PROBE.getByName('index:' + auth.user.id), '/push/unsubscribe', {
      endpoint,
    });
    return json({ subscribed: false });
  },
  /** The notice the service worker shows after an empty push. */
  async 'GET /api/notifications/latest'(request, env, url, auth) {
    return internal(env.PROBE.getByName('index:' + auth.user.id), '/push/latest');
  },
};
