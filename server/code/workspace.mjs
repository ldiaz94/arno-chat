/** A coding session's workspace, part of ArnoProbe (probe.mjs): the
 * container it runs in (started, or restored from its snapshot, with the
 * gateways it may reach), commands run in it, arno's configuration, and git:
 * the clone's origin, the owner's name on commits, and the checkout following a
 * branch the model pushed. */
import { json } from '../http.mjs';
import { profile, providerModel, seal } from '../account.mjs';
import { gitRemote } from './git.mjs';
import { SANDBOX_HOSTS, publicSandbox } from './sandbox.mjs';
import { codeSettings } from '../chat/plan.mjs';
import { prices, priceOf } from '../prices.mjs';

export const workspace = {
  /** Keeps the owner's GitHub sign-in for the git gateway: the token sealed,
   * and the name and address commits are made under. */
  async keepGithub(ownerId, { token, login, email }) {
    await this.ctx.storage.put('github', {
      login: String(login || ''),
      email: String(email || ''),
      token: await seal(this.env, String(ownerId), 'github', String(token)),
    });
  },
  /** Points the clone's origin at the git gateway and commits at the owner's
   * name. A session made before clones holds an archive with a synthetic
   * history: its HEAD moves to the commit it came from, keeping the work tree,
   * so its work so far shows as changes on GitHub's history and can be pushed. */
  async gitSetup(session) {
    const github = (await this.ctx.storage.get('github')) || {};
    this.gitOpen = { repo: session.repo, ownerId: session.ownerId };
    try {
      const r = await this.exec(
        ['sh', '-c', GIT_SETUP],
        {
          cwd: '/workspace/repo',
          env: {
            REMOTE: gitRemote(session.repo),
            REF: session.ref || '',
            SHA: session.sourceSha || '',
            NAME: github.login || 'Arno',
            EMAIL: github.email || 'arno@localhost',
          },
        },
        120,
      );
      if (r.exitCode !== 0)
        console.error(JSON.stringify({ event: 'git_setup_failed', error: r.stderr.slice(-500) }));
    } finally {
      this.gitOpen = null;
    }
  },
  /** Starts a coding session's workspace for a look at its files or history:
   * a refusal (Response) when it is no coding session or a turn is starting
   * it, else null. */
  async wake() {
    const session = await this.ctx.storage.get('session');
    if (!session || session.kind === 'chat')
      return json({ error: 'Open a repository to browse code' }, 400);
    if (this.ctx.container.running) return null;
    const job = await this.ctx.storage.get('job');
    if (job && ['queued', 'running'].includes(job.status))
      return json({ error: 'Workspace is starting. Try again shortly.' }, 409);
    await this.start(session.model);
    return null;
  },
  /** The owner's sandbox settings, as the browser sees them (sandbox.mjs):
   * whether the internet is open and whether a Cloudflare token is saved. */
  async sandbox(ownerId) {
    return publicSandbox(ownerId ? await profile(this.env, ownerId) : {});
  },
  /** The branches on GitHub as the clone last saw them, to tell after a turn
   * which the model pushed. */
  async remoteRefs() {
    return (
      await this.exec(
        ['git', 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/origin'],
        { cwd: '/workspace/repo' },
        10,
      )
    ).stdout;
  },
  /** After a turn: arno applied the model's work to the project, but the
   * commits it pushed were made in its copy. When the project now holds just
   * what a branch pushed this turn holds, the checkout moves onto that
   * branch, so the next turn starts clean on it. Returns its name, or ''. */
  async followPush(before) {
    const r = await this.exec(
      ['sh', '-c', FOLLOW_PUSH],
      { cwd: '/workspace/repo', env: { BEFORE: before } },
      60,
    );
    const branch = r.exitCode === 0 ? r.stdout.trim() : '';
    if (branch) {
      const session = await this.ctx.storage.get('session');
      await this.ctx.storage.put('session', { ...session, ref: branch });
    }
    return branch;
  },
  /** Arno's config for this turn; with search off (plan.mjs) the built-in web
   * research MCP server is left out. */
  async writeConfig(model, plan, options = {}) {
    const selected = providerModel(model),
      session = await this.ctx.storage.get('session'),
      preferences = await profile(this.env, session?.ownerId),
      price = priceOf(await prices(), model);
    let config =
      'provider = ' +
      // Arno speaks OpenAI's protocol to every other provider; the gateway
      // behind model.internal picks the real upstream and its quirks.
      ({ ollama: 'ollama-cloud', anthropic: 'claude', gemini: 'gemini' }[selected.provider] ||
        'openai') +
      '\nmodel = ' +
      selected.id +
      '\nurl = http://model.internal/v1\nkey =\ntimeout = 180\nmax_retries = 2\n' +
      // Staged in a copy, every change applied at the turn's end. The
      // container is the sandbox, and may forbid arno's own jail; its only
      // network is the gateways (git push).
      'safety = auto\ncontext_files = yes\njail = no\n' +
      (price ? 'price = ' + price.inp + ' ' + price.out + ' ' + price.cached + '\n' : '') +
      codeSettings(selected.id, options);
    if (plan.search)
      config += 'mcp = web http://mcp.internal/web\ntrust = web_web_search web_web_read\n';
    for (const c of preferences.mcp || [])
      if (c.enabled && c.id !== 'web')
        config += 'mcp = ' + c.id + ' http://mcp.internal/' + c.id + '\n';
    const p = await this.ctx.container.exec(['tee', '/workspace/config/arno/config'], {
      stdin: 'pipe',
      stdout: 'ignore',
    });
    const writer = p.stdin.getWriter();
    await writer.write(new TextEncoder().encode(config));
    await writer.close();
    if ((await p.exitCode) !== 0) throw Error('Could not update model config');
  },
  async exec(argv, options = {}, seconds = 180) {
    const process = await this.ctx.container.exec(
      ['timeout', '--kill-after=5', String(seconds), ...argv],
      options,
    );
    const output = await process.output();
    const decode = bytes => new TextDecoder().decode(bytes);
    return {
      exitCode: output.exitCode,
      stdout: decode(output.stdout).slice(-50000),
      stderr: decode(output.stderr).slice(-12000),
    };
  },
  /** Reuse a live VM. Restore only when it has stopped; callers can report this
   * mode independently of the model's own latency. No repository is reimported. */
  async start(model) {
    const container = this.ctx.container;
    let mode = 'warm';
    if (!container.running) {
      const snapshot = await this.ctx.storage.get('snapshot');
      mode = snapshot ? 'restored' : 'new';
      // The internet only when the owner turned it on (sandbox.mjs); else the
      // gateways below are all the container reaches.
      const session = await this.ctx.storage.get('session'),
        internet = !!session?.ownerId && !!(await profile(this.env, session.ownerId)).internet;
      container.start({
        ...(snapshot ? { containerSnapshot: snapshot } : { image: container.images.runner }),
        entrypoint: ['sleep', 'infinity'],
        enableInternet: internet,
        instance: 'standard-1',
      });
    }
    await container.interceptOutboundHttp(
      'model.internal',
      this.ctx.exports.ModelGateway({ props: { task: this.ctx.id.toString(), model } }),
    );
    await container.interceptOutboundHttp(
      'git.internal',
      this.ctx.exports.GitGateway({ props: { task: this.ctx.id.toString() } }),
    );
    for (const host of SANDBOX_HOSTS)
      await container.interceptOutboundHttp(
        host,
        host === 'cf.internal'
          ? this.ctx.exports.CloudflareGateway({ props: { task: this.ctx.id.toString() } })
          : this.ctx.exports.RegistryGateway({}),
      );
    await container.interceptOutboundHttp(
      'mcp.internal',
      this.ctx.exports.McpGateway({ props: { task: this.ctx.id.toString() } }),
    );
    await container.setInactivityTimeout(30 * 60 * 1000);
    await this.ctx.storage.setAlarm(Date.now() + 35 * 60 * 1000);
    return mode;
  },
};

/** gitSetup's script, run in the clone with REMOTE, REF, SHA, NAME, EMAIL. */
const GIT_SETUP = String.raw`set -e
git config user.name "$NAME"
git config user.email "$EMAIL"
git remote remove origin 2>/dev/null || true
git remote add origin "$REMOTE"
if [ "$(git config arno.cloned || true)" != true ] && [ -n "$SHA" ]; then
  git fetch -q --depth=1 origin "$SHA"
  git reset -q --soft FETCH_HEAD
  git config arno.sourceCommit "$SHA"
  git config arno.cloned true
fi
if [ -n "$REF" ]; then
  depth=; [ "$(git rev-parse --is-shallow-repository)" = true ] && depth=--depth=1
  git fetch -q $depth origin "+refs/heads/$REF:refs/remotes/origin/$REF" &&
    git branch -q --set-upstream-to="origin/$REF" 2>/dev/null || true
fi
`;

/** followPush's script: the tree of the project as it stands (a throwaway
 * index), and the first branch pushed since BEFORE with that same tree. */
const FOLLOW_PUSH = String.raw`set -e
index=$(mktemp -u)
GIT_INDEX_FILE=$index git add -A
tree=$(GIT_INDEX_FILE=$index git write-tree)
rm -f "$index"
git for-each-ref --format='%(refname) %(objectname)' refs/remotes/origin |
while read -r ref sha; do
  case "$BEFORE" in *"$ref $sha"*) continue ;; esac
  [ "$ref" = refs/remotes/origin/HEAD ] && continue
  [ "$(git rev-parse "$sha^{tree}")" = "$tree" ] || continue
  branch=$(echo "$ref" | sed "s#^refs/remotes/origin/##")
  git update-ref "refs/heads/$branch" "$sha"
  git symbolic-ref HEAD "refs/heads/$branch"
  git reset -q
  git branch -q --set-upstream-to="$ref"
  echo "$branch"
  break
done
`;
