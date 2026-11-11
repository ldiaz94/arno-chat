/** The signed-in /api/* routes except those of one conversation
 * (sessions-api.mjs): account settings and keys, MCP and sandbox set-up, the
 * model list, GitHub repositories, usage, the image proxy, and chat and
 * coding-session creation. apiRoutes maps "METHOD /path" (or "* /path" for
 * any method) to a handler (request, env, url, auth); worker.js looks the
 * request up in it after signing the user in.
 *
 * Depends on http.mjs, auth.mjs, models.mjs, account.mjs, providers.mjs,
 * push.mjs, sessions-api.mjs, gateways/mcp.mjs, gateways/mcp-oauth.mjs,
 * code/sandbox.mjs and chat/research.mjs. Leaves out sign-in itself
 * (worker.js, auth.mjs) and everything under /api/sessions/<id>/. */
import { COOKIE, SECURITY, json, boundedJson, cookie, sessionCookie } from './http.mjs';
import { github, authObject } from './auth.mjs';
import { catalog, modelAllowed, seesScreenshots } from './models.mjs';
import { profile, credential, accountRoute } from './account.mjs';
import { PROVIDERS, providerModels, providerModel, effortModel } from './providers.mjs';
import { testMcp } from './gateways/mcp.mjs';
import { startSignIn, mcpBearer } from './gateways/mcp-oauth.mjs';
import { sandboxRoute } from './code/sandbox.mjs';
import { publicWebUrl } from './chat/research.mjs';
import { pushApiRoutes } from './push.mjs';
import { githubOf } from './sessions-api.mjs';

/** The raster image types the proxy passes on (never SVG, which can script). */
const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp|avif)$/;
/** Largest image the proxy will read, in bytes. */
const IMAGE_LIMIT = 8 * 1024 * 1024;

/** Fetch a public image for the viewer so third-party hosts never see them.
 * Follows at most three redirects, re-checking each target (SSRF); only
 * raster types pass (never SVG); the body is capped at 8 MB. */
export async function proxyImage(target, upstream = fetch) {
  if (target.length > 2000 || !publicWebUrl(target))
    return json({ error: 'Invalid image URL' }, 400);
  let response;
  for (let hops = 0; ; hops++) {
    try {
      response = await upstream(target, {
        redirect: 'manual',
        headers: { 'User-Agent': 'ArnoChat-ImageProxy/1', Accept: 'image/*' },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      return json({ error: 'Image fetch failed' }, 502);
    }
    const location = response.headers.get('Location');
    if (response.status < 300 || response.status >= 400 || !location) break;
    await response.body?.cancel();
    target = new URL(location, target).href;
    if (hops === 3 || !publicWebUrl(target)) return json({ error: 'Invalid image redirect' }, 400);
  }
  if (!response.ok) return json({ error: 'Image fetch failed' }, 502);
  const type = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPE.test(type)) {
    await response.body?.cancel();
    return json({ error: 'Not a supported image' }, 415);
  }
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > IMAGE_LIMIT) {
        await reader.cancel();
        return json({ error: 'Image is too large' }, 502);
      }
      chunks.push(value);
    }
  } catch {
    return json({ error: 'Image fetch failed' }, 502);
  }
  return new Response(new Blob(chunks), {
    headers: {
      ...SECURITY,
      'Content-Type': type,
      'Cache-Control': 'private, max-age=86400',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}

/** Shared handler of the /api/account settings routes: GET reads, POST saves
 * (account.mjs does the work and picks the action from the path). */
async function account(request, env, url, auth) {
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Unsupported method' }, 405);
  const r = await accountRoute(request, env, auth.user.id);
  return new Response(r.body, {
    status: r.status,
    headers: { 'Content-Type': 'application/json', ...SECURITY },
  });
}

/** The route table: "METHOD /path" (or "* /path") to handler. */
export const apiRoutes = {
  ...pushApiRoutes,
  /** An image fetched for the viewer: see proxyImage. */
  async 'GET /api/image'(request, env, url) {
    return proxyImage(url.searchParams.get('url') || '');
  },
  /** Tests a saved MCP connection (with its token or OAuth sign-in) and
   * returns what testMcp reports. */
  async 'POST /api/account/mcp-test'(request, env, url, auth) {
    const { id } = await boundedJson(request),
      p = await profile(env, auth.user.id),
      connection = p.mcp?.find(c => c.id === id);
    if (!connection) return json({ error: 'Save this MCP connection first' }, 400);
    try {
      return json(await testMcp(connection, await mcpBearer(env, auth.user.id, connection)));
    } catch (e) {
      return json({ error: e.message }, 400);
    }
  },
  /** Starts an OAuth sign-in to a saved MCP connection: where to send the browser. */
  async 'POST /api/account/mcp-oauth'(request, env, url, auth) {
    const { id } = await boundedJson(request);
    try {
      return json({ url: await startSignIn(env, auth.user.id, String(id || ''), url.origin) });
    } catch (e) {
      return json({ error: e.message }, 400);
    }
  },
  /** Sandbox settings and tests (code/sandbox.mjs). */
  async 'POST /api/account/sandbox'(request, env, url, auth) {
    return sandboxRoute(request, env, auth.user.id);
  },
  // The profile and its settings, provider keys and tests, and SearXNG.
  '* /api/account': account,
  '* /api/account/key': account,
  '* /api/account/test': account,
  '* /api/account/search': account,
  '* /api/account/search-test': account,
  /** Delete the account: every conversation (transcripts, attachments,
   * artifacts, workspaces), the profile with its keys and connections, push
   * subscriptions, the request log, and every recorded sign-in. The body must
   * name the account's GitHub login, so it can't happen by accident. */
  async 'POST /api/account/delete'(request, env, url, auth) {
    const { confirm } = await boundedJson(request);
    if (String(confirm || '').toLowerCase() !== auth.user.login.toLowerCase())
      return json({ error: 'Type your GitHub username to confirm' }, 400);
    const index = env.PROBE.getByName('index:' + auth.user.id);
    const { sessions, logins } = await (
      await index.fetch('https://internal/account/wipe', { method: 'POST' })
    ).json();
    await Promise.all(
      sessions.map(id =>
        env.PROBE.getByName('code:' + auth.user.id + ':' + id).fetch(
          'https://internal/session/wipe',
          { method: 'POST' },
        ),
      ),
    );
    const current = cookie(request, COOKIE);
    await Promise.all(
      [...new Set([...logins, ...(current ? [current] : [])])].map(id =>
        authObject(env, id).fetch('https://internal/auth/delete', { method: 'POST' }),
      ),
    );
    console.log(JSON.stringify({ event: 'account_deleted', sessions: sessions.length }));
    return new Response(JSON.stringify({ deleted: true }), {
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': sessionCookie('', 0),
        ...SECURITY,
      },
    });
  },
  /** The profile picture: PNG, JPEG or WebP up to 256 KB, kept on the index. */
  async '* /api/account/avatar'(request, env, url, auth) {
    const index = env.PROBE.getByName('index:' + auth.user.id);
    if (request.method === 'GET') return index.fetch('https://internal/avatar');
    if (request.method === 'DELETE')
      return index.fetch('https://internal/avatar', { method: 'DELETE' });
    if (request.method !== 'PUT') return json({ error: 'Unsupported method' }, 405);
    const type = (request.headers.get('Content-Type') || '').split(';')[0].trim();
    if (!/^image\/(png|jpeg|webp)$/.test(type))
      return json({ error: 'Use a PNG, JPEG or WebP image' }, 415);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 256 * 1024)
      return json({ error: 'Pictures are limited to 256 KB' }, 413);
    await index.fetch('https://internal/avatar', {
      method: 'PUT',
      headers: { 'Content-Type': type },
      body: bytes,
    });
    return new Response(null, { status: 204 });
  },
  /** Creates a chat (a conversation without a repository) and lists it. */
  async 'POST /api/chats'(request, env, url, auth) {
    // A client may name the id (a chat made offline does), which makes a retried
    // create return the same chat instead of making a second one.
    const body = await boundedJson(request),
      model = body.model,
      id = /^[0-9a-f-]{36}$/.test(body.id || '') ? body.id : crypto.randomUUID();
    const object = env.PROBE.getByName('code:' + auth.user.id + ':' + id);
    const r = await object.fetch('https://internal/session/chat-init', {
      method: 'POST',
      body: JSON.stringify({ model, ownerId: auth.user.id, id }),
    });
    const meta = await r.json();
    if (!r.ok) return json(meta, r.status);
    await env.PROBE.getByName('index:' + auth.user.id).fetch('https://internal/index/add', {
      method: 'POST',
      body: JSON.stringify({ id, ...meta }),
    });
    return json({ id, ...meta }, 201);
  },
  /** The owner's log of inference requests, from their index object. */
  async 'GET /api/usage/requests'(request, env, url, auth) {
    return env.PROBE.getByName('index:' + auth.user.id).fetch('https://internal/usage/list');
  },
  /** Ollama's own account data, read with the key this user's requests use:
   * the included balance and 7 days of spend per model. Both endpoints are
   * undocumented (Ollama's usage page uses them), so failure is expected. */
  async 'GET /api/usage/ollama'(request, env, url, auth) {
    const p = await profile(env, auth.user.id),
      key = await credential(env, auth.user.id, p, 'ollama');
    if (!key) return json({ error: 'No Ollama key' }, 404);
    const get = async path => {
      const r = await fetch('https://ollama.com' + path, {
        headers: { Authorization: 'Bearer ' + key },
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw Error('Ollama returned ' + r.status);
      return r.json();
    };
    try {
      const [balance, usage] = await Promise.all([
        get('/api/balance').catch(() => null),
        get('/api/usage?group_by=model'),
      ]);
      return json({ balance, usage, source: p.keys?.ollama ? 'account' : 'deployment' });
    } catch (e) {
      return json({ error: 'Ollama usage is unavailable: ' + e.message }, 502);
    }
  },
  /** What the GitHub connection can see, for Developer mode: the token's kind
   * and scopes, the account's own counts, what /user/repos lists by owner and
   * visibility, organisations, and (for GitHub App tokens) installations. */
  async 'GET /api/github/check'(request, env, url, auth) {
    const get = async path => {
      const r = await github(path, auth.token);
      return { r, data: r.ok ? await r.json() : null };
    };
    const me = await get('/user'),
      repos = [];
    for (let page = 1; page <= 20; page++) {
      const { data } = await get(
        '/user/repos?per_page=100&page=' +
          page +
          '&affiliation=owner,collaborator,organization_member',
      );
      if (!data?.length) break;
      repos.push(...data);
      if (data.length < 100) break;
    }
    const count = key => repos.reduce((m, r) => ((m[key(r)] = (m[key(r)] || 0) + 1), m), {});
    const orgs = await get('/user/orgs'),
      installs = await get('/user/installations');
    return json({
      tokenKind: /^ghu_/.test(auth.token)
        ? 'GitHub App user token'
        : /^gho_/.test(auth.token)
          ? 'OAuth App token'
          : 'other',
      scopes: me.r.headers.get('X-OAuth-Scopes'),
      account: me.data && {
        login: me.data.login,
        publicRepos: me.data.public_repos,
        ownedPrivateRepos: me.data.owned_private_repos ?? null,
        totalPrivateRepos: me.data.total_private_repos ?? null,
      },
      listed: repos.length,
      byOwner: count(r => r.owner.login),
      byVisibility: count(r => r.visibility || (r.private ? 'private' : 'public')),
      orgs: orgs.data ? orgs.data.map(o => o.login) : 'unavailable (' + orgs.r.status + ')',
      installations: installs.data
        ? installs.data.installations.map(i => ({
            account: i.account?.login,
            repositorySelection: i.repository_selection,
          }))
        : 'not a GitHub App token (' + installs.r.status + ')',
    });
  },
  /** The model list: the shared catalogue, models listed by each provider the
   * user has a key for, and their custom models, without duplicates. */
  async 'GET /api/models'(request, env, url, auth) {
    const base = await catalog(),
      p = await profile(env, auth.user.id);
    const extra = await Promise.allSettled(
      Object.keys(PROVIDERS)
        .filter(id => id !== 'ollama' && p.keys?.[id])
        .map(async id => providerModels(id, await credential(env, auth.user.id, p, id))),
    );
    const all = [
      ...base.models,
      ...extra.filter(r => r.status === 'fulfilled').flatMap(r => r.value),
      ...(p.models || []),
    ];
    // effort: whether the thinking choice can be honoured (absent: unknown);
    // vision: whether it is shown screenshots (seesScreenshots).
    const models = await Promise.all(
      [...new Map(all.map(m => [m.id, m])).values()].map(async m => {
        const { provider, id } = providerModel(m.id);
        return provider === 'ollama'
          ? m
          : { ...m, effort: effortModel(provider, id), vision: await seesScreenshots(m.id) };
      }),
    );
    return json({ ...base, models });
  },
  /** One page of the user's GitHub repositories, filtered by the search text
   * q (a pasted repository URL also works), with what the token can access. */
  async 'GET /api/repos'(request, env, url, auth) {
    const page = Math.max(1, Math.min(10000, Number(url.searchParams.get('page')) || 1));
    const query = (url.searchParams.get('q') || '')
      .trim()
      .replace(/^https?:\/\/github.com\//i, '')
      .replace(/\.git\/?$/, '')
      .replace(/\/$/, '')
      .toLowerCase()
      .slice(0, 100);
    const response = await github(
      '/user/repos?per_page=100&page=' +
        page +
        '&sort=updated&affiliation=owner,collaborator,organization_member',
      auth.token,
    );
    if (!response.ok) return json({ error: 'GitHub rejected the repository request' }, 502);
    const raw = await response.json();
    const pageLength = raw.length;
    // A known URL can be opened even if an organization omits it from the
    // user's listing. GitHub still enforces authorization on this lookup.
    if (
      page === 1 &&
      /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(query) &&
      !raw.some(r => r.full_name.toLowerCase() === query)
    ) {
      const direct = await github('/repos/' + query, auth.token);
      if (direct.ok) raw.push(await direct.json());
    }
    const repos = raw.map(
      ({
        full_name,
        private: isPrivate,
        default_branch,
        archived,
        description,
        language,
        updated_at,
      }) => ({
        full_name,
        private: isPrivate,
        default_branch,
        archived,
        description,
        language,
        updated_at,
      }),
    );
    const scopes = response.headers.get('X-OAuth-Scopes') || null;
    const sso = response.headers.get('X-GitHub-SSO') || null;
    return json({
      repos: repos.filter(r =>
        (r.full_name + ' ' + (r.description || '')).toLowerCase().includes(query),
      ),
      scanned: pageLength,
      access: {
        connectionType: auth.token.startsWith('ghu_') ? 'github-app' : 'oauth',
        scopes,
        privateAccess:
          raw.some(r => r.private) ||
          (scopes ? scopes.split(/[, ]+/).includes('repo') : (auth.githubConnected ?? null)),
        ssoRequired: !!sso,
      },
      nextPage:
        response.headers.get('Link')?.includes('rel="next"') || pageLength === 100
          ? page + 1
          : null,
    });
  },
  /** The owner's list of conversations, from their index object. */
  async 'GET /api/sessions'(request, env, url, auth) {
    return env.PROBE.getByName('index:' + auth.user.id).fetch('https://internal/index/list');
  },
  /** Every artifact of the owner's conversations, newest first, each with its
   * conversation: from the summaries the index keeps; a conversation listed
   * before they were kept is asked once, which lists it again with them. */
  async 'GET /api/artifacts'(request, env, url, auth) {
    const index = env.PROBE.getByName('index:' + auth.user.id);
    let { sessions } = await (await index.fetch('https://internal/index/list')).json();
    const unknown = sessions.filter(s => !s.artifacts).slice(0, 100);
    if (unknown.length) {
      await Promise.allSettled(
        unknown.map(s =>
          env.PROBE.getByName('code:' + auth.user.id + ':' + s.id).fetch(
            'https://internal/artifacts',
          ),
        ),
      );
      ({ sessions } = await (await index.fetch('https://internal/index/list')).json());
    }
    const artifacts = sessions.flatMap(s =>
      Object.values(s.artifacts || {}).map(a => ({
        ...a,
        sessionId: s.id,
        sessionTitle: s.title || s.repo || 'Conversation',
        sessionKind: s.kind,
      })),
    );
    return json({ artifacts: artifacts.sort((a, b) => b.updatedAt - a.updatedAt) });
  },
  /** Creates a coding session: checks the repository, ref and model, pins the
   * ref to a commit, starts the session's object and lists it. */
  async 'POST /api/sessions'(request, env, url, auth) {
    const body = await boundedJson(request);
    if (
      typeof body.repo !== 'string' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(body.repo) ||
      typeof body.ref !== 'string' ||
      body.ref.length > 200 ||
      !(await modelAllowed(body.model))
    )
      return json({ error: 'Invalid repository or model' }, 400);
    const [owner, repo] = body.repo.split('/');
    const revision = await github(
      '/repos/' +
        encodeURIComponent(owner) +
        '/' +
        encodeURIComponent(repo) +
        '/commits/' +
        encodeURIComponent(body.ref),
      auth.token,
    );
    if (!revision.ok) return json({ error: 'Could not resolve repository revision' }, 502);
    const { sha } = await revision.json();
    if (!/^[a-f0-9]{40}$/.test(sha)) return json({ error: 'Invalid repository revision' }, 502);
    // The extra repositories remembered for this one (code/extras.mjs), at
    // their default branches; one GitHub no longer has is left out.
    const index = env.PROBE.getByName('index:' + auth.user.id),
      { companions } = await (await index.fetch('https://internal/companions')).json(),
      extras = [];
    for (const extra of companions[body.repo] || []) {
      const found = await github('/repos/' + extra, auth.token);
      if (found.ok) extras.push({ repo: extra, ref: (await found.json()).default_branch });
    }
    const id = crypto.randomUUID();
    const object = env.PROBE.getByName(`code:${auth.user.id}:${id}`);
    const initialized = await object.fetch('https://internal/session/init', {
      method: 'POST',
      headers: {
        'X-Arno-Repo': body.repo,
        'X-Arno-Ref': body.ref,
        'X-Arno-Model': body.model,
        'X-Arno-Sha': sha,
        'X-Arno-Owner': String(auth.user.id),
        'X-Arno-GitHub': JSON.stringify(githubOf(auth)),
        'X-Arno-Extras': JSON.stringify(extras),
      },
    });
    const result = await initialized.json();
    if (!initialized.ok)
      return json({ error: result.error || 'Could not create workspace' }, initialized.status);
    await env.PROBE.getByName('index:' + auth.user.id).fetch('https://internal/index/add', {
      method: 'POST',
      body: JSON.stringify({ id, ...result }),
    });
    return json({ id, ...result }, 201);
  },
};
