/** Page chrome: viewport fitting, the drawer, the busy flag, the title bar, the session
 * sidebar (the Chat | Code switch and that mode's conversations, most recently
 * active first) and the theme. Depends on core, today.mjs, offline and outbox.
 */
import { $, state, esc, icon, avatar, shell, modeOf } from './core.js';
import { byRecent, ago, activeAt } from './today.mjs';
import { controls } from './offline.js';
import { waiting, chatFailure } from './outbox.js';
/** Pin the shell to the visible area only while the keyboard may be up;
 * otherwise the CSS height (100dvh) fills the screen. An installed iPhone
 * app's visual viewport leaves out the status-bar strip, which left a gap. */
function fitHeight() {
  const v = window.visualViewport,
    typing = !!document.activeElement?.matches('input, textarea, select, [contenteditable]');
  shell.style.height = typing && v ? v.height + 'px' : '';
  shell.style.top = typing && v ? v.offsetTop + 'px' : '';
}
export function fit() {
  const v = window.visualViewport;
  fitHeight();
  const d = $('#account-dialog');
  if (d) {
    d.style.height = d.open && innerWidth <= 800 ? (v ? v.height : innerHeight) + 'px' : '';
    d.style.top = d.open && innerWidth <= 800 ? (v ? v.offsetTop : 0) + 'px' : '';
  }
  const code = $('#code-dialog');
  if (code?.open) {
    const dock = innerWidth >= 1600;
    if (dock !== document.body.classList.contains('code-open')) {
      code.close();
      if (dock) code.show();
      else code.showModal();
      document.body.classList.toggle('code-open', dock);
    }
  }
}
window.visualViewport?.addEventListener('resize', fit);
// Focus only moves the height: fit() itself can move focus (re-docking dialogs).
document.addEventListener('focusin', fitHeight);
document.addEventListener('focusout', () => setTimeout(fitHeight, 50));
window.visualViewport?.addEventListener('scroll', fit);
window.addEventListener('resize', fit);
fit();
export function drawer(open) {
  shell.classList.toggle('drawer-open', open);
  $('#menu').setAttribute('aria-expanded', String(open));
}
$('#send').innerHTML = icon('arrow');
$('#stop').innerHTML = icon('stop');
export function busy(value) {
  state.busy = value;
  // While a turn runs, Stop takes Send's place; the thread shows what is happening.
  $('#stop').hidden = !value;
  $('#send').hidden = value;
  controls(); // send and model change wait while busy; offline, attaching too
}
/** The header: the page's or conversation's name and a line under it. A coding
 * session's name is its repository, owner muted, and its line the branch, the
 * commit it started from and whether its workspace is warm; subtitle is used
 * otherwise. */
export function title(name, subtitle) {
  const t = $('#title'),
    open = !!state.session,
    s = state.session,
    coding = !!s && s.kind !== 'chat';
  const [owner, repo] = coding && name === s.repo ? name.split('/') : [];
  t.innerHTML = repo
    ? '<span class="title-owner">' + esc(owner) + ' / </span>' + esc(repo)
    : esc(name);
  // On a conversation the title opens its details panel (wired in app.js).
  if (open) t.setAttribute('aria-label', 'Conversation details: ' + name);
  else t.removeAttribute('aria-label');
  t.setAttribute('role', open ? 'button' : 'presentation');
  if (open) t.tabIndex = 0;
  else t.removeAttribute('tabindex');
  $('#subtitle').innerHTML = coding
    ? '<span class="crumb">' +
      icon('branch') +
      esc(s.ref || 'main') +
      '</span>' +
      (s.sourceSha ? '<span class="crumb sha">' + esc(s.sourceSha.slice(0, 7)) + '</span>' : '') +
      (name === s.repo ? '' : '<span class="crumb">' + esc(s.repo) + '</span>') +
      '<span class="crumb ws-state' +
      (s.workspaceState === 'warm' ? ' warm' : '') +
      '"><span class="dot"></span>' +
      (s.workspaceState === 'warm' ? 'Warm' : 'Saved') +
      '</span>'
    : esc(subtitle);
  $('#subtitle').title = coding ? 'Branch, starting commit and workspace' : '';
  // Header buttons that only mean something in a conversation (actions, export,
  // details) or only in a coding one (code browser, publish).
  for (const id of ['actions', 'export', 'usage']) $('#' + id).hidden = !state.session;
  for (const id of ['code', 'publish']) $('#' + id).hidden = !coding;
}
export function sidebar() {
  $('#account').textContent = state.user?.login || 'Guest';
  $('#account-avatar').innerHTML = avatar((state.user?.login || 'A').slice(0, 2).toUpperCase());
  const code = state.mode === 'code';
  for (const b of document.querySelectorAll('[data-mode]'))
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
  $('#new-chat').hidden = code;
  $('#new-session').hidden = !code;
  $('#list-heading').textContent = code ? 'Coding sessions' : 'Chats';
  const edit = state.editing;
  const editBtn = $('#list-edit');
  editBtn.textContent = edit ? 'Done' : 'Edit';
  editBtn.setAttribute('aria-pressed', String(edit));
  $('#bulk-bar').hidden = !edit;
  $('#bulk-delete').disabled = state.selected.size === 0;
  $('#bulk-delete').textContent =
    'Delete selected' + (state.selected.size ? ' (' + state.selected.size + ')' : '');
  const rows = byRecent(state.sessions.filter(s => modeOf(s) === state.mode));
  editBtn.hidden = !rows.length && !edit;
  const row = s => {
    const name = esc(s.title || s.repo),
      picked = state.selected.has(s.id),
      marks = chatFailure(s.id)
        ? ' · <span class="failed-mark">Not created</span>'
        : waiting(s.id)
          ? ' · <span class="queued-mark">Queued</span>'
          : '';
    return (
      '<div class="session-row' +
      (edit && picked ? ' picked' : '') +
      '">' +
      // In edit mode the whole row is the toggle; the round mark only shows it.
      (edit
        ? '<span class="session-pick' +
          (picked ? ' on' : '') +
          '" aria-hidden="true">' +
          (picked ? '✓' : '') +
          '</span>'
        : '') +
      '<button class="session-item ' +
      (s.id === state.session?.id ? 'active' : '') +
      (edit ? ' picking" aria-pressed="' + picked : '') +
      '" data-session="' +
      esc(s.id) +
      '"><strong>' +
      name +
      '</strong><small>' +
      (code ? esc(s.ref || 'main') + ' · ' : '') +
      '<time>' +
      ago(activeAt(s)) +
      '</time>' +
      marks +
      '</small></button>' +
      (edit
        ? ''
        : '<button class="session-more" type="button" data-session-menu="' +
          esc(s.id) +
          '" aria-label="Conversation actions for ' +
          name +
          '">⋯</button>') +
      '</div>'
    );
  };
  $('#session-list').innerHTML = rows.length
    ? rows.map(row).join('')
    : '<div class="empty caption">' +
      (code
        ? edit
          ? 'No coding sessions to select.'
          : 'Your coding sessions will appear here.'
        : edit
          ? 'No chats to select.'
          : 'Your chats will appear here.') +
      '</div>';
}
/** Marks a conversation active now, so it moves to the top of the list. */
export function bump(id) {
  const now = Date.now();
  state.sessions = state.sessions.map(s => (s.id === id ? { ...s, updatedAt: now } : s));
  sidebar();
}
/** The browser and status bar colour follows the app's theme, not the system's. */
function themeColor() {
  $('meta[name="theme-color"]').content = getComputedStyle(document.body)
    .getPropertyValue('--bg')
    .trim();
}
export function theme() {
  document.body.classList.toggle('light');
  localStorage.setItem('theme', document.body.classList.contains('light') ? 'light' : 'dark');
  themeColor();
}
/** Soft wrap for code (chat code blocks, the file view), remembered on this device. */
export function toggleWrap() {
  document.body.classList.toggle('code-wrap');
  localStorage.setItem('codeWrap', document.body.classList.contains('code-wrap') ? '1' : '');
}
if (localStorage.getItem('theme') === 'light') document.body.classList.add('light');
if (localStorage.getItem('codeWrap')) document.body.classList.add('code-wrap');
themeColor();
