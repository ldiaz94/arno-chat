/** The routes under /api/sessions/<id>/: one conversation, which lives in its
 * own Durable Object, 'code:<user>:<id>' (probe/). Most only pass the request
 * on to that object (FORWARD); the rest do something first (HANDLERS).
 *
 *   GET   /api/sessions/<id>                    the conversation
 *   PATCH /api/sessions/<id>                    rename it
 *   POST  /api/sessions/<id>/messages           send a message (a turn)
 *   GET   /api/sessions/<id>/job | events       follow the turn
 *   POST  /api/sessions/<id>/cancel | approve   stop it, answer its question
 *   GET   /api/sessions/<id>/files | history | commit | changes, POST publish
 *   POST  /api/sessions/<id>/attachments, GET .../attachments/<file>
 *   GET   /api/sessions/<id>/artifacts[/<artifact>]
 *
 * Depends on http.mjs, code/publish.mjs and probe/attachments.mjs. */
import { SECURITY, json, boundedJson } from './http.mjs';
import { changesDigest, publishChanges } from './code/publish.mjs';
import { LIMITS } from './probe/attachments.mjs';

/** A conversation id (a UUID) as a regular-expression source. */
const ID = '[0-9a-f-]{36}';
/** /api/sessions/<id>[/<part>[/<item>]]: the id, the action and an optional attachment or artifact id. */
const PATH = new RegExp('^/api/sessions/(' + ID + ')(?:/([a-z]+))?(?:/(' + ID + '))?$');

/** Requests passed on as they are: "METHOD part" → the object's own path, and
 * the query parameters it takes. A POST's JSON body goes along, bounded. */
const FORWARD = {
  'GET ': ['/session/get'],
  'GET job': ['/session/job'],
  'GET events': ['/session/events'],
  'GET files': ['/session/files', 'path'],
  'GET history': ['/session/history'],
  'GET commit': ['/session/commit', 'sha'],
  'POST cancel': ['/session/cancel'],
  'POST approve': ['/session/approve'],
  'POST model': ['/session/model'],
};

/** The GitHub identity a coding session fetches and pushes with: the token,
 * and the name and noreply address its commits are made under. */
export function githubOf(auth) {
  const { id, login } = auth.user;
  return { token: auth.token, login, email: id + '+' + login + '@users.noreply.github.com' };
}

/** The owner's index: the list of their conversations. */
const index = (env, auth) => env.PROBE.getByName('index:' + auth.user.id);

/** Requests that do more than pass on: (request, object, context) → Response. */
const HANDLERS = {
  /** Renames the conversation, in its object and in the owner's list. */
  async 'PATCH '(request, object, { env, auth, id }) {
    const r = await object.fetch('https://internal/session/rename', {
      method: 'POST',
      body: JSON.stringify(await boundedJson(request)),
    });
    const meta = await r.json();
    if (!r.ok) return json(meta, r.status);
    await index(env, auth).fetch('https://internal/index/add', {
      method: 'POST',
      body: JSON.stringify({ id, ...meta }),
    });
    return json({ id, ...meta });
  },
  /** Deletes the conversation and takes it off the owner's list. */
  async 'DELETE '(request, object, { env, auth, id }) {
    const r = await object.fetch('https://internal/session/delete', { method: 'POST' });
    if (!r.ok) return r;
    await index(env, auth).fetch('https://internal/index/remove', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
    return json({ deleted: true });
  },
  /** A message: the owner (and their GitHub sign-in, for git) first, then the
   * turn, which the object saves and runs from its alarm. */
  async 'POST messages'(request, object, { auth, id }) {
    const body = await boundedJson(request);
    await object.fetch('https://internal/session/owner', {
      method: 'POST',
      body: JSON.stringify({ ownerId: auth.user.id, id, github: githubOf(auth) }),
    });
    const r = await object.fetch('https://internal/session/enqueue', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return new Response(r.body, {
      status: r.status,
      headers: { 'Content-Type': 'application/json', ...SECURITY },
    });
  },
  /** An upload streams through to the object, which checks type and size again. */
  async 'POST attachments'(request, object) {
    if (Number(request.headers.get('Content-Length') || Infinity) > LIMITS.image)
      return json({ error: 'Attachments are limited to ' + LIMITS.image / 1048576 + ' MB' }, 413);
    return object.fetch('https://internal/attachments', {
      method: 'POST',
      body: request.body,
      headers: {
        'Content-Type': request.headers.get('Content-Type') || '',
        'X-Filename': request.headers.get('X-Filename') || 'file',
      },
    });
  },
  async 'GET attachments'(request, object, { item }) {
    return item ? object.fetch('https://internal/attachments/get?id=' + item) : null;
  },
  async 'GET artifacts'(request, object, { item }) {
    return object.fetch('https://internal/artifacts' + (item ? '/get?id=' + item : ''));
  },
  /** The changes for review, with the digest a publish must name. */
  async 'GET changes'(request, object) {
    const r = await object.fetch('https://internal/session/changes');
    if (!r.ok) return r;
    const { changes, files, digest } = await changesDigest(await r.json());
    return json({
      ...changes,
      digest,
      files: files.map(f => ({
        ...f,
        bytes: f.content ? new TextEncoder().encode(f.content).length : 0,
      })),
    });
  },
  /** Publishes the reviewed changes as a new branch and pull request, if they
   * are still what was reviewed. */
  async 'POST publish'(request, object, { auth }) {
    const r = await object.fetch('https://internal/session/changes');
    if (!r.ok) return r;
    const reviewed = await changesDigest(await r.json()),
      body = await boundedJson(request);
    if (body.digest !== reviewed.digest)
      return json(
        { error: 'Changes have changed since review. Review them again before publishing.' },
        409,
      );
    try {
      return json(await publishChanges(reviewed, body, auth.token));
    } catch (e) {
      return json({ error: e.message }, e.status || 502);
    }
  },
};

/** The response for a /api/sessions/<id>/ request, or null when none matches. */
export async function sessionPaths(request, env, url, auth) {
  const m = PATH.exec(url.pathname);
  if (!m) return null;
  const [, id, part = '', item] = m,
    key = request.method + ' ' + part,
    object = env.PROBE.getByName('code:' + auth.user.id + ':' + id);
  const forward = !item && FORWARD[key];
  if (forward) {
    const [path, param] = forward,
      query = param
        ? '?' + param + '=' + encodeURIComponent(url.searchParams.get(param) || '')
        : '';
    return object.fetch(
      'https://internal' + path + query,
      request.method === 'POST'
        ? { method: 'POST', body: JSON.stringify(await boundedJson(request).catch(() => ({}))) }
        : undefined,
    );
  }
  return HANDLERS[key] ? HANDLERS[key](request, object, { env, auth, id, item }) : null;
}
