/** The ⋯ sheet: what can be done to the open conversation, in groups, each
 * row an icon, what it does and a line saying more. A coding session's sheet
 * starts with its repository's actions.
 *
 *   Repository    Changes & pull request · Pull from GitHub · New session
 *   Conversation  Rename · Export as Markdown · Delete
 *
 * Depends on core, sessions (rename, delete, export, another session) and
 * code (the Changes tab, pull).
 */
import { $, state, esc, icon } from './core.js';
import { renameConversation, deleteConversation, exportChat, anotherSession } from './sessions.js';
import { openCode, pull } from './code.js';

/** The rows: [key, icon, title, what it says more (a function of the open
 * session), what it does, which conversations have it]. */
const ACTIONS = [
  [
    'changes',
    'branch',
    'Changes & pull request',
    s => 'What is not on GitHub yet, on ' + (s.ref || 'its branch') + '; open a pull request',
    () => openCode('diff'),
    'code',
  ],
  [
    'pull',
    'download',
    'Pull from GitHub',
    s => 'Bring in new commits on ' + (s.ref || 'its branch'),
    pull,
    'code',
  ],
  [
    'another',
    'plus',
    'New session on this repository',
    s => 'Work in parallel, from ' + (s.ref || 'its branch'),
    anotherSession,
    'code',
  ],
  [
    'rename',
    'pencil',
    'Rename',
    () => 'Give the conversation a name of your own',
    renameConversation,
  ],
  ['export', 'doc', 'Export as Markdown', () => 'The whole conversation, as a file', exportChat],
  [
    'delete',
    'trash',
    'Delete',
    s => (s.kind === 'chat' ? 'The conversation and its files' : 'The session and its workspace'),
    deleteConversation,
  ],
];

/** One row of the sheet. */
function row([key, glyph, title, more], s) {
  return (
    '<button type="button" class="action-item' +
    (key === 'delete' ? ' danger' : '') +
    '" data-action="' +
    key +
    '"' +
    (key === 'another' || key === 'pull' ? ' data-online="Reconnect to use GitHub"' : '') +
    '><span class="action-icon">' +
    icon(glyph) +
    '</span><span class="action-text"><strong>' +
    esc(title) +
    '</strong><small>' +
    esc(more(s)) +
    '</small></span></button>'
  );
}

/** Opens the sheet for the open conversation. */
export function openActions() {
  const s = state.session;
  if (!s) return;
  const coding = s.kind !== 'chat',
    group = (label, rows) =>
      rows.length
        ? '<div class="action-group"><div class="eyebrow">' +
          label +
          '</div>' +
          rows.map(r => row(r, s)).join('') +
          '</div>'
        : '';
  $('#actions-heading').textContent = s.title || s.repo || 'Conversation';
  $('#action-items').innerHTML =
    (coding
      ? group(
          'Repository · ' + esc(s.repo),
          ACTIONS.filter(a => a[5] === 'code'),
        )
      : '') +
    group(
      'Conversation',
      ACTIONS.filter(a => !a[5]),
    );
  $('#actions-dialog').showModal();
}

$('#action-items').addEventListener('click', e => {
  const key = e.target.closest('[data-action]')?.dataset.action,
    action = ACTIONS.find(a => a[0] === key);
  if (!action) return;
  $('#actions-dialog').close();
  action[4]();
});
