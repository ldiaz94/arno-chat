/** Extra repositories in a coding session: full clones beside the project,
 * which arno may read, build against, edit, commit and push like it, through
 * the same git gateway (git.mjs) and rules. The session keeps them as
 * `extras` [{repo, ref, path}]; the owner's index remembers them per main
 * repository ('companions', store-routes.mjs), so the next session on it
 * gets them too (api.mjs).
 *
 *   /workspace/repo      the project (its changes, pull and pull requests)
 *   /workspace/<name>    an extra repository, e.g. /workspace/raz
 *
 * Part of ArnoProbe (probe.mjs). Depends on ../http.mjs, git.mjs and
 * workspace.mjs (start, gitSetup's script). Leaves out changes, pull and pull
 * requests for extras: arno commits and pushes them itself when asked. */
import { json } from '../http.mjs';
import { gitRemote } from './git.mjs';
import { GIT_SETUP } from './workspace.mjs';

/** Names under /workspace an extra repository may not take. */
const TAKEN = ['repo', 'config', 'data', 'attachments', 'artifacts', 'tmp'];
/** The most extra repositories one session holds. */
const MAX_EXTRAS = 6;
/** A repository's full name, owner/name. */
export const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Where an extra repository goes: /workspace/<name>, or <owner>-<name> when
 * the name is taken by another extra or by the workspace itself. */
export function extraPath(repo, extras = []) {
  const [owner, name] = repo.split('/'),
    used = new Set([...TAKEN, ...extras.map(e => e.path.split('/').pop())]),
    base = name.toLowerCase();
  return '/workspace/' + (used.has(base) ? (owner + '-' + name).toLowerCase() : base);
}

/** The methods, mixed into ArnoProbe. */
export const extras = {
  /** The workspace awake for a change to its repositories, or why not now (a
   * Response): a turn is running or about to. */
  async ready() {
    const job = await this.ctx.storage.get('job');
    if (this.inFlight || (job && ['queued', 'running'].includes(job.status)))
      return json({ error: 'Wait for the turn to finish' }, 409);
    return this.wake();
  },
  /** Clones repo at ref into its place beside the project and points its
   * origin at the gateway, commits at the owner's name. Returns the extra,
   * or throws with git's complaint. */
  async cloneExtra(session, repo, ref) {
    const path = extraPath(repo, session.extras || []),
      github = (await this.ctx.storage.get('github')) || {};
    this.gitOpen = { repo: session.repo, ownerId: session.ownerId, extra: repo };
    try {
      const clone = await this.exec(
        ['git', 'clone', '-q', '--filter=blob:none', '--branch', ref, gitRemote(repo), path],
        {},
        170,
      );
      if (clone.exitCode !== 0)
        throw Error('Could not clone ' + repo + ': ' + clone.stderr.slice(-300));
      await this.exec(
        ['sh', '-c', 'git config arno.cloned true && ' + GIT_SETUP],
        {
          cwd: path,
          env: {
            REMOTE: gitRemote(repo),
            REF: ref,
            SHA: '',
            NAME: github.login || 'Arno',
            EMAIL: github.email || 'arno@localhost',
          },
        },
        120,
      );
    } finally {
      this.gitOpen = null;
    }
    return { repo, ref, path };
  },
};

/** The routes, merged into ArnoProbe's (probe.mjs). */
export const extraRoutes = {
  /** Adds an extra repository to the running session: {repo, ref}. */
  async 'POST /session/extras'(request) {
    const { repo, ref } = await request.json(),
      session = await this.ctx.storage.get('session');
    if (!session?.repo || session.kind === 'chat')
      return json({ error: 'Not a coding session' }, 400);
    if (!REPO_NAME.test(repo || '') || typeof ref !== 'string' || !ref)
      return json({ error: 'Name a repository as owner/name' }, 400);
    if (repo === session.repo || (session.extras || []).some(e => e.repo === repo))
      return json({ error: repo + ' is already in this session' }, 409);
    if ((session.extras || []).length >= MAX_EXTRAS)
      return json({ error: 'A session holds at most ' + MAX_EXTRAS + ' extra repositories' }, 409);
    const refused = await this.ready();
    if (refused) return refused;
    let extra;
    this.inFlight = true;
    try {
      extra = await this.cloneExtra(session, repo, ref);
    } catch (e) {
      return json({ error: e.message }, 502);
    } finally {
      this.inFlight = false;
    }
    const meta = { ...session, extras: [...(session.extras || []), extra] };
    await this.ctx.storage.put({
      session: meta,
      snapshot: await this.ctx.container.snapshotContainer({}),
    });
    return json(meta);
  },
  /** Takes an extra repository out of the session, deleting its clone: {repo}. */
  async 'POST /session/extras/remove'(request) {
    const { repo } = await request.json(),
      session = await this.ctx.storage.get('session'),
      extra = (session?.extras || []).find(e => e.repo === repo);
    if (!extra) return json({ error: repo + ' is not in this session' }, 404);
    const refused = await this.ready();
    if (refused) return refused;
    await this.exec(['rm', '-rf', extra.path], {}, 60);
    const meta = { ...session, extras: session.extras.filter(e => e !== extra) };
    await this.ctx.storage.put({
      session: meta,
      snapshot: await this.ctx.container.snapshotContainer({}),
    });
    return json(meta);
  },
};
