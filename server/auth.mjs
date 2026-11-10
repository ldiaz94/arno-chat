/** Sign-in: the GitHub OAuth flow (/auth/*), the cookie-bound auth record kept
 * in its own Durable Object (probe/probe.mjs, keyed auth:<id>), and an
 * authenticated GitHub API client. Depends on http.mjs and
 * gateways/mcp-oauth.mjs (the MCP callback). Leaves out token refresh: a
 * sign-in simply expires after 30 days. */
import { COOKIE, SECURITY, json, cookie, sessionCookie } from './http.mjs';
import { mcpCallback } from './gateways/mcp-oauth.mjs';

/** The Durable Object that holds one auth record (or pending OAuth state) by id. */
export function authObject(env, id) {
  return env.PROBE.getByName(`auth:${id}`);
}
/** The signed-in user's auth record ({id, token, user, scopes, ...}) from the
 * cookie, or null when absent, malformed or expired. */
export async function currentAuth(request, env) {
  const id = cookie(request, COOKIE);
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const response = await authObject(env, id).fetch('https://internal/auth/get');
  if (!response.ok) return null;
  return { id, ...(await response.json()) };
}
/** Calls the GitHub API with the user's token; init is passed to fetch. */
export async function github(path, token, init = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    redirect: init.redirect || 'follow',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'arno-remote/0.1',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
}

/** What repositories the connection reaches. A GitHub App user token (ghu_)
 * has no scopes: it reaches what the app is installed on, so ask GitHub for
 * the installations ('all' or 'selected' repositories). An OAuth token reaches
 * private repositories when it has the repo scope. */
export async function repoAccess(auth) {
  if (!/^ghu_/.test(auth.token))
    return { app: false, access: auth.githubConnected ? 'all' : 'public' };
  try {
    const r = await github('/user/installations', auth.token);
    if (!r.ok) return { app: true, access: 'unknown' };
    const { installations = [] } = await r.json(),
      mine = installations.find(i => i.account?.login === auth.user.login);
    return {
      app: true,
      access: !mine ? 'public' : mine.repository_selection === 'all' ? 'all' : 'selected',
      configure: mine?.html_url || 'https://github.com/settings/installations',
    };
  } catch {
    return { app: true, access: 'unknown' };
  }
}

/** Handles /auth/github (start), /auth/callback (finish and set the cookie),
 * /auth/logout and /auth/mcp/callback; returns null for other paths. */
export async function handleOAuth(request, env, url) {
  if (url.pathname === '/auth/mcp/callback') return mcpCallback(request, env, url);
  if (url.pathname === '/auth/github') {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET)
      return json({ error: 'GitHub OAuth is not configured' }, 503);
    const state = crypto.randomUUID();
    const connectRepos = url.searchParams.get('repos') === '1';
    await authObject(env, state).fetch('https://internal/oauth/put', {
      method: 'POST',
      body: JSON.stringify({ origin: url.origin, connectRepos }),
    });
    const target = new URL('https://github.com/login/oauth/authorize');
    target.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
    target.searchParams.set('redirect_uri', `${url.origin}/auth/callback`);
    target.searchParams.set('scope', connectRepos ? 'read:user repo' : 'read:user');
    if (connectRepos) target.searchParams.set('prompt', 'select_account');
    target.searchParams.set('state', state);
    return new Response(null, {
      status: 302,
      headers: {
        Location: target.toString(),
        'Set-Cookie': `arno_oauth=${state}; Path=/auth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        ...SECURITY,
      },
    });
  }
  if (url.pathname === '/auth/callback') {
    const state = url.searchParams.get('state') || '';
    if (state !== cookie(request, 'arno_oauth') || !/^[0-9a-f-]{36}$/.test(state))
      return json({ error: 'Invalid OAuth state' }, 400);
    const saved = await authObject(env, state).fetch('https://internal/oauth/take', {
      method: 'POST',
    });
    if (!saved.ok) return json({ error: 'OAuth state expired' }, 400);
    const savedState = await saved.json();
    if (savedState.origin !== url.origin) return json({ error: 'OAuth origin mismatch' }, 400);
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      redirect: 'manual',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code: url.searchParams.get('code'),
        redirect_uri: `${url.origin}/auth/callback`,
      }),
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token)
      return json({ error: 'GitHub sign-in failed' }, 401);
    const userResponse = await github('/user', tokenData.access_token);
    if (!userResponse.ok) return json({ error: 'Could not read GitHub profile' }, 502);
    const user = await userResponse.json();
    const allowed = (env.ALLOWED_GITHUB_LOGINS || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    if (allowed.length && !allowed.includes(user.login?.toLowerCase()))
      return json({ error: 'This private deployment is restricted to its owner.' }, 403);
    const id = crypto.randomUUID();
    const scopes = (tokenData.scope || userResponse.headers.get('X-OAuth-Scopes') || '')
      .split(/[, ]+/)
      .filter(Boolean);
    await authObject(env, id).fetch('https://internal/auth/put', {
      method: 'POST',
      body: JSON.stringify({
        token: tokenData.access_token,
        scopes,
        githubConnected: scopes.includes('repo'),
        user: { id: user.id, login: user.login },
        expiresAt: Date.now() + 30 * 86400000,
      }),
    });
    // Remember this sign-in on the user's index, so deleting the account can
    // end every device's sign-in, not only the current one.
    await env.PROBE.getByName('index:' + user.id).fetch('https://internal/logins/add', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
    return new Response(null, {
      status: 302,
      headers: { Location: '/', 'Set-Cookie': sessionCookie(id), ...SECURITY },
    });
  }
  if (url.pathname === '/auth/logout') {
    const id = cookie(request, COOKIE);
    if (/^[0-9a-f-]{36}$/.test(id))
      await authObject(env, id).fetch('https://internal/auth/delete', { method: 'POST' });
    return new Response(null, {
      status: 302,
      headers: { Location: '/', 'Set-Cookie': sessionCookie('', 0), ...SECURITY },
    });
  }
  return null;
}
