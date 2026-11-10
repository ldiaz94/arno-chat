/** Signing in to a remote MCP server with OAuth, as the MCP authorization spec
 * (2025-06-18) has it, for servers that take no pasted token:
 *
 *   1. discover   the server answers an unsigned request with 401 and a
 *                 WWW-Authenticate naming its protected-resource metadata
 *                 (RFC 9728), which names its authorization server, whose own
 *                 metadata (RFC 8414) gives the endpoints. A server of the
 *                 older 2025-03-26 spec is its own authorization server.
 *   2. register   the app registers itself (RFC 7591), a public client with
 *                 our callback, since no server knows it in advance.
 *   3. authorize  the browser goes to the authorization server with PKCE
 *                 (S256) and the server's URL as the resource (RFC 8707).
 *   4. callback   /auth/mcp/callback trades the code for tokens, which are
 *                 sealed into the connection; refreshed before they expire.
 *
 * The pending sign-in waits ten minutes in an 'auth:<state>' object; state is
 * a random UUID used once, and names the account it is for. Depends on
 * account.mjs (the profile), secrets.mjs (sealing), chat/research.mjs (public
 * URL check) and http.mjs (security headers). Leaves out
 * servers that need a pre-registered client: those take a pasted token. */
import { profile } from '../account.mjs';
import { seal, unseal } from '../secrets.mjs';
import { publicWebUrl } from '../chat/research.mjs';
import { SECURITY } from '../http.mjs';

/** Where the authorization server sends the browser back. */
const CALLBACK = '/auth/mcp/callback';
/** Text to bytes, for hashing. */
const enc = new TextEncoder();
/** Bytes as unpadded URL-safe base64, as PKCE and state values need. */
const b64url = bytes =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

// An https URL on the public web, the only kind discovery may follow.
const httpsPublic = u => typeof u === 'string' && u.startsWith('https://') && publicWebUrl(u);

/** A JSON metadata document from a public https URL, or null. */
async function metadata(url) {
  if (!httpsPublic(url)) return null;
  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json', 'MCP-Protocol-Version': '2025-06-18' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Where the MCP server at mcpUrl has its sign-in: the resource to ask for,
 * the scope it wants, and its authorization server's metadata. */
export async function discover(mcpUrl) {
  const u = new URL(mcpUrl);
  let header;
  try {
    const r = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'arno-chat', version: '1' },
        },
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    await r.body?.cancel();
    header = r.headers.get('WWW-Authenticate') || '';
  } catch {
    header = '';
  }
  const named = /resource_metadata="([^"]+)"/.exec(header)?.[1],
    path = u.pathname.replace(/\/$/, '');
  let resource = null;
  for (const at of [
    named,
    u.origin + '/.well-known/oauth-protected-resource' + path,
    u.origin + '/.well-known/oauth-protected-resource',
  ])
    if (at && (resource = await metadata(at))?.authorization_servers?.length) break;
  const issuer = resource?.authorization_servers?.[0] || u.origin,
    iu = new URL(issuer),
    ipath = iu.pathname.replace(/\/$/, '');
  let server = null;
  for (const at of ipath
    ? [
        iu.origin + '/.well-known/oauth-authorization-server' + ipath,
        iu.origin + '/.well-known/openid-configuration' + ipath,
        iu.origin + ipath + '/.well-known/openid-configuration',
      ]
    : [
        iu.origin + '/.well-known/oauth-authorization-server',
        iu.origin + '/.well-known/openid-configuration',
      ])
    if ((server = await metadata(at))?.authorization_endpoint) break;
  // The 2025-03-26 spec's defaults, for a server that publishes no metadata.
  if (!server?.authorization_endpoint && !resource)
    server = {
      authorization_endpoint: u.origin + '/authorize',
      token_endpoint: u.origin + '/token',
      registration_endpoint: u.origin + '/register',
    };
  if (
    !httpsPublic(server?.authorization_endpoint) ||
    !httpsPublic(server?.token_endpoint) ||
    (server.code_challenge_methods_supported &&
      !server.code_challenge_methods_supported.includes('S256'))
  )
    throw Error('This MCP server does not offer an OAuth sign-in the app can use');
  return {
    resource: resource?.resource || mcpUrl,
    scope:
      /scope="([^"]+)"/.exec(header)?.[1] || (resource?.scopes_supported || []).join(' ') || '',
    server,
  };
}

/** Registers the app with the authorization server: its client id (and
 * secret, if the server hands one out). */
async function register(server, redirect) {
  if (!httpsPublic(server.registration_endpoint))
    throw Error('This MCP server needs a client registered by hand; paste a token instead');
  const r = await fetch(server.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Arno Chat',
      redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  const d = r.ok ? await r.json().catch(() => null) : null;
  if (!d?.client_id) throw Error('The MCP server refused to register the app (' + r.status + ')');
  return { clientId: d.client_id, clientSecret: d.client_secret || '' };
}

/** Starts a sign-in for the saved connection id: the URL to send the browser
 * to. origin is this app's, for the callback. */
export async function startSignIn(env, userId, id, origin) {
  const connection = (await profile(env, userId)).mcp?.find(c => c.id === id);
  if (!connection) throw Error('Save this MCP connection first');
  const { resource, scope, server } = await discover(connection.url),
    redirect = origin + CALLBACK,
    client = await register(server, redirect),
    verifier = b64url(crypto.getRandomValues(new Uint8Array(32))),
    challenge = b64url(await crypto.subtle.digest('SHA-256', enc.encode(verifier))),
    state = crypto.randomUUID();
  await env.PROBE.getByName('auth:' + state).fetch('https://internal/oauth/put', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'mcp',
      userId,
      id,
      url: connection.url,
      verifier,
      redirect,
      resource,
      tokenEndpoint: server.token_endpoint,
      ...client,
    }),
  });
  const to = new URL(server.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource,
    ...(scope && { scope }),
  }))
    to.searchParams.set(k, v);
  return to.toString();
}

/** Asks the token endpoint for tokens: a code's, or a refresh token's. */
async function tokens(grant, form) {
  const body = new URLSearchParams({
    client_id: grant.clientId,
    resource: grant.resource,
    ...form,
  });
  if (grant.clientSecret) body.set('client_secret', grant.clientSecret);
  const r = await fetch(grant.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  const d = r.ok ? await r.json().catch(() => null) : null;
  if (!d?.access_token) throw Error('The MCP server refused the sign-in (' + r.status + ')');
  return {
    oauth: true,
    access: d.access_token,
    refresh: d.refresh_token || form.refresh_token || '',
    expiresAt: d.expires_in ? Date.now() + d.expires_in * 1000 : 0,
    tokenEndpoint: grant.tokenEndpoint,
    clientId: grant.clientId,
    clientSecret: grant.clientSecret,
    resource: grant.resource,
  };
}

/** Keeps a connection's sealed token, if its URL is still the one signed in to. */
async function keep(env, userId, id, url, record) {
  await env.PROBE.getByName('profile:' + userId).fetch('https://internal/profile/mcp-token', {
    method: 'POST',
    body: JSON.stringify({
      id,
      url,
      oauth: true,
      token: await seal(env, userId, 'mcp:' + id, JSON.stringify(record)),
    }),
  });
}

/** /auth/mcp/callback: the authorization server sends the browser back here
 * with a code. The tokens are kept, and the browser goes to the MCP settings. */
export async function mcpCallback(request, env, url) {
  const back = (query, status = 302) =>
    new Response(null, { status, headers: { Location: '/?' + query, ...SECURITY } });
  const state = url.searchParams.get('state') || '';
  if (!/^[0-9a-f-]{36}$/.test(state))
    return back('mcp_error=' + encodeURIComponent('Invalid sign-in'));
  const r = await env.PROBE.getByName('auth:' + state).fetch('https://internal/oauth/take', {
    method: 'POST',
  });
  const pending = r.ok ? await r.json() : null;
  if (pending?.kind !== 'mcp')
    return back('mcp_error=' + encodeURIComponent('The sign-in expired'));
  const failed = url.searchParams.get('error');
  if (failed)
    return back(
      'mcp_error=' + encodeURIComponent(url.searchParams.get('error_description') || failed),
    );
  try {
    const record = await tokens(pending, {
      grant_type: 'authorization_code',
      code: url.searchParams.get('code') || '',
      redirect_uri: pending.redirect,
      code_verifier: pending.verifier,
    });
    await keep(env, pending.userId, pending.id, pending.url, record);
    return back('mcp=' + encodeURIComponent(pending.id));
  } catch (e) {
    return back('mcp_error=' + encodeURIComponent(e.message));
  }
}

/** The bearer token for a connection: a pasted one as it is, or a signed-in
 * one, refreshed first when it has expired or is about to. */
export async function mcpBearer(env, userId, connection) {
  const raw = await unseal(env, userId, 'mcp:' + connection.id, connection.token);
  if (!connection.oauth || !raw.startsWith('{')) return raw;
  const record = JSON.parse(raw);
  if (!record.expiresAt || record.expiresAt - 60000 > Date.now() || !record.refresh)
    return record.access;
  try {
    const fresh = await tokens(record, {
      grant_type: 'refresh_token',
      refresh_token: record.refresh,
    });
    await keep(env, userId, connection.id, connection.url, fresh);
    return fresh.access;
  } catch {
    return record.access; // the server says 401 if it is past use; sign in again then
  }
}
