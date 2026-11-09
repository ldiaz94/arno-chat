/** Offline reading: registers the service worker (sw.js), shows the offline
 * banner (with what waits in the outbox, outbox.js) and disables what needs the
 * network while offline, warms the saved-data cache with every conversation so
 * all of them open with no network, and clears that cache and the outbox on
 * sign-out. Back online, it tells the outbox to send.
 *
 *   page fetch ──> sw.js ──network ok──> reply, copy kept in 'arno-data'
 *                        └─network down─> kept copy + X-Arno-Offline: 1
 *
 * Depends on core and outbox.
 */
import { $, state } from './core.js';
import { outboxStatus, flush, clearOutbox } from './outbox.js';

const DATA_CACHE = 'arno-data'; // the service worker's cache of API replies
const WARM_BYTES = 50 * 1024 * 1024; // attachment images warmed per pass, at most
const WARM_AT_ONCE = 3; // conversations fetched in parallel while warming
const CONTROL_WAIT = 60000; // ms to wait for a fresh service worker to take over
// What the app reads at boot or on its other pages, kept on every pass.
const BOOT_READS = [
  '/api/me',
  '/api/models',
  '/api/sessions',
  '/api/account',
  '/api/account/avatar',
  '/api/usage/requests',
];
// Changing the model needs the network, so these buttons are disabled while offline.
const MODEL_BUTTONS = ['model-button', 'home-model'];

/** Registers the service worker for the whole site; push.js uses the same one. */
export function register() {
  navigator.serviceWorker?.register('/sw.js', { scope: '/' }).catch(() => {});
}

/** Enables or disables the controls that need the network: changing the model,
 * and every element marked `data-online="Reconnect to …"` (that text is its
 * tooltip while offline). Busy disables sending and changing the model; offline,
 * sending and attaching still work, into the outbox. */
export function controls() {
  $('#send').disabled = state.busy;
  for (const id of MODEL_BUTTONS) {
    const b = document.getElementById(id);
    if (!b) continue;
    b.disabled = state.offline || state.busy;
    if (state.offline) b.title = 'Reconnect to change the model';
    else b.removeAttribute('title');
  }
  for (const b of document.querySelectorAll('[data-online]')) {
    b.disabled = state.offline;
    if (state.offline) b.title = b.dataset.online;
    else b.removeAttribute('title');
  }
}

/** The banner: offline, with how much waits to send; online, the progress of
 * sending it. Hidden when online with nothing left to send. */
export function banner() {
  const { waiting, sending, done, total } = outboxStatus(),
    node = $('#offline-banner');
  node.hidden = !state.offline && !(sending && waiting);
  node.textContent = state.offline
    ? waiting
      ? 'Offline · ' + waiting + ' waiting to send'
      : 'Offline · showing saved conversations'
    : 'Sending ' + Math.min(done + 1, total) + ' of ' + total + '…';
}

function setOffline(value) {
  if (value === state.offline) return;
  state.offline = value;
  banner();
  controls();
  if (!value && state.user) {
    warm();
    flush();
  }
}
state.offline = null;
setOffline(!navigator.onLine);
addEventListener('offline', () => setOffline(true));
addEventListener('online', () => setOffline(false));
// core.js's api() reports whether each reply came from the device (sw.js).
addEventListener('arno:reply', e => setOffline(e.detail.offline || !navigator.onLine));

/** Deletes everything kept on this device for offline use: the saved replies
 * and whatever waits in the outbox. */
export async function clearData() {
  try {
    await caches.delete(DATA_CACHE);
  } catch {
    // No Cache API (an insecure origin): nothing was kept.
  }
  await clearOutbox();
}

// Sign-out clears the device's copy before leaving.
document.addEventListener('click', async e => {
  const out = e.target.closest('a[href="/auth/logout"]');
  if (!out) return;
  e.preventDefault();
  await clearData();
  location.assign(out.href);
});

/** Resolves true once a service worker controls the page (so fetches pass
 * through it), false if none does in time. */
function controlled() {
  const sw = navigator.serviceWorker;
  if (!sw) return false;
  if (sw.controller) return true;
  return new Promise(done => {
    sw.addEventListener('controllerchange', () => done(true), { once: true });
    setTimeout(() => done(false), CONTROL_WAIT);
  });
}

/** A low-priority GET through the service worker, which keeps its reply. Throws
 * `offline` when the network is gone, so warming stops. */
async function get(url) {
  const r = await fetch(url, { priority: 'low' });
  if (r.headers.has('X-Arno-Offline')) throw Object.assign(Error('Offline'), { offline: true });
  if (!r.ok) throw Error(url + ': ' + r.status);
  return r;
}

/** The kept JSON reply for url, or null. */
async function saved(url) {
  const r = await caches.match(url, { cacheName: DATA_CACHE, ignoreVary: true });
  return r ? r.json() : null;
}

/** Keeps one conversation: its transcript and artifacts when the list entry
 * shows a change (or `force`), and its images while the budget lasts. */
async function warmSession(row, budget, force) {
  const url = '/api/sessions/' + row.id;
  let s = force ? null : await saved(url);
  if (!s || s.updatedAt !== row.updatedAt || s.title !== row.title) {
    s = await (await get(url)).json();
    const { artifacts } = await (await get(url + '/artifacts')).json();
    for (const a of artifacts) await (await get(url + '/artifacts/' + a.id)).blob();
  }
  for (const turn of s.history || [])
    for (const a of turn.attachments || []) {
      if (a.kind !== 'image' || !a.size || a.size > budget.left) continue;
      budget.left -= a.size;
      const image = url + '/attachments/' + a.id;
      if (!(await caches.match(image, { cacheName: DATA_CACHE }))) await (await get(image)).blob();
    }
}

/** Drops kept replies of conversations no longer in the list (deleted elsewhere). */
async function prune(rows) {
  const ids = new Set(rows.map(r => r.id)),
    cache = await caches.open(DATA_CACHE);
  for (const request of await cache.keys()) {
    const id = new URL(request.url).pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})/)?.[1];
    if (id && !ids.has(id)) await cache.delete(request);
  }
}

async function warmAll(rows, force) {
  if (!(await controlled())) return;
  // On a first visit the page loaded before the worker took over, so its own
  // reads were not kept: fetch them again, with the pages opened less often.
  if (!force)
    for (const url of BOOT_READS)
      await get(url).then(
        r => r.blob(),
        () => {},
      );
  const queue = [...rows],
    budget = { left: WARM_BYTES };
  const worker = async () => {
    for (let row; (row = queue.shift());)
      try {
        await warmSession(row, budget, force);
      } catch (e) {
        if (e.offline) queue.length = 0;
      }
  };
  await Promise.all(Array.from({ length: WARM_AT_ONCE }, worker));
  if (!force && !state.offline) await prune(rows);
}

let warming = Promise.resolve(); // passes run one after another
/** Warms the cache in the background with every listed conversation (or, with
 * `force`, refetches the given ones, as after a turn). Returns when done. */
export function warm(rows = state.sessions, force = false) {
  if (!('caches' in window)) return warming;
  warming = warming.then(() => warmAll(rows, force)).catch(() => {});
  return warming;
}
