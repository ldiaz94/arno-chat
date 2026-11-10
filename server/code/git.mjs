/** Git over HTTP for the container, which has no network of its own: its
 * origin is http://git.internal/OWNER/REPO.git, and the git gateway
 * (gateways.mjs) forwards git's smart-HTTP requests to github.com with the
 * owner's GitHub token, which never enters the container.
 *
 *   git (container) ── http://git.internal/o/r.git/... ──► GitGateway
 *        ──► https://github.com/o/r.git/...  + Authorization: Basic x-access-token
 *
 * Only the session's own repository is reached, only the four requests of
 * fetching and pushing, and a push may not delete a branch or tag. Force
 * pushes cannot be told from the request; protect a branch on GitHub to
 * refuse them there. */

/** The all-zero object id git uses for "no object": a ref update to it deletes the ref. */
const ZERO = '0'.repeat(40);

/** Which smart-HTTP request url is, for the repository repo ('owner/name'):
 * 'upload-pack' (fetch) or 'receive-pack' (push), or null for anything else. */
export function gitService(url, method, repo) {
  const prefix = '/' + repo + '.git/';
  if (url.hostname !== 'git.internal' || url.port || !url.pathname.startsWith(prefix)) return null;
  const rest = url.pathname.slice(prefix.length),
    service = url.searchParams.get('service');
  if (method === 'GET' && rest === 'info/refs' && /^git-(upload|receive)-pack$/.test(service || ''))
    return service.slice(4);
  if (method === 'POST' && !url.search && /^git-(upload|receive)-pack$/.test(rest))
    return rest.slice(4);
  return null;
}

/** The ref updates a push's request begins with, read from its pkt-lines up
 * to the first flush: [{old, new, ref}]; null while the bytes are too few. */
export function refUpdates(bytes) {
  const text = new TextDecoder('latin1'),
    updates = [];
  for (let at = 0; ;) {
    if (bytes.length < at + 4) return null;
    const size = parseInt(text.decode(bytes.subarray(at, at + 4)), 16);
    if (Number.isNaN(size)) throw Error('Malformed push');
    if (size === 0) return updates; // flush: the commands end
    if (size < 4) throw Error('Malformed push');
    if (bytes.length < at + size) return null;
    const line = text
        .decode(bytes.subarray(at + 4, at + size))
        .split('\0')[0]
        .trim(),
      [old, now, ref] = line.split(' ');
    if (line.startsWith('shallow ')) {
      at += size;
      continue;
    }
    if (!/^[0-9a-f]{40}$/.test(old) || !/^[0-9a-f]{40}$/.test(now) || !ref)
      throw Error('Malformed push');
    updates.push({ old, new: now, ref });
    at += size;
  }
}

/** Reads a push's request until its commands are known, and returns them with
 * a body that replays what was read and streams the rest. */
async function peekPush(body) {
  const reader = body.getReader(),
    seen = [];
  let length = 0,
    updates = null;
  while (!updates) {
    const { value, done } = await reader.read();
    if (done) break;
    seen.push(value);
    length += value.length;
    if (length > 1 << 20) throw Error('Push commands too long');
    const all = new Uint8Array(length);
    let at = 0;
    for (const s of seen) {
      all.set(s, at);
      at += s.length;
    }
    updates = refUpdates(all);
  }
  if (!updates) throw Error('Malformed push');
  const replay = new ReadableStream({
    start(c) {
      for (const s of seen) c.enqueue(s);
    },
    async pull(c) {
      const { value, done } = await reader.read();
      if (done) c.close();
      else c.enqueue(value);
    },
    cancel: reason => reader.cancel(reason),
  });
  return { updates, body: replay };
}

/** Forwards one of git's requests for repo to GitHub with token, or refuses it. */
export async function gitProxy(request, { repo: only, repos = [only], token, upstream = fetch }) {
  const url = new URL(request.url),
    // The session's repository (the project or an extra, extras.mjs) the path names.
    repo = repos.find(r => url.pathname.startsWith('/' + r + '.git/')) || repos[0],
    service = gitService(url, request.method, repo);
  const refuse = (text, status = 403) =>
    new Response(text + '\n', { status, headers: { 'Content-Type': 'text/plain' } });
  if (!service) return refuse('git.internal reaches only this session’s repository');
  if (!token) return refuse('Sign in again: GitHub access for this session has expired', 401);
  const headers = new Headers({
    Authorization: 'Basic ' + btoa('x-access-token:' + token),
    'User-Agent': 'git/arno-chat',
  });
  for (const h of ['Content-Type', 'Accept', 'Git-Protocol', 'Content-Encoding'])
    if (request.headers.get(h)) headers.set(h, request.headers.get(h));
  let body = request.method === 'POST' ? request.body : undefined;
  if (service === 'receive-pack' && request.method === 'POST') {
    // A gzipped request is read plain, so its commands can be checked.
    if (headers.get('Content-Encoding') === 'gzip') {
      body = body.pipeThrough(new DecompressionStream('gzip'));
      headers.delete('Content-Encoding');
    }
    let peeked;
    try {
      peeked = await peekPush(body);
    } catch (e) {
      return refuse(e.message, 400);
    }
    if (peeked.updates.some(u => u.new === ZERO))
      return refuse('Deleting a branch or tag is not allowed from a session');
    body = peeked.body;
  }
  const target =
    'https://github.com/' + repo + '.git' + url.pathname.slice(repo.length + 5) + url.search;
  let response;
  try {
    response = await upstream(target, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      ...(body && { duplex: 'half' }),
    });
  } catch {
    return refuse('GitHub could not be reached', 502);
  }
  const out = new Headers();
  for (const h of ['Content-Type', 'Cache-Control', 'Content-Encoding'])
    if (response.headers.get(h)) out.set(h, response.headers.get(h));
  return new Response(response.body, { status: response.status, headers: out });
}

/** The origin a session's clone fetches and pushes through. */
export function gitRemote(repo) {
  return 'http://git.internal/' + repo + '.git';
}
