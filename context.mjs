/** A CLI process is started per turn, but the conversation is not a new chat.
 * Supply host-owned repository identity and a bounded transcript every time.
 * The host keeps 20 turns; 32k characters bound prompt growth for small models.
 */
/** The host's section of arno's system prompt for a coding session: where it
 * runs, and that git can reach GitHub. */
export function sessionPrompt(session) {
  return (
    'You run in Arno Chat, in a cloud sandbox the user reaches from a phone or browser; nobody watches a terminal. ' +
    'The project is a clone of github.com/' +
    session.repo +
    ' (branch ' +
    session.ref +
    '). ' +
    'Its origin goes through the host, which adds the user’s GitHub credentials: git fetch, pull and push work from the shell, and commits are made under the user’s name. ' +
    'Deleting a branch or tag on GitHub is refused. Your edits are applied to the project when the turn ends, so commit and push at the end of a step, after its changes are in the project, ' +
    'or say what to push and the user will ask in the next message. When you push, say the branch and the commit.'
  );
}
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
