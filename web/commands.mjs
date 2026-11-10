/** The slash commands a coding session's composer suggests: arno's own (see
 * arno(1), COMMANDS), less those that would undo what the app set up, and
 * the app's three that set the conversation's options instead (options.js
 * optionCommand). Regular chats have no commands. DOM-free, so test/test.mjs
 * checks it; web/complete.js shows it.
 *
 *   [name, argument hint, what it does, where it goes: arno | app]
 */
export const COMMANDS = [
  ['help', '', 'Arno’s commands and modes', 'arno'],
  ['compact', '[focus]', 'Summarize the conversation and go on from the summary', 'arno'],
  ['clear', '', 'Trim the history to the first exchange', 'arno'],
  ['new', '', 'Start a new conversation in this workspace', 'arno'],
  ['usage', '', 'Requests, tokens, cache savings and cost of this session', 'arno'],
  ['notes', '[forget n | word]', 'The model’s notes on this project', 'arno'],
  ['remember', '[#tag] fact', 'Remember a fact for every conversation', 'arno'],
  ['forget', 'tag | word', 'Forget remembered facts', 'arno'],
  ['my-memory', '[tag]', 'List what is remembered', 'arno'],
  ['test', '[command]', 'Run the project’s tests; a failure goes to the model', 'arno'],
  ['tools', '', 'The tools on offer in this mode', 'arno'],
  ['mcp', '', 'What each MCP server offers, or why it is missing', 'arno'],
  ['system', '[text | -]', 'This conversation’s own system prompt', 'arno'],
  ['list', '[word]', 'Recent conversations in this workspace', 'arno'],
  ['load', 'n | id | word', 'Resume another conversation', 'arno'],
  ['pull', '', 'Bring GitHub’s new commits on this branch into the session', 'app'],
  ['mode', 'auto | pair | build | review', 'This conversation’s approach', 'app'],
  ['budget', 'dollars | auto', 'What a message may spend', 'app'],
  ['workers', 'off | 1-4', 'Workers side by side', 'app'],
];

/** The commands that complete text, the composer's whole line, in a session
 * of kind: none unless it is '/' and a partial name, with no space yet. */
export function suggest(text, kind) {
  if (kind === 'chat' || !/^\/[a-z-]*$/.test(text)) return [];
  const typed = text.slice(1);
  return COMMANDS.filter(([name]) => name.startsWith(typed) && name !== typed);
}
