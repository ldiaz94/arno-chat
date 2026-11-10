/** Durable Object routes a coding session alone has, part of ArnoProbe
 * (probe.mjs): making its workspace (a clone), its files, its commit history
 * and one commit, and the changes for review. hostCommand says which slash
 * commands stay out of arno. Called with this = the ArnoProbe instance. */
import { json } from '../http.mjs';
import { modelAllowed } from '../models.mjs';
import { EXPORT_FILES, validateFiles, WORKTREE_DIFF } from './publish.mjs';
import { READ_FILE, validPath } from './files.mjs';
import { gitRemote } from './git.mjs';

/** Why a coding session's line can't go to arno, or '': the commands that
 * would undo what the host set up (its model, safety and process), or need a
 * terminal. The rest (/clear, /compact, /notes, /usage, /help, ...) go on. */
export function hostCommand(prompt) {
  const name = /^\/([a-z]+)/.exec(prompt.trim())?.[1];
  if (['model', 'models', 'provider'].includes(name))
    return 'Change the model with the model button';
  if (name === 'pull' || name === 'open') return 'Use /' + name + ' from the app';
  if (['budget', 'workers', 'mode'].includes(name))
    return 'Set /' + name + ' in the options (sliders) button';
  if (['safety', 'quit', 'exit', 'attach', 'paste', 'stage'].includes(name))
    return '/' + name + ' is not available here';
  return '';
}
/** The pull's script, run in the checkout with REF, the session's branch: says
 * "up-to-date", "merged N" or "conflict FILE ...". A shallow clone (a session
 * from before clones) first gets its history, without file contents. */
const PULL = String.raw`set -e
[ "$(git rev-parse --is-shallow-repository)" = true ] && git fetch -q --filter=blob:none --unshallow origin
git fetch -q origin "+refs/heads/$REF:refs/remotes/origin/$REF"
behind=$(git rev-list --count "HEAD..origin/$REF")
if [ "$behind" = 0 ]; then echo up-to-date; exit 0; fi
if git merge -q --no-edit "origin/$REF" >/dev/null; then echo "merged $behind"; exit 0; fi
files=$(git diff --name-only --diff-filter=U | tr '\n' ' ')
[ -n "$files" ] && git merge --abort && echo "conflict $files" && exit 3
exit 1
`;
/** git log's fields for a commit, parted by unit separators. */
const LOG_FORMAT = '%H%x1f%an%x1f%at%x1f%s%x1f%D';

/** How many commits GitHub has on the session's branch that its checkout
 * does not: fetched now, through the git gateway (gitOpen lets it in outside
 * a turn). null when the fetch fails (offline, signed out). */
async function behindOf(probe, session) {
  probe.gitOpen = { repo: session.repo, ownerId: session.ownerId };
  try {
    const f = await probe.exec(
      [
        'sh',
        '-c',
        'git fetch -q origin "+refs/heads/$REF:refs/remotes/origin/$REF" && git rev-list --count "HEAD..origin/$REF"',
      ],
      { cwd: '/workspace/repo', env: { REF: session.ref || 'main' } },
      30,
    );
    return f.exitCode === 0 ? Number(f.stdout.trim()) || 0 : null;
  } finally {
    probe.gitOpen = null;
  }
}

export const codeRoutes = {
  /** Whether there is anything to pull: {behind, ref} (behindOf). */
  async 'GET /session/behind'() {
    const refused = await this.wake();
    if (refused) return refused;
    const session = await this.ctx.storage.get('session');
    return json({ behind: await behindOf(this, session), ref: session.ref });
  },
  /** The newest commits of the session's checkout: each with its author, time,
   * subject and refs, and whether it is only here (not yet on GitHub); and
   * how many files have uncommitted changes. */
  async 'GET /session/history'() {
    const refused = await this.wake();
    if (refused) return refused;
    const cwd = { cwd: '/workspace/repo' },
      session = await this.ctx.storage.get('session');
    const behind = await behindOf(this, session);
    const [log, local, status] = await Promise.all([
      this.exec(['git', 'log', '-n', '100', '--format=' + LOG_FORMAT, 'HEAD'], cwd, 20),
      this.exec(['git', 'rev-list', '-n', '100', 'HEAD', '--not', '--remotes'], cwd, 20),
      this.exec(['git', 'status', '--porcelain'], cwd, 20),
    ]);
    if (log.exitCode !== 0) return json({ error: 'Could not read the history' }, 500);
    const only = new Set(local.stdout.split('\n').filter(Boolean));
    const commits = log.stdout
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [sha, author, at, subject, refs] = line.split('\x1f');
        return { sha, author, at: Number(at) * 1000, subject, refs, local: only.has(sha) };
      });
    return json({
      commits,
      uncommitted: status.stdout.split('\n').filter(Boolean).length,
      behind,
      ref: session.ref,
    });
  },
  /** Brings GitHub's new commits on the session's branch into its checkout:
   * fetch, then merge (a fast-forward when it can). A conflict is backed out
   * and its files named; the workspace is then snapshotted, as after a turn.
   * The app does this, not the model: arno works in a copy of the project,
   * and a merge there would come back as edits, not as upstream's commits. */
  async 'POST /session/pull'() {
    const job = await this.ctx.storage.get('job');
    if (this.inFlight || (job && ['queued', 'running'].includes(job.status)))
      return json({ error: 'Wait for the turn to finish before pulling' }, 409);
    const refused = await this.wake();
    if (refused) return refused;
    const session = await this.ctx.storage.get('session');
    this.inFlight = true;
    this.gitOpen = { repo: session.repo, ownerId: session.ownerId };
    try {
      const r = await this.exec(
        ['sh', '-c', PULL],
        { cwd: '/workspace/repo', env: { REF: session.ref || 'main' } },
        150,
      );
      const [status, ...rest] = r.stdout.trim().split(' '),
        detail = rest.join(' ');
      if (r.exitCode !== 0 && status !== 'conflict')
        return json(
          { error: 'Could not pull: ' + (r.stderr.trim().split('\n').pop() || 'git failed') },
          409,
        );
      if (status === 'merged') {
        const snapshot = await this.ctx.container.snapshotContainer({});
        await this.ctx.storage.put('snapshot', snapshot);
      }
      return json(
        status === 'conflict'
          ? { status, files: detail.split(' ').filter(Boolean) }
          : { status, commits: Number(detail) || 0 },
        status === 'conflict' ? 409 : 200,
      );
    } finally {
      this.gitOpen = null;
      this.inFlight = false;
    }
  },
  /** One commit: its message and its patch, cut at 120 KB. Its files' contents
   * may still be on GitHub (a partial clone), so git may fetch them. */
  async 'GET /session/commit'(request, url) {
    const sha = url.searchParams.get('sha') || '';
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return json({ error: 'Invalid commit' }, 400);
    const refused = await this.wake();
    if (refused) return refused;
    const session = await this.ctx.storage.get('session');
    this.gitOpen = { repo: session.repo, ownerId: session.ownerId };
    try {
      const r = await this.exec(
        ['git', 'show', '--no-color', '--patch', '--format=%H%x1f%an%x1f%at%x1f%B%x1e', sha],
        { cwd: '/workspace/repo' },
        60,
      );
      if (r.exitCode !== 0) return json({ error: 'Could not read that commit' }, 404);
      const [head, ...rest] = r.stdout.split('\x1e'),
        [full, author, at, message] = head.split('\x1f');
      return json({
        sha: full,
        author,
        at: Number(at) * 1000,
        message: message.trim(),
        patch: rest.join('').replace(/^\n+/, '').slice(0, 120000),
      });
    } finally {
      this.gitOpen = null;
    }
  },
  /** A file's text or a directory's entries from the checkout, read in the
   * container by READ_FILE (files.mjs). ?path= is relative to the repository. */
  async 'GET /session/files'(request, url) {
    const name = url.searchParams.get('path') || '';
    if (!validPath(name)) return json({ error: 'Invalid file path' }, 400);
    const refused = await this.wake();
    if (refused) return refused;
    const p = await this.ctx.container.exec(['node', '-e', READ_FILE, name], {
      cwd: '/workspace/repo',
    });
    const result = await p.output();
    if (result.exitCode !== 0)
      return json(
        {
          error:
            'Cannot preview this path. Preview supports regular UTF-8 files up to 200 KB and no symlinks.',
        },
        400,
      );
    if (result.stdout.byteLength > 1500000) return json({ error: 'Preview too large' }, 413);
    return json(JSON.parse(new TextDecoder().decode(result.stdout)));
  },
  /** Every file changed since the pinned source commit, with its content, for
   * review before publishing (publish.mjs). Refused while a task runs. */
  /** The changes GitHub does not have yet, as a diff, now: for the Changes tab. */
  async 'GET /session/diff'() {
    const refused = await this.wake();
    if (refused) return refused;
    const session = await this.ctx.storage.get('session'),
      r = await this.exec(
        ['node', '-e', WORKTREE_DIFF],
        { cwd: '/workspace/repo', env: { ARNO_REF: session.ref || '' } },
        30,
      );
    if (r.exitCode !== 0) return json({ error: 'Could not read the changes' }, 500);
    return json({ diff: r.stdout, ref: session.ref });
  },
  async 'GET /session/changes'() {
    const job = await this.ctx.storage.get('job');
    if (this.inFlight || (job && ['queued', 'running'].includes(job.status)))
      return json({ error: 'Wait for the task to finish before publishing' }, 409);
    const session = await this.ctx.storage.get('session');
    if (!session) return json({ error: 'Session not found' }, 404);
    if (!session.sourceSha)
      return json(
        {
          error:
            'This older session has no pinned source commit. Open a new session before publishing.',
        },
        409,
      );
    this.inFlight = true;
    try {
      await this.start(session.model);
      const p = await this.ctx.container.exec(['node', '-e', EXPORT_FILES], {
        cwd: '/workspace/repo',
        env: { ARNO_REF: session.ref || '' },
      });
      const output = await p.output();
      if (output.exitCode !== 0)
        return json(
          {
            error: 'Unable to export changes. Only regular text files up to 1 MB are supported.',
          },
          400,
        );
      if (output.stdout.byteLength > 2000000) return json({ error: 'Changes too large' }, 413);
      const { files, base } = JSON.parse(new TextDecoder().decode(output.stdout));
      return json({
        files: validateFiles(files),
        repo: session.repo,
        ref: session.ref,
        // The publish's parent: where the branch meets GitHub (publish.mjs).
        sourceSha: /^[0-9a-f]{40}$/.test(base || '') ? base : session.sourceSha,
      });
    } finally {
      this.inFlight = false;
    }
  },
  /** A new coding session: the workspace's container starts, the repository
   * is cloned into it through the git gateway (GitGateway in ../gateways/gateways.mjs), and the first
   * checkpoint is taken. */
  async 'POST /session/init'(request) {
    const model = request.headers.get('X-Arno-Model');
    const repo = request.headers.get('X-Arno-Repo');
    const ref = request.headers.get('X-Arno-Ref');
    if (
      !(await modelAllowed(model)) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') ||
      !ref
    )
      return json({ error: 'Invalid session' }, 400);
    let github;
    try {
      github = JSON.parse(request.headers.get('X-Arno-GitHub') || 'null');
    } catch {
      github = null;
    }
    const ownerId = request.headers.get('X-Arno-Owner') || null;
    await this.start(model);
    await this.exec(
      [
        'sh',
        '-c',
        'rm -rf /workspace/repo /workspace/config /workspace/data; mkdir -p /workspace/config/arno /workspace/data',
      ],
      {},
      30,
    );
    if (github?.token) await this.keepGithub(ownerId, github);
    // The gateway serves this repository while the clone runs (gitOpen).
    this.gitOpen = { repo, ownerId };
    let clone;
    try {
      clone = await this.exec(
        [
          'git',
          'clone',
          '-q',
          '--filter=blob:none',
          '--branch',
          ref,
          gitRemote(repo),
          '/workspace/repo',
        ],
        {},
        170,
      );
    } finally {
      this.gitOpen = null;
    }
    if (clone.exitCode !== 0)
      return json({ error: 'Could not clone the repository', detail: clone.stderr }, 502);
    const head = await this.exec(['git', 'rev-parse', 'HEAD'], { cwd: '/workspace/repo' }, 10);
    const meta = {
      repo,
      ref,
      model,
      ownerId,
      remoteUrl: 'https://github.com/' + repo,
      sourceSha: head.stdout.trim() || request.headers.get('X-Arno-Sha') || null,
      createdAt: Date.now(),
    };
    await this.exec(
      [
        'sh',
        '-c',
        'git config arno.sourceCommit "$1" && git config arno.cloned true',
        'sh',
        meta.sourceSha,
      ],
      { cwd: '/workspace/repo' },
      10,
    );
    await this.gitSetup(meta);
    const snapshot = await this.ctx.container.snapshotContainer({});
    await this.ctx.storage.put({ session: meta, snapshot });
    return json(meta);
  },
};
