/** The signed-in /api/* routes. apiRoutes maps "METHOD /path" (or "* /path")
 * to a handler (request, env, url, auth); sessionPaths tries, in order, the
 * routes under /api/sessions/<id>/ and returns null when none matches. */
import { SECURITY, MAX_ARCHIVE, json, boundedJson } from './http.mjs';
import { github } from './auth.mjs';
import { catalog, modelAllowed } from './models.mjs';
import { validateFiles } from './publish.mjs';
import { profile, credential, providerModels, accountRoute, unseal } from './account.mjs';
import { testMcp } from './mcp.mjs';
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
      return json(
        await testMcp(connection, await unseal(env, auth.user.id, 'mcp:' + id, connection.token)),
      );
    } catch (e) {
      return json({ error: e.message }, 400);
    }
  },
  '* /api/account': account,
  '* /api/account/key': account,
  '* /api/account/test': account,
  async 'POST /api/chats'(request, env, url, auth) {
    const { model } = await boundedJson(request),
      id = crypto.randomUUID();
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
  async 'GET /api/models'(request, env, url, auth) {
    const base = await catalog(),
      p = await profile(env, auth.user.id);
    const extra = await Promise.allSettled(
      ['openai', 'anthropic', 'gemini']
        .filter(id => p.keys?.[id])
        .map(async id => providerModels(id, await credential(env, auth.user.id, p, id))),
    );
    const all = [
      ...base.models,
      ...extra.filter(r => r.status === 'fulfilled').flatMap(r => r.value),
      ...(p.models || []),
    ];
    return json({ ...base, models: [...new Map(all.map(m => [m.id, m])).values()] });
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
    const archive = await github(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${sha}`,
      auth.token,
    );
    if (!archive.ok || !archive.body)
      return json({ error: 'Could not download repository from GitHub' }, 502);
    const length = Number(archive.headers.get('Content-Length') || 0);
    if (length > MAX_ARCHIVE) {
      await archive.body.cancel();
      return json({ error: 'Repository archive is larger than 50 MB' }, 413);
    }
    let received = 0;
    const limitedBody = archive.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > MAX_ARCHIVE) throw new Error('Repository archive is larger than 50 MB');
          controller.enqueue(chunk);
        },
      }),
    );
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
      },
      body: limitedBody,
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

export async function sessionPaths(request, env, url, auth) {
  const fileMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/files$/);
  if (fileMatch && request.method === 'GET')
    return env.PROBE.getByName('code:' + auth.user.id + ':' + fileMatch[1]).fetch(
      'https://internal/session/files?path=' +
        encodeURIComponent(url.searchParams.get('path') || ''),
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
      body: JSON.stringify({ ownerId: auth.user.id, id: match[1] }),
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
