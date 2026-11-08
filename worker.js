import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { modelRequest } from './gateway.mjs';
import { HTML } from './ui-v2.mjs';
import { catalog, modelAllowed } from './models.mjs';

const COOKIE = 'arno_session';
const MAX_ARCHIVE = 50 * 1024 * 1024;
const SECURITY = {
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://github.com",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cache-Control': 'no-store'
};

function json(value, status = 200) {
  return Response.json(value, { status, headers: SECURITY });
}
function cookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const item of raw.split(';')) {
    const [key, ...rest] = item.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}
function sessionCookie(value, maxAge = 2592000) {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}
async function boundedJson(request, limit = 12000) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > limit) throw new Error('Request is too large');
  const text = await request.text();
  if (text.length > limit) throw new Error('Request is too large');
  return JSON.parse(text);
}
function authObject(env, id) { return env.PROBE.getByName(`auth:${id}`); }
async function currentAuth(request, env) {
  const id = cookie(request, COOKIE);
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const response = await authObject(env, id).fetch('https://internal/auth/get');
  if (!response.ok) return null;
  return { id, ...(await response.json()) };
}
async function github(path, token, init = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    redirect: init.redirect || 'follow',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'arno-remote/0.1',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {})
    }
  });
}

export class ModelGateway extends WorkerEntrypoint {
  async fetch(request) {
    const task = this.env.PROBE.get(this.env.PROBE.idFromString(this.ctx.props.task));
    return modelRequest(request, {
      key: this.env.OLLAMA_API_KEY,
      model: this.ctx.props.model,
      authorize: async () => (await task.fetch('https://internal/model-permit', { method: 'POST' })).ok
    });
  }
}

export class ArnoProbe extends DurableObject {
  async writeConfig(model) {
    const config = `provider = ollama-cloud\nmodel = ${model}\nurl = http://model.internal/v1\nkey =\nexecution_boundary = outer-sandbox\nsafety = auto\ncontext_files = no\nproject_map = no\nmax_tokens = 4096\n`;
    const p=await this.ctx.container.exec(['tee','/workspace/config/arno/config'],{stdin:'pipe',stdout:'ignore'});
    const writer=p.stdin.getWriter();
    await writer.write(new TextEncoder().encode(config));
    await writer.close();
    if(await p.exitCode!==0)throw Error('Could not update model config');
  }
  async exec(argv, options = {}, seconds = 180) {
    const process = await this.ctx.container.exec(['timeout', '--kill-after=5', String(seconds), ...argv], options);
    const output = await process.output();
    const decode = bytes => new TextDecoder().decode(bytes);
    return { exitCode: output.exitCode, stdout: decode(output.stdout).slice(-50000), stderr: decode(output.stderr).slice(-12000) };
  }
  async start(model) {
    const container = this.ctx.container;
    if (!container.running) {
      const snapshot = await this.ctx.storage.get('snapshot');
      container.start({ ...(snapshot ? { containerSnapshot: snapshot } : { image: container.images.runner }), entrypoint: ['sleep', 'infinity'], enableInternet: false, instance: 'standard-1' });
    }
    await container.interceptOutboundHttp('model.internal', this.ctx.exports.ModelGateway({ props: { task: this.ctx.id.toString(), model } }));
    await container.setInactivityTimeout(30 * 60 * 1000);
    await this.ctx.storage.setAlarm(Date.now() + 35 * 60 * 1000);
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/session/model' && request.method === 'POST') {
      if(this.inFlight)return json({error:'Wait for the current turn to finish'},409);
      this.inFlight=true;
      try {
        const session=await this.ctx.storage.get('session');
        if(!session)return json({error:'Session not found'},404);
        const {model}=await request.json();
        if(!await modelAllowed(model))return json({error:'Unsupported model'},400);
        await this.start(model);
        await this.writeConfig(model);
        const snapshot=await this.ctx.container.snapshotContainer({});
        await this.ctx.storage.put({session:{...session,model},snapshot});
        return json({model});
      }finally{this.inFlight=false;}
    }
    if (url.pathname === '/index/list') {
      const entries = await this.ctx.storage.list({ prefix: 'session:' });
      return json({ sessions: [...entries.values()].sort((a,b) => b.createdAt-a.createdAt) });
    }
    if (url.pathname === '/index/add') {
      const entry = await request.json();
      await this.ctx.storage.put('session:' + entry.id, entry);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/session/get') {
      const meta = await this.ctx.storage.get('session');
      if (!meta) return json({error:'Session not found'},404);
      return json({...meta, history: (await this.ctx.storage.get('history')) || []});
    }
    if (url.pathname === '/auth/put' && request.method === 'POST') {
      const data = await request.json();
      await this.ctx.storage.put('auth', data);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/auth/get') {
      const auth = await this.ctx.storage.get('auth');
      if (!auth || auth.expiresAt < Date.now()) {
        if (auth) await this.ctx.storage.deleteAll();
        return new Response(null, { status: 404 });
      }
      return Response.json(auth);
    }
    if (url.pathname === '/auth/delete' && request.method === 'POST') {
      await this.ctx.storage.deleteAll();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/oauth/put' && request.method === 'POST') {
      await this.ctx.storage.put('oauth', { ...(await request.json()), expiresAt: Date.now() + 10 * 60 * 1000 });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/oauth/take' && request.method === 'POST') {
      const value = await this.ctx.storage.get('oauth');
      await this.ctx.storage.delete('oauth');
      if (!value || value.expiresAt < Date.now()) return new Response(null, { status: 404 });
      return Response.json(value);
    }
    if (url.pathname === '/model-permit' && request.method === 'POST') {
      const allowed = await this.ctx.storage.transaction(async txn => {
        const quota = await txn.get('modelQuota');
        if (!quota || quota.deadline < Date.now() || quota.used >= 16) return false;
        quota.used += 1;
        await txn.put('modelQuota', quota);
        return true;
      });
      return new Response(null, { status: allowed ? 204 : 429 });
    }
    if (url.pathname === '/session/init' && request.method === 'POST') {
      const model = request.headers.get('X-Arno-Model');
      const repo = request.headers.get('X-Arno-Repo');
      const ref = request.headers.get('X-Arno-Ref');
      if (!await modelAllowed(model) || !repo || !ref || !request.body) return json({ error: 'Invalid session' }, 400);
      await this.start(model);
      await this.exec(['sh', '-c', 'rm -rf /workspace/repo /workspace/config /workspace/data; mkdir -p /workspace/repo /workspace/config/arno /workspace/data'], {}, 30);
      const unpack = await this.exec(['tar', '-xz', '--strip-components=1', '-C', '/workspace/repo'], { stdin: request.body }, 120);
      if (unpack.exitCode !== 0) return json({ error: 'Could not unpack repository', detail: unpack.stderr }, 400);
      const config = `provider = ollama-cloud\nmodel = ${model}\nurl = http://model.internal/v1\nkey =\nexecution_boundary = outer-sandbox\nsafety = auto\ncontext_files = no\nproject_map = no\nmax_tokens = 4096\n`;
      const write = await this.ctx.container.exec(['tee', '/workspace/config/arno/config'], { stdin: 'pipe', stdout: 'ignore' });
      const writer = write.stdin.getWriter();
      await writer.write(new TextEncoder().encode(config));
      await writer.close();
      await write.exitCode;
      const baseline = await this.exec(['sh', '-c', "git init -q && git add -A && git -c user.name='Arno Remote' -c user.email='arno@localhost' commit -qm baseline"], { cwd: '/workspace/repo' }, 120);
      if (baseline.exitCode !== 0) return json({ error: 'Could not prepare git workspace', detail: baseline.stderr }, 500);
      const meta = { repo, ref, model, createdAt: Date.now() };
      await this.ctx.storage.put('session', meta);
      await this.ctx.storage.put('snapshot', await this.ctx.container.snapshotContainer({}));
      return json(meta);
    }
    if (url.pathname === '/session/run' && request.method === 'POST') {
      if (this.inFlight) return json({ error: 'Arno is already working' }, 409);
      const session = await this.ctx.storage.get('session');
      if (!session) return json({ error: 'Session not found' }, 404);
      const { prompt } = await request.json();
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000) return json({ error: 'Invalid prompt' }, 400);
      if(this.inFlight)return json({error:'Arno is already working'},409);
      this.inFlight = true;
      try {
        await this.start(session.model);
        await this.writeConfig(session.model);
        await this.ctx.storage.put('modelQuota', { used: 0, deadline: Date.now() + 4 * 60 * 1000 });
        const process = await this.ctx.container.exec(['timeout', '--kill-after=5', '240', '/usr/local/bin/arno', prompt.trim()], {
          cwd: '/workspace/repo',
          env: { XDG_CONFIG_HOME: '/workspace/config', XDG_DATA_HOME: '/workspace/data', PYTHONDONTWRITEBYTECODE: '1' },
          stdin: 'pipe'
        });
        const writer = process.stdin.getWriter();
        await writer.write(new TextEncoder().encode('y\ny\ny\n'));
        await writer.close();
        const output = await process.output();
        const decode = bytes => new TextDecoder().decode(bytes);
        const stdout = decode(output.stdout).slice(-40000);
        const stderr = decode(output.stderr).slice(-10000);
        const diffResult = await this.exec(['git', 'diff', '--', '.'], { cwd: '/workspace/repo' }, 30);
        const result = {
          exitCode: output.exitCode,
          model: session.model,
          summary: (stdout || stderr || `Arno exited with code ${output.exitCode}`).slice(-12000),
          diff: diffResult.stdout.slice(-40000)
        };
        const history = (await this.ctx.storage.get('history')) || [];
        history.push({ prompt: prompt.trim(), ...result, at: Date.now() });
        const snapshot=await this.ctx.container.snapshotContainer({});
        await this.ctx.storage.put({history:history.slice(-20),snapshot});
        return json(result);
      } finally {
        this.inFlight = false;
        await this.ctx.storage.delete('modelQuota');
        await this.ctx.storage.setAlarm(Date.now() + 35 * 60 * 1000);
      }
    }
    return new Response('Not found', { status: 404 });
  }
  async alarm() {
    await this.ctx.storage.delete('modelQuota');
    if (this.ctx.container?.running) await this.ctx.container.destroy();
  }
}

async function handleOAuth(request, env, url) {
  if (url.pathname === '/auth/github') {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return json({ error: 'GitHub OAuth is not configured' }, 503);
    const state = crypto.randomUUID();
    await authObject(env, state).fetch('https://internal/oauth/put', { method: 'POST', body: JSON.stringify({ origin: url.origin }) });
    const target = new URL('https://github.com/login/oauth/authorize');
    target.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
    target.searchParams.set('redirect_uri', `${url.origin}/auth/callback`);
    target.searchParams.set('scope', 'read:user repo');
    target.searchParams.set('state', state);
    return new Response(null, { status: 302, headers: { Location: target.toString(), 'Set-Cookie': `arno_oauth=${state}; Path=/auth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`, ...SECURITY } });
  }
  if (url.pathname === '/auth/callback') {
    const state = url.searchParams.get('state') || '';
    if (state !== cookie(request, 'arno_oauth') || !/^[0-9a-f-]{36}$/.test(state)) return json({ error: 'Invalid OAuth state' }, 400);
    const saved = await authObject(env, state).fetch('https://internal/oauth/take', { method: 'POST' });
    if (!saved.ok) return json({ error: 'OAuth state expired' }, 400);
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', redirect: 'manual', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: url.searchParams.get('code'), redirect_uri: `${url.origin}/auth/callback` })
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) return json({ error: 'GitHub sign-in failed' }, 401);
    const userResponse = await github('/user', tokenData.access_token);
    if (!userResponse.ok) return json({ error: 'Could not read GitHub profile' }, 502);
    const user = await userResponse.json();
    const id = crypto.randomUUID();
    await authObject(env, id).fetch('https://internal/auth/put', { method: 'POST', body: JSON.stringify({ token: tokenData.access_token, user: { id: user.id, login: user.login }, expiresAt: Date.now() + 30 * 86400000 }) });
    return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': sessionCookie(id), ...SECURITY } });
  }
  if (url.pathname === '/auth/logout') {
    const id = cookie(request, COOKIE);
    if (/^[0-9a-f-]{36}$/.test(id)) await authObject(env, id).fetch('https://internal/auth/delete', { method: 'POST' });
    return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': sessionCookie('', 0), ...SECURITY } });
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/auth/')) {
        const response = await handleOAuth(request, env, url);
        if (response) return response;
      }
      if (url.pathname === '/' && request.method === 'GET') return new Response(HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY } });
      if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404, headers: SECURITY });
      if (!sameOrigin(request)) return json({ error: 'Cross-origin request denied' }, 403);
      const auth = await currentAuth(request, env);
      if (url.pathname === '/api/me') return json({ user: auth?.user || null, githubConfigured: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) });
      if (!auth) return json({ error: 'Sign in required' }, 401);
      if(url.pathname==='/api/models' && request.method==='GET')return json(await catalog());
      const modelMatch=url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/model$/);
      if(modelMatch && request.method==='POST'){
        const body=await boundedJson(request);
        return env.PROBE.getByName('code:'+auth.user.id+':'+modelMatch[1]).fetch('https://internal/session/model',{method:'POST',body:JSON.stringify(body)});
      }
      if (url.pathname === '/api/repos' && request.method === 'GET') {
        const page = Math.max(1, Math.min(10000, Number(url.searchParams.get('page')) || 1));
        const query = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0,100);
        const response = await github('/user/repos?per_page=100&page='+page+'&sort=updated&affiliation=owner,collaborator,organization_member', auth.token);
        if (!response.ok) return json({ error: 'GitHub rejected the repository request' }, 502);
        const repos = (await response.json()).map(({ full_name, private: isPrivate, default_branch, archived }) => ({ full_name, private: isPrivate, default_branch, archived })).filter(repo => !repo.archived);
        return json({ repos: repos.filter(r => r.full_name.toLowerCase().includes(query)), nextPage: response.headers.get('Link')?.includes('rel="next"') ? page+1 : null });
      }
      if (url.pathname === '/api/sessions' && request.method === 'GET') {
        return env.PROBE.getByName('index:'+auth.user.id).fetch('https://internal/index/list');
      }
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})$/);
      if (sessionMatch && request.method === 'GET') {
        return env.PROBE.getByName('code:'+auth.user.id+':'+sessionMatch[1]).fetch('https://internal/session/get');
      }
      if (url.pathname === '/api/sessions' && request.method === 'POST') {
        const body = await boundedJson(request);
        if (typeof body.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(body.repo) || typeof body.ref !== 'string' || body.ref.length > 200 || !await modelAllowed(body.model)) return json({ error: 'Invalid repository or model' }, 400);
        const [owner, repo] = body.repo.split('/');
        const archive = await github(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${encodeURIComponent(body.ref)}`, auth.token);
        if (!archive.ok || !archive.body) return json({ error: 'Could not download repository from GitHub' }, 502);
        const length = Number(archive.headers.get('Content-Length') || 0);
        if (length > MAX_ARCHIVE) { await archive.body.cancel(); return json({ error: 'Repository archive is larger than 50 MB' }, 413); }
        let received = 0;
        const limitedBody = archive.body.pipeThrough(new TransformStream({
          transform(chunk, controller) {
            received += chunk.byteLength;
            if (received > MAX_ARCHIVE) throw new Error('Repository archive is larger than 50 MB');
            controller.enqueue(chunk);
          }
        }));
        const id = crypto.randomUUID();
        const object = env.PROBE.getByName(`code:${auth.user.id}:${id}`);
        const initialized = await object.fetch('https://internal/session/init', { method: 'POST', headers: { 'X-Arno-Repo': body.repo, 'X-Arno-Ref': body.ref, 'X-Arno-Model': body.model }, body: limitedBody });
        const result = await initialized.json();
        if (!initialized.ok) return json({ error: result.error || 'Could not create workspace' }, initialized.status);
        await env.PROBE.getByName('index:'+auth.user.id).fetch('https://internal/index/add', {method:'POST', body:JSON.stringify({id,...result})});
        return json({ id, ...result }, 201);
      }
      const match = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/messages$/);
      if (match && request.method === 'POST') {
        const body = await boundedJson(request);
        const object = env.PROBE.getByName(`code:${auth.user.id}:${match[1]}`);
        const response = await object.fetch('https://internal/session/run', { method: 'POST', body: JSON.stringify(body) });
        return new Response(response.body, { status: response.status, headers: { 'Content-Type': 'application/json', ...SECURITY } });
      }
      return new Response('Not found', { status: 404, headers: SECURITY });
    } catch (error) {
      console.error(JSON.stringify({ event: 'request_error', path: url.pathname, error: String(error) }));
      return json({ error: 'Request failed' }, 500);
    }
  }
};

