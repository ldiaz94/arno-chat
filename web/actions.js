/** The ⋯ sheet: what can be done to the open conversation, in groups, each
 * row an icon, what it does and a line saying more. A coding session's sheet
 * starts with its repository's actions.
 *
 *   Repository    Changes & pull request · Pull from GitHub · New session ·
 *                 Add a repository, and each extra one (tap to take it out)
 *   Conversation  (a chat: Continue in a coding session) · Rename · Export · Delete
 *
 * Depends on core, sessions (rename, delete, export, another session) and
 * code (the Changes tab, pull).
 */
import { $, state, esc, icon } from './core.js';
import {
  renameConversation,
  deleteConversation,
  exportChat,
  anotherSession,
  continueInCode,
  changeExtras,
} from './sessions.js';
import { openCode, pull, behindNow, checkBehind } from './code.js';

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
    s => {
      const n = behindNow()?.n;
      return n === 0
        ? 'Up to date: nothing new on ' + (s.ref || 'its branch')
        : n
          ? n + ' new commit' + (n === 1 ? '' : 's') + ' on ' + (s.ref || 'its branch')
          : 'Bring in new commits on ' + (s.ref || 'its branch');
    },
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
    'addrepo',
    'repo',
    'Add a repository',
    s => 'Check out another beside it, e.g. a library; remembered for ' + s.repo,
    () => changeExtras(),
    'code',
  ],
  [
    'tocode',
    'code',
    'Continue in a coding session',
    () => 'Pick a repository; this chat comes along as your first message',
    continueInCode,
    'chat',
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

/** One row of the sheet; Pull is off when GitHub has nothing new. */
function row([key, glyph, title, more], s) {
  const off = key === 'pull' && behindNow()?.n === 0;
  return (
    '<button type="button" class="action-item' +
    (key === 'delete' ? ' danger' : '') +
    '" data-action="' +
    key +
    '"' +
    (off ? ' disabled' : '') +
    ((key === 'another' || key === 'pull') && !off
      ? ' data-online="Reconnect to use GitHub"'
      : '') +
    '><span class="action-icon">' +
    icon(glyph) +
    '</span><span class="action-text"><strong>' +
    esc(title) +
    '</strong><small>' +
    esc(more(s)) +
    '</small></span></button>'
  );
}

/** Opens the sheet for the open conversation, and, in a coding session, asks
 * GitHub whether there is anything to pull, drawing the sheet again once it
 * knows. */
export function openActions() {
  const s = state.session;
  if (!s) return;
  draw(s);
  $('#actions-dialog').showModal();
  if (s.kind !== 'chat')
    checkBehind().then(() => {
      if ($('#actions-dialog').open && state.session === s) draw(s);
    });
}
/** Draws the sheet's groups for session s. */
function draw(s) {
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
        ) + extrasGroup(s)
      : '') +
    group(
      'Conversation',
      ACTIONS.filter(a => !a[5] || (a[5] === 'chat' && !coding)),
    );
}

/** The session's extra repositories, each a row that takes it out. */
function extrasGroup(s) {
  if (!s.extras?.length) return '';
  return (
    '<div class="action-group"><div class="eyebrow">Also checked out</div>' +
    s.extras
      .map(
        e =>
          '<button type="button" class="action-item" data-extra="' +
          esc(e.repo) +
          '" data-online="Reconnect to use GitHub"><span class="action-icon">' +
          icon('repo') +
          '</span><span class="action-text"><strong>' +
          esc(e.repo) +
          '</strong><small>At ' +
          esc(e.path) +
          ', on ' +
          esc(e.ref) +
          ' · tap to take it out</small></span></button>',
      )
      .join('') +
    '</div>'
  );
}

$('#action-items').addEventListener('click', e => {
  const extra = e.target.closest('[data-extra]')?.dataset.extra;
  if (extra) return changeExtras(extra);
  const key = e.target.closest('[data-action]')?.dataset.action,
    action = ACTIONS.find(a => a[0] === key);
  if (!action) return;
  $('#actions-dialog').close();
  action[4]();
});
