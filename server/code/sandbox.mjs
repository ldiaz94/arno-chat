/** What a coding session's container may reach besides the model, MCP and git
 * gateways, and the settings that say so:
 *
 *   npm.internal      → https://registry.npmjs.org      always, read only
 *   pypi.internal     → https://pypi.org                 always, read only
 *   pyfiles.internal  → https://files.pythonhosted.org  always, read only
 *   cf.internal       → https://api.cloudflare.com      with the owner's
 *                       Cloudflare API token, added here, while a turn runs
 *   the internet      only when the owner turns on full internet access
 *
 * The container reaches each .internal name over plain HTTP, intercepted by a
 * gateway (gateways.mjs); npm, pip and wrangler are pointed at them by the
 * environment a turn's commands get (sandboxEnv). PyPI's pages name their
 * files on files.pythonhosted.org, so they are rewritten to pyfiles.internal;
 * npm does the same for its own tarballs (replace-registry-host). Depends on
 * account.mjs (profile), secrets.mjs (sealing the token) and http.mjs. Leaves out other registries (crates, Go, Maven, RubyGems) and
 * publishing to any of them. */
import { profile } from '../account.mjs';
import { seal, unseal } from '../secrets.mjs';
import { json } from '../http.mjs';

/** The registry names the container reaches, and the site each one forwards to. */
const REGISTRIES = {
  'npm.internal': 'https://registry.npmjs.org',
  'pypi.internal': 'https://pypi.org',
  'pyfiles.internal': 'https://files.pythonhosted.org',
};
/** Every .internal name this module answers for (the gateways intercept these). */
export const SANDBOX_HOSTS = [...Object.keys(REGISTRIES), 'cf.internal'];

/** The environment of a turn's commands: package managers and wrangler go
 * through the gateways. cloudflare is the owner's public settings, or null. */
export function sandboxEnv(cloudflare) {
  return {
    NPM_CONFIG_REGISTRY: 'http://npm.internal/',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    PIP_INDEX_URL: 'http://pypi.internal/simple/',
    PIP_TRUSTED_HOST: 'pypi.internal pyfiles.internal',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    ...(cloudflare?.saved && {
      CLOUDFLARE_API_BASE_URL: 'http://cf.internal/client/v4',
      // wrangler wants a token to be set; the gateway puts in the real one.
      CLOUDFLARE_API_TOKEN: 'added-by-the-host',
      WRANGLER_SEND_METRICS: 'false',
      ...(cloudflare.accountId && { CLOUDFLARE_ACCOUNT_ID: cloudflare.accountId }),
    }),
  };
}

/** One request to a package registry, read only. */
export async function registryProxy(request, upstream = fetch) {
  const url = new URL(request.url),
    base = REGISTRIES[url.hostname];
  if (!base || url.port || !['GET', 'HEAD'].includes(request.method))
    return new Response('Only reading packages from npm and PyPI is allowed\n', { status: 403 });
  const headers = new Headers({ 'User-Agent': request.headers.get('User-Agent') || 'arno-chat' });
  if (request.headers.get('Accept')) headers.set('Accept', request.headers.get('Accept'));
  let r;
  try {
    r = await upstream(base + url.pathname + url.search, {
      method: request.method,
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    return new Response(url.hostname + ': the registry could not be reached\n', { status: 502 });
  }
  const out = new Headers();
  for (const h of ['Content-Type', 'ETag', 'Last-Modified', 'Cache-Control'])
    if (r.headers.get(h)) out.set(h, r.headers.get(h));
  // PyPI's index pages link to their files on another host.
  if (url.hostname === 'pypi.internal' && r.ok && request.method === 'GET') {
    const text = (await r.text()).replaceAll(
      'https://files.pythonhosted.org/',
      'http://pyfiles.internal/',
    );
    return new Response(text, { status: r.status, headers: out });
  }
  return new Response(r.body, { status: r.status, headers: out });
}

/** One request to Cloudflare's API with token, the owner's. */
export async function cloudflareProxy(request, token, upstream = fetch) {
  const url = new URL(request.url);
  if (url.hostname !== 'cf.internal' || url.port || !url.pathname.startsWith('/client/v4/'))
    return new Response('cf.internal reaches only Cloudflare’s API\n', { status: 403 });
  if (!token)
    return Response.json(
      { success: false, errors: [{ message: 'Save a Cloudflare API token in Settings' }] },
      { status: 401 },
    );
  const headers = new Headers(request.headers);
  for (const h of ['Host', 'Content-Length', 'Connection', 'X-Auth-Key', 'X-Auth-Email'])
    headers.delete(h);
  headers.set('Authorization', 'Bearer ' + token);
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : request.body;
  try {
    const r = await upstream('https://api.cloudflare.com' + url.pathname + url.search, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      ...(body && { duplex: 'half' }),
    });
    return new Response(r.body, { status: r.status, headers: r.headers });
  } catch {
    return new Response('Cloudflare’s API could not be reached\n', { status: 502 });
  }
}

/** The owner's Cloudflare token, unsealed, or ''. */
export async function cloudflareToken(env, userId) {
  const p = await profile(env, userId);
  return p.cloudflare?.token ? unseal(env, userId, 'cloudflare', p.cloudflare.token) : '';
}

/** The sandbox settings as the browser sees them: no token. */
export function publicSandbox(p) {
  return {
    internet: !!p.internet,
    cloudflare: p.cloudflare
      ? { saved: !!p.cloudflare.token, accountId: p.cloudflare.accountId || '' }
      : null,
  };
}

/** POST /api/account/sandbox: {internet} turns full internet on or off;
 * {cloudflare: {token, accountId}} saves the token (null removes it);
 * {test: true} asks Cloudflare whether the saved token works. */
export async function sandboxRoute(request, env, userId) {
  const body = await request.json().catch(() => ({})),
    p = await profile(env, userId),
    patch = {};
  if (body.test) {
    const token = await cloudflareToken(env, userId);
    if (!token) return json({ error: 'Save a Cloudflare API token first' }, 400);
    const r = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: { Authorization: 'Bearer ' + token },
    });
    const d = await r.json().catch(() => ({}));
    return d.success
      ? json({ ok: true, status: d.result?.status })
      : json({ error: d.errors?.[0]?.message || 'Cloudflare refused the token' }, 400);
  }
  if ('internet' in body) patch.internet = !!body.internet;
  if ('cloudflare' in body) {
    const c = body.cloudflare;
    if (c === null) patch.cloudflare = null;
    else {
      const accountId = String(c.accountId ?? p.cloudflare?.accountId ?? '').trim();
      if (accountId && !/^[0-9a-f]{32}$/.test(accountId))
        return json({ error: 'A Cloudflare account ID is 32 hexadecimal characters' }, 400);
      if (c.token && (typeof c.token !== 'string' || c.token.length > 200 || /\s/.test(c.token)))
        return json({ error: 'Enter a valid Cloudflare API token' }, 400);
      const token = c.token
        ? await seal(env, userId, 'cloudflare', c.token)
        : p.cloudflare?.token || null;
      if (!token) return json({ error: 'Enter a Cloudflare API token' }, 400);
      patch.cloudflare = { token, accountId };
    }
  }
  await env.PROBE.getByName('profile:' + userId).fetch('https://internal/profile/patch', {
    method: 'POST',
    body: JSON.stringify(patch),
  });
  return json(publicSandbox({ ...p, ...patch }));
}
