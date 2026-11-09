/** "Update available" bar: when a new service worker (sw.js) has installed and
 * waits, shows a bar with an Update button. Update tells the waiting worker to
 * take over, and the page reloads once it does. Nothing reloads by itself, so
 * a conversation in progress is never interrupted. It also asks the server for
 * a new worker when the page becomes visible and every 30 minutes, because an
 * installed app on a phone is rarely reloaded.
 *
 * Depends on nothing; offline.js calls watchUpdates after registering.
 */

const CHECK_EVERY = 30 * 60 * 1000; // ms between update checks
let bar = null; // the bar, once shown
let reloading = false; // set by the Update button; the reload happens once

/** Watches a registration for a waiting worker and checks for new ones. */
export function watchUpdates(registration) {
  const offer = () => {
    // With no controller this is the first install, not an update.
    if (registration.waiting && navigator.serviceWorker.controller) show(registration.waiting);
  };
  offer();
  registration.addEventListener('updatefound', () =>
    registration.installing?.addEventListener('statechange', offer),
  );
  const check = () => registration.update().catch(() => {});
  document.addEventListener(
    'visibilitychange',
    () => document.visibilityState === 'visible' && check(),
  );
  setInterval(check, CHECK_EVERY);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) location.reload();
  });
}

/** Shows the bar (once) for the waiting worker. */
function show(worker) {
  if (bar) return;
  bar = document.createElement('div');
  bar.className = 'update-bar';
  bar.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = 'Update available';
  const update = document.createElement('button');
  update.className = 'primary';
  update.textContent = 'Update';
  update.addEventListener('click', () => {
    reloading = true;
    update.disabled = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
  });
  const dismiss = document.createElement('button');
  dismiss.className = 'ghost';
  dismiss.textContent = '×';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.addEventListener('click', () => {
    bar.remove();
    bar = null;
  });
  bar.append(text, update, dismiss);
  document.body.append(bar);
}
