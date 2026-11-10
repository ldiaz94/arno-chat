/** What arno is told in a coding session. A CLI process is started per turn,
 * but the conversation is not a new chat, so each turn is given the host-owned
 * repository identity and a bounded transcript of earlier turns: the last 20
 * turns, cut to 32k characters so small models' prompts do not grow without
 * end. The prompt is sent by turn.mjs. Depends on nothing else; leaves out
 * anything arno keeps for itself (its own /load of the conversation, serve.mjs).
 */
/** The host's section of arno's system prompt for a coding session: where it
 * runs, what git can do, and what the network reaches (sandbox.mjs): net is
 * {internet, cloudflare}, the owner's public sandbox settings. */
export function sessionPrompt(session, net = {}) {
  return (
    'You run in Arno Chat, in a cloud sandbox the user reaches from a phone or browser; nobody watches a terminal. ' +
    'The project is a clone of github.com/' +
    session.repo +
    ' (branch ' +
    session.ref +
    '). ' +
    'Its origin goes through the host, which adds the user’s GitHub credentials: git fetch, pull and push work from the shell, and commits are made under the user’s name. ' +
    'Deleting a branch or tag on GitHub is refused. Your edits are applied to the project when the turn ends, so commit and push at the end of a step, after its changes are in the project, ' +
    'or say what to push and the user will ask in the next message. When you push, say the branch and the commit. ' +
    (net.internet
      ? 'The internet is open to your commands. '
      : 'Your commands have no internet, but npm, npx and pip install from npm and PyPI through the host; other sites and installers are out of reach. ') +
    (net.cloudflare?.saved
      ? 'Cloudflare’s API is reachable through the host with the user’s token, so npx wrangler commands (such as wrangler deploy) work; the token is added by the host, so never ask for it.'
      : 'Cloudflare deploys need the user to save a Cloudflare API token in Settings, Connections.')
  );
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
