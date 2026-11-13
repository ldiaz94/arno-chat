/** "Update available" bar: when a new service worker (sw.js) has installed and
 * waits, shows a bar with an Update button. Update tells the waiting worker to
 * take over, and the page reloads once it does; the bar shows above any open
 * dialog too (place). Nothing reloads by itself, so a conversation in progress
 * is never interrupted. It also asks the server for
 * a new worker when the page becomes visible and every 30 minutes, because an
 * installed app on a phone is rarely reloaded.
 *
 * Depends on nothing; offline.js calls watchUpdates after registering.
 */

const CHECK_EVERY = 30 * 60 * 1000; // ms between update checks
let bar = null; // the bar, once shown
let reloading = false; // set by the Update button; the reload happens once

/** The version of the app this device runs, as its service worker says
 * ('v24'), or '' when there is none or it doesn't answer within a second. */
export function appVersion() {
  const worker = navigator.serviceWorker?.controller;
  if (!worker) return Promise.resolve('');
  return new Promise(done => {
    const timer = setTimeout(() => done(''), 1000);
    const heard = e => {
      if (e.data?.type !== 'VERSION') return;
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('message', heard);
      done(e.data.version);
    };
    navigator.serviceWorker.addEventListener('message', heard);
    worker.postMessage({ type: 'VERSION' });
  });
}
/** Asks the server for a new version now: true when one is waiting after. */
export async function checkForUpdate() {
  const registration = await navigator.serviceWorker?.getRegistration();
  if (!registration) return false;
  await registration.update().catch(() => {});
  if (registration.installing)
    await new Promise(done =>
      registration.installing.addEventListener('statechange', function wait() {
        if (this.state !== 'installing') done();
      }),
    );
  return !!registration.waiting;
}
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
  place();
  new MutationObserver(place).observe(document.body, {
    subtree: true,
    attributeFilter: ['open'],
  });
}
/** Puts the bar in the topmost open modal dialog, or the page when none is
 * open: a modal sits in the top layer and makes the rest of the page inert,
 * so a bar outside it would be hidden behind it and could not be pressed. */
function place() {
  if (!bar) return;
  const modals = [...document.querySelectorAll('dialog[open]')].filter(d => d.matches(':modal'));
  const home = modals.at(-1) || document.body;
  if (bar.parentNode !== home) home.append(bar);
}
