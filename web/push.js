/** Push notifications for finished turns: turn them on or off for this browser.
 * On, the service worker (sw.js) is registered and subscribed with the server's
 * VAPID key; off, both sides forget the subscription and the worker goes. The
 * worker is registered only while notifications are on. Depends on core.
 */
import { api } from './core.js';

const supported =
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** iPhone and iPad offer push only to web apps added to the Home Screen. */
const iosBrowser =
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)) &&
  navigator.standalone === false &&
  !('PushManager' in window);

function keyBytes(key) {
  return Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

/** The browser's push subscription for this app, or null. */
async function subscription() {
  const registration = await navigator.serviceWorker.getRegistration('/');
  return (await registration?.pushManager.getSubscription()) || null;
}

/** 'ios', 'unsupported', 'blocked', 'on' or 'off'. */
export async function pushState() {
  if (iosBrowser) return 'ios';
  if (!supported) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return Notification.permission === 'granted' && (await subscription()) ? 'on' : 'off';
}

export async function enablePush() {
  if ((await Notification.requestPermission()) !== 'granted')
    throw Error('Notifications are blocked for this site in the browser settings.');
  const { key } = await api('/api/push/key');
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const sub =
    (await registration.pushManager.getSubscription()) ||
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(key),
    }));
  await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
}

export async function disablePush() {
  const sub = await subscription();
  if (sub) {
    await api('/api/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    await sub.unsubscribe();
  }
  await (await navigator.serviceWorker.getRegistration('/'))?.unregister();
}
