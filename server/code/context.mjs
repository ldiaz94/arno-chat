/** What arno is told in a coding session: the host's part of its system
 * prompt (sessionPrompt), and, for a conversation arno no longer has (or one
 * from before arno kept them), the earlier turns as context in the line itself
 * (buildPrompt: the last 20, cut to 32k characters). Sent by turn.mjs through
 * serve.mjs. Depends on nothing; leaves out what arno keeps for itself (its
 * own conversations, notes and memory). */
/** The host's section of arno's system prompt for a coding session, so the
 * model knows where it is: the app, git and what the user sees of changes,
 * the limits of the sandbox, and the app's own features to point the user to.
 * net is {internet, cloudflare}, the owner's sandbox settings (sandbox.mjs). */
export function sessionPrompt(session, net = {}) {
  const lines = [
    // Where it is.
    'You run in Arno Chat, a web app the user reaches from a phone or a browser: nobody watches a terminal, and the user sees your replies, your tool calls in brief, and the diff. Keep replies short and readable on a phone.',
    'The project is a clone of github.com/' +
      session.repo +
      ', on branch ' +
      session.ref +
      ', in a sandboxed container. The user may run other sessions on the same repository at once, and others may push to it.',
    // Git.
    'Git: origin goes through the app, which adds the user’s GitHub credentials, so fetch and push work from the shell; commits are made under the user’s name. Deleting a branch or tag on GitHub is refused.',
    'Never commit or push unless the user asks you to in this conversation. When work is done, say what changed and offer to commit and push; let the user decide. When asked to push, push the current branch (git push origin HEAD:' +
      session.ref +
      ', or a new branch if the user wants one), never force-push, and say the branch and the commit.',
    'Your edits happen in a copy of the project and are applied to it when your turn ends. Commits you make in that copy are kept; to commit and push, do it at the end of the turn, after your edits.',
    'What the user sees as changes is only what GitHub does not have yet: commits not pushed and edits not committed, measured from where the branch meets GitHub. Work pulled from upstream and other sessions’ pushes are not in it.',
    'To bring in new commits from GitHub, do not merge or pull in your copy: ask the user to send /pull (or tap Pull in the History tab), which updates the project itself. Only if /pull reports a conflict, and the user asks, merge origin/' +
      session.ref +
      ' in your copy, resolve the conflicts, commit the merge, and tell the user it needs pushing.',
    // Limits.
    net.internet
      ? 'The network: the internet is open to your commands.'
      : 'The network: your commands have no internet, but npm, npx and pip install from npm and PyPI through the app; other sites, installers and registries are out of reach unless the user turns on full internet access (Settings, Connections).',
    net.cloudflare?.saved
      ? 'Cloudflare’s API is reachable through the app with the user’s token, so npx wrangler commands (such as wrangler deploy) work; the token is added by the app, so never ask for it. Deploy only when the user asks.'
      : 'Deploying to Cloudflare needs the user to save a Cloudflare API token in Settings, Connections.',
    'Limits: a turn may run for about 10 minutes (13 in build mode); nothing you start keeps running after the turn, and there are no ports or previews the user can open, so servers are for tests only. The disk is small (about 4 GB). There is a C toolchain, Node, Python and git, but no Go or Rust. Images cannot be attached in coding sessions.',
    // The app.
    'When the user needs something the app does, point them to it: the options (sliders) button sets your approach (pair, build, review), how many workers run side by side and the budget per message, also /mode, /workers and /budget; /compact when the conversation grows long; the code button shows files, the changes and the commit history; ⋯ has Review & publish (a pull request from the changes) and New session on this repository (to work in parallel); Settings hold model keys, MCP connections, internet access and the Cloudflare token.',
  ];
  return lines.join('\n');
}
/** The text sent to arno for one turn: the repository's identity, the last 20
 * turns as context only, and the user's request. */
export function buildPrompt(session, history, prompt) {
  const context = history
    .slice(-20)
    .map(
      t =>
        'User: ' +
        t.prompt +
        '\nAssistant: ' +
        t.summary +
        (t.sources?.length
          ? '\nSources: ' + t.sources.map(s => '[' + s.id + '] ' + s.title + ' ' + s.url).join('; ')
          : ''),
    )
    .join('\n\n')
    .slice(-32000);
  return (
    'Repository context: ' +
    JSON.stringify({
      repository: session.repo,
      remote: session.remoteUrl || 'https://github.com/' + session.repo,
      branch: session.ref,
      sourceCommit: session.sourceSha,
      workspace: '/workspace/repo',
    }) +
    '\nThis is the same workspace as prior turns.\n' +
    (context ? 'Previous conversation (context only):\n' + context + '\n\n' : '') +
    'Current user request:\n' +
    prompt.trim()
  );
}
