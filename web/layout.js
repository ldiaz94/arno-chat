/** Page chrome: viewport fitting, the drawer, the busy flag, the title bar, the session
 * sidebar and the theme. Depends on core, offline and outbox.
 */
import { $, state, esc, icon, date, avatar, shell } from './core.js';
import { controls } from './offline.js';
import { waiting } from './outbox.js';
export function fit() {
  const v = window.visualViewport;
  shell.style.height = (v ? v.height : innerHeight) + 'px';
  shell.style.top = (v ? v.offsetTop : 0) + 'px';
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
window.visualViewport?.addEventListener('scroll', fit);
window.addEventListener('resize', fit);
fit();
export function drawer(open) {
  shell.classList.toggle('drawer-open', open);
  $('#menu').setAttribute('aria-expanded', String(open));
}
export function busy(value) {
  state.busy = value;
  $('#stop').hidden = !value;
  controls(); // send and model change wait while busy; offline, attaching too
  $('#send').innerHTML = value
    ? state.session?.kind === 'chat'
      ? $('#live-response .prose')?.textContent
        ? 'Responding…'
        : 'Thinking…'
      : '<span class="spinner"></span> Working'
    : icon('arrow') + '<span>Send</span>';
}
export function title(name, subtitle) {
  const t = $('#title'),
    open = !!state.session;
  t.textContent = name;
  // On a conversation the title opens its details panel (wired in app.js).
  if (open) t.setAttribute('aria-label', 'Conversation details: ' + name);
  else t.removeAttribute('aria-label');
  t.setAttribute('role', open ? 'button' : 'presentation');
  if (open) t.tabIndex = 0;
  else t.removeAttribute('tabindex');
  $('#subtitle').textContent = subtitle;
  $('#workspace-pill').hidden = !state.session || state.session.kind === 'chat';
  $('#workspace-label').textContent =
    state.session?.workspaceState === 'warm' ? 'Workspace warm' : 'Workspace saved';
}
export function sidebar() {
  $('#account').textContent = state.user?.login || 'Guest';
  $('#account-avatar').innerHTML = avatar((state.user?.login || 'A').slice(0, 2).toUpperCase());
  $('#session-list').innerHTML = state.sessions.length
    ? state.sessions
        .map(
          s =>
            '<div class="session-row"><button class="session-item ' +
            (s.id === state.session?.id ? 'active' : '') +
            '" data-session="' +
            esc(s.id) +
            '"><strong>' +
            esc(s.title || s.repo) +
            '</strong><small>' +
            esc(s.kind === 'chat' ? 'Plain chat' : s.ref || 'main') +
            ' · ' +
            date(s.createdAt) +
            (waiting(s.id) ? ' · <span class="queued-mark">Queued</span>' : '') +
            '</small></button><button class="session-more" type="button" data-session-menu="' +
            esc(s.id) +
            '" aria-label="Conversation actions for ' +
            esc(s.title || s.repo) +
            '">⋯</button></div>',
        )
        .join('')
    : '<div class="empty caption">Your coding sessions will appear here.</div>';
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
if (localStorage.getItem('theme') === 'light') document.body.classList.add('light');
themeColor();
