/** Shared by every module: the DOM references, the `state` object, small formatting
 * helpers, the API client and the toast. Depends on nothing else in the app.
 */
export const $ = s => document.querySelector(s),
  shell = $('#shell'),
  main = $('#main'),
  composer = $('#composer-wrap'),
  prompt = $('#prompt');
export const state = {
  session: null,
  sessions: [],
  models: [],
  user: null,
  busy: false,
  generation: 0,
  search: 0,
  job: null,
  modelTarget: null,
  avatar: 0, // cache-busting stamp of the profile picture; 0 when there is none
  offline: false, // no network: showing saved conversations (offline.js)
  editing: false, // the sidebar's multi-select mode (Edit button)
  selected: new Set(), // conversation ids picked in edit mode
  mode: localStorage.getItem('mode') === 'code' ? 'code' : 'chat', // the sidebar's Chat | Code
  profile: {}, // the account's preferences (GET /api/account): home, enterSends, defaultModel
};
/** The mode a conversation belongs to: plain chats to Chat, the rest to Code. */
export const modeOf = s => (s?.kind === 'chat' ? 'chat' : 'code');
/** Whether Enter alone sends (the default), or adds a new line. */
export const enterSends = () => state.profile.enterSends === true;
/** Whether a key press in a message box sends it: Ctrl/⌘+Enter always does,
 * Enter alone when the profile says so; Shift+Enter and IME input never. */
export const sendKey = e =>
  e.key === 'Enter' && !e.shiftKey && !e.isComposing && (e.metaKey || e.ctrlKey || enterSends());
/** The hint under a message box. */
export const sendHint = () =>
  enterSends() ? 'Enter to send · Shift + Enter for a new line' : '⌘ / Ctrl + Enter to send';
export const esc = s =>
  String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const paths = {
  plus: 'M12 5v14M5 12h14',
  menu: 'M4 6h16M4 12h16M4 18h16',
  arrow: 'M12 19V5M5 12l7-7 7 7',
  stop: 'M7 7h10v10H7z',
  chevron: 'm9 5 7 7-7 7',
  branch: 'M6 3v12a3 3 0 0 0 6 0V9a3 3 0 0 1 3-3h3M3 6h6',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  chart: 'M4 20h16M7 16V9M12 16V4M17 16v-5',
  copy: 'M9 9h11v11H9zM4 15H2V2h13v2',
  check: 'm5 12 4 4L19 6',
  sun: 'M12 3v2M12 19v2M3 12h2M19 12h2M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  close: 'm6 6 12 12M6 18 18 6',
  code: 'm8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
  panel: 'M3 4h18v16H3zM15 4v16M18 8h.01M18 12h.01',
  commit: 'M12 3v6m0 6v6M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  download: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
  clock: 'M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  repo: 'M4 4h15v17H4zM4 17h15M8 4v9',
  logout: 'M9 4H3v16h6m6-5 4-3-4-3m-6 3h10',
  doc: 'M6 2h9l5 5v15H6zM14 2v6h6M9 13h7M9 17h7',
  clip: 'm21 11-9 9a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8',
  sliders: 'M4 6h9m4 0h3M15 4v4M4 12h3m4 0h9M9 10v4M4 18h11m4 0h1M17 16v4',
};
export function icon(name) {
  return (
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' +
    (paths[name] || paths.code) +
    '"/></svg>'
  );
}
/** The user's avatar content: their picture if they have one, else the given initials. */
export function avatar(initials) {
  return state.avatar
    ? '<img src="/api/account/avatar?v=' + state.avatar + '" alt="">'
    : esc(initials);
}
/** Finds out whether the user has a profile picture (a 404 means initials). */
export async function loadAvatar() {
  try {
    const r = await fetch('/api/account/avatar');
    state.avatar = r.ok && r.headers.get('Content-Type')?.startsWith('image/') ? Date.now() : 0;
  } catch {
    state.avatar = 0;
  }
}
export function num(n) {
  return typeof n === 'number' ? n.toLocaleString() : '—';
}
export function duration(ms) {
  if (ms == null) return '—';
  return ms < 1000
    ? Math.round(ms) + ' ms'
    : ms < 60000
      ? (ms / 1000).toFixed(1) + ' s'
      : Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
}
export function modelName(id) {
  return state.models.find(m => m.id === id)?.name || id || 'Choose model';
}
/** The error api() throws when the network is gone; the outbox (outbox.js) keeps
 * what failed this way and sends it later. */
export const unreachable = () => Object.assign(Error('Network unavailable'), { network: true });
/** Calls the server and returns its JSON. Errors carry the reply's `status`, or
 * `network` when there was no network. With `fresh`, a reply the service
 * worker served from the device's saved copy counts as no network. */
export async function api(path, opt = {}) {
  let r;
  try {
    r = await fetch(path, {
      ...opt,
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(
        path === '/api/sessions' && opt.method === 'POST' ? 180000 : 25000,
      ),
    });
  } catch (e) {
    throw e instanceof TypeError ? unreachable() : e;
  }
  const saved = r.headers.has('X-Arno-Offline');
  // Tells offline.js whether the reply came from the device's saved copy (sw.js).
  dispatchEvent(new CustomEvent('arno:reply', { detail: { offline: saved } }));
  if (saved && opt.fresh) throw unreachable();
  let d;
  try {
    d = await r.json();
  } catch {
    throw Error('The server could not complete this request. Please try again.');
  }
  if (!r.ok) throw Object.assign(Error(d.error || 'Request failed'), { status: r.status });
  return d;
}
export function toast(text) {
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($('#toast').hidden = true), 4000);
}
export function showError(e) {
  toast(e.message || String(e));
}
export function money(n) {
  return n == null ? '—' : '$' + n.toFixed(n < 0.01 ? 4 : 2);
}
export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    toast('Clipboard unavailable in this browser');
  }
}
