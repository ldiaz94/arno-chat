/** The signed-in /api/* routes. apiRoutes maps "METHOD /path" (or "* /path")
 * to a handler (request, env, url, auth); sessionPaths tries, in order, the
 * routes under /api/sessions/<id>/ and returns null when none matches. */
import { COOKIE, SECURITY, json, boundedJson, cookie, sessionCookie } from './http.mjs';
import { github, authObject } from './auth.mjs';
import { catalog, modelAllowed } from './models.mjs';
import { validateFiles } from './publish.mjs';
import {
  PROVIDERS,
  profile,
  credential,
  providerModels,
  providerModel,
  effortModel,
  accountRoute,
} from './account.mjs';
import { testMcp } from './mcp.mjs';
import { startSignIn, mcpBearer } from './mcp-oauth.mjs';
import { sandboxRoute } from './sandbox.mjs';
import { publicWebUrl } from './web.mjs';
import { pushApiRoutes } from './push.mjs';
import { LIMITS } from './attachments.mjs';

const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp|avif)$/;
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

async function account(request, env, url, auth) {
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Unsupported method' }, 405);
  const r = await accountRoute(request, env, auth.user.id);
  return new Response(r.body, {
    status: r.status,
    headers: { 'Content-Type': 'application/json', ...SECURITY },
  });
}

export const apiRoutes = {
  ...pushApiRoutes,
  async 'GET /api/image'(request, env, url) {
    return proxyImage(url.searchParams.get('url') || '');
  },
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
  async 'POST /api/account/sandbox'(request, env, url, auth) {
    return sandboxRoute(request, env, auth.user.id);
  },
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
    // effort: whether the thinking choice can be honoured (absent: unknown).
    const models = [...new Map(all.map(m => [m.id, m])).values()].map(m => {
      const { provider, id } = providerModel(m.id);
      return provider === 'ollama' ? m : { ...m, effort: effortModel(provider, id) };
    });
    return json({ ...base, models });
  },
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
  async 'GET /api/sessions'(request, env, url, auth) {
    return env.PROBE.getByName('index:' + auth.user.id).fetch('https://internal/index/list');
  },
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

/** The sign-in a coding session fetches and pushes with: the token, and the
 * name and noreply address its commits are made under. */
function githubOf(auth) {
  const { id, login } = auth.user;
  return { token: auth.token, login, email: id + '+' + login + '@users.noreply.github.com' };
}
export async function sessionPaths(request, env, url, auth) {
  const fileMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/files$/);
  if (fileMatch && request.method === 'GET')
    return env.PROBE.getByName('code:' + auth.user.id + ':' + fileMatch[1]).fetch(
      'https://internal/session/files?path=' +
        encodeURIComponent(url.searchParams.get('path') || ''),
    );
  const gitMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/(history|commit)$/);
  if (gitMatch && request.method === 'GET')
    return env.PROBE.getByName('code:' + auth.user.id + ':' + gitMatch[1]).fetch(
      'https://internal/session/' +
        gitMatch[2] +
        (gitMatch[2] === 'commit'
          ? '?sha=' + encodeURIComponent(url.searchParams.get('sha') || '')
          : ''),
    );
  const cancelMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/cancel$/);
  if (cancelMatch && request.method === 'POST')
    return env.PROBE.getByName('code:' + auth.user.id + ':' + cancelMatch[1]).fetch(
      'https://internal/session/cancel',
      { method: 'POST' },
    );
  const publishMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/(changes|publish)$/);
  if (
    publishMatch &&
    ((publishMatch[2] === 'changes' && request.method === 'GET') ||
      (publishMatch[2] === 'publish' && request.method === 'POST'))
  ) {
    const object = env.PROBE.getByName('code:' + auth.user.id + ':' + publishMatch[1]);
    const r = await object.fetch('https://internal/session/changes');
    if (!r.ok) return r;
    const changes = await r.json(),
      files = validateFiles(changes.files);
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(JSON.stringify({ files, sourceSha: changes.sourceSha })),
        ),
      ),
    )
      .map(n => n.toString(16).padStart(2, '0'))
      .join('');
    if (request.method === 'GET')
      return json({
        ...changes,
        digest,
        files: files.map(f => ({
          ...f,
          bytes: f.content ? new TextEncoder().encode(f.content).length : 0,
        })),
      });
    const body = await boundedJson(request);
    if (body.digest !== digest)
      return json(
        { error: 'Changes have changed since review. Review them again before publishing.' },
        409,
      );
    if (
      typeof body.branch !== 'string' ||
      !/^arno\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,70}$/.test(body.branch) ||
      typeof body.title !== 'string' ||
      !body.title.trim() ||
      body.title.length > 200
    )
      return json(
        { error: 'Use an arno/branch-name and a commit title up to 200 characters' },
        400,
      );
    const prefix = '/repos/' + changes.repo;
    const call = async (path, method = 'GET', data) => {
      const r = await github(prefix + path, auth.token, {
        method,
        ...(data
          ? { body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } }
          : {}),
      });
      if (!r.ok)
        throw Error(
          'GitHub rejected publishing (' +
            r.status +
            '). A branch may already exist; check GitHub before retrying.',
        );
      return r.json();
    };
    const base = await call('/git/commits/' + changes.sourceSha);
    const tree = await call('/git/trees', 'POST', {
      base_tree: base.tree.sha,
      tree: files.map(f => ({
        path: f.path,
        mode: f.mode || '100644',
        type: 'blob',
        ...(f.deleted ? { sha: null } : { content: f.content }),
      })),
    });
    const commit = await call('/git/commits', 'POST', {
      message: body.title.trim(),
      tree: tree.sha,
      parents: [changes.sourceSha],
    });
    await call('/git/refs', 'POST', { ref: 'refs/heads/' + body.branch, sha: commit.sha });
    let prUrl = null,
      warning = null;
    try {
      const pr = await call('/pulls', 'POST', {
        title: body.title.trim(),
        head: body.branch,
        base: changes.ref,
        body: 'Changes prepared with Arno Chat.\n\nBase revision: ' + changes.sourceSha,
      });
      prUrl = pr.html_url;
    } catch {
      warning = 'Branch created, but the pull request could not be opened. Open it on GitHub.';
    }
    return json({
      branch: body.branch,
      commit: commit.sha,
      url: prUrl || 'https://github.com/' + changes.repo + '/tree/' + body.branch,
      warning,
    });
  }
  const modelMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/model$/);
  if (modelMatch && request.method === 'POST') {
    const body = await boundedJson(request);
    return env.PROBE.getByName('code:' + auth.user.id + ':' + modelMatch[1]).fetch(
      'https://internal/session/model',
      { method: 'POST', body: JSON.stringify(body) },
    );
  }
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})$/);
  if (sessionMatch && ['PATCH', 'DELETE'].includes(request.method)) {
    const id = sessionMatch[1],
      object = env.PROBE.getByName('code:' + auth.user.id + ':' + id);
    if (request.method === 'PATCH') {
      const body = await boundedJson(request),
        r = await object.fetch('https://internal/session/rename', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      const meta = await r.json();
      if (!r.ok) return json(meta, r.status);
      await env.PROBE.getByName('index:' + auth.user.id).fetch('https://internal/index/add', {
        method: 'POST',
        body: JSON.stringify({ id, ...meta }),
      });
      return json({ id, ...meta });
    }
    const r = await object.fetch('https://internal/session/delete', { method: 'POST' });
    if (!r.ok) return r;
    await env.PROBE.getByName('index:' + auth.user.id).fetch('https://internal/index/remove', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
    return json({ deleted: true });
  }
  if (sessionMatch && request.method === 'GET') {
    return env.PROBE.getByName('code:' + auth.user.id + ':' + sessionMatch[1]).fetch(
      'https://internal/session/get',
    );
  }
  // Attachments: upload (the body streams through to the session object, which
  // checks type and size again) and download.
  const uploadMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/attachments$/);
  if (uploadMatch && request.method === 'POST') {
    if (Number(request.headers.get('Content-Length') || Infinity) > LIMITS.image)
      return json({ error: 'Attachments are limited to ' + LIMITS.image / 1048576 + ' MB' }, 413);
    return env.PROBE.getByName('code:' + auth.user.id + ':' + uploadMatch[1]).fetch(
      'https://internal/attachments',
      {
        method: 'POST',
        body: request.body,
        headers: {
          'Content-Type': request.headers.get('Content-Type') || '',
          'X-Filename': request.headers.get('X-Filename') || 'file',
        },
      },
    );
  }
  const attachmentMatch = url.pathname.match(
    /^\/api\/sessions\/([0-9a-f-]{36})\/attachments\/([0-9a-f-]{36})$/,
  );
  if (attachmentMatch && request.method === 'GET')
    return env.PROBE.getByName('code:' + auth.user.id + ':' + attachmentMatch[1]).fetch(
      'https://internal/attachments/get?id=' + attachmentMatch[2],
    );
  const artifactMatch = url.pathname.match(
    /^\/api\/sessions\/([0-9a-f-]{36})\/artifacts(?:\/([0-9a-f-]{36}))?$/,
  );
  if (artifactMatch && request.method === 'GET')
    return env.PROBE.getByName('code:' + auth.user.id + ':' + artifactMatch[1]).fetch(
      'https://internal/artifacts' + (artifactMatch[2] ? '/get?id=' + artifactMatch[2] : ''),
    );
  const match = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/messages$/);
  const jobMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/job$/);
  if (jobMatch && request.method === 'GET')
    return env.PROBE.getByName('code:' + auth.user.id + ':' + jobMatch[1]).fetch(
      'https://internal/session/job',
    );
  const eventsMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/events$/);
  if (eventsMatch && request.method === 'GET')
    return env.PROBE.getByName('code:' + auth.user.id + ':' + eventsMatch[1]).fetch(
      'https://internal/session/events',
    );
  if (match && request.method === 'POST') {
    const body = await boundedJson(request);
    const object = env.PROBE.getByName(`code:${auth.user.id}:${match[1]}`);
    await object.fetch('https://internal/session/owner', {
      method: 'POST',
      body: JSON.stringify({ ownerId: auth.user.id, id: match[1], github: githubOf(auth) }),
    });
    const response = await object.fetch('https://internal/session/enqueue', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return new Response(response.body, {
      status: response.status,
      headers: { 'Content-Type': 'application/json', ...SECURITY },
    });
  }
  return null;
}
