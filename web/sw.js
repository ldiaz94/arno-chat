/** Service worker, registered at boot by offline.js. It does three things:
 *
 * - App shell: on install it caches every static file the app needs (SHELL),
 *   so the app opens with no network. Pages are fetched network-first (3 s,
 *   then the cached page); other static files stale-while-revalidate.
 * - Saved data: GETs of the read endpoints the UI needs (DATA) are
 *   network-first (6 s); each good reply is kept in the 'arno-data' cache,
 *   and when the network fails the kept copy is served with the header
 *   X-Arno-Offline: 1. Everything else (writes, job polling, live events,
 *   notices, the image proxy) passes straight through, never cached.
 * - Push: pushes carry no payload; on each one it fetches the notice with the
 *   user's cookie and shows it; a click opens its conversation.
 *
 * Deploying: bump VERSION whenever a file in SHELL changes, so installed apps
 * fetch the new shell. A new worker waits until the page's Update button
 * (update.js) sends SKIP_WAITING (test.mjs checks SHELL lists every web/ file).
 */
const VERSION = 'v28';
const SHELL_CACHE = 'arno-shell-' + VERSION;
const DATA_CACHE = 'arno-data'; // cleared by offline.js on sign-out
const SHELL = [
  '/',
  '/app.js',
  '/artifacts.js',
  '/diag.js',
  '/attach.js',
  '/code.js',
  '/core.js',
  '/home.js',
  '/highlight.mjs',
  '/home-content.js',
  '/info.js',
  '/layout.js',
  '/marks.js',
  '/models.js',
  '/offline.js',
  '/options.js',
  '/options.mjs',
  '/outbox.js',
  '/profile.js',
  '/push.js',
  '/queue.mjs',
  '/render.mjs',
  '/sessions.js',
  '/settings.js',
  '/thread.js',
  '/today.mjs',
  '/turns.js',
  '/update.js',
  '/usage.js',
  '/style.css',
  '/manifest.webmanifest',
  '/brand/apple-touch-icon.png',
  '/brand/icon-192.png',
  '/brand/icon-512.png',
  '/brand/icon-maskable-512.png',
  '/brand/logo.svg',
  '/brand/mascot.webp',
];
const DATA = [
  /^\/api\/(me|models|account|account\/avatar|sessions|usage\/requests)$/,
  /^\/api\/sessions\/[0-9a-f-]{36}$/,
  /^\/api\/sessions\/[0-9a-f-]{36}\/artifacts(\/[0-9a-f-]{36})?$/,
  /^\/api\/sessions\/[0-9a-f-]{36}\/attachments\/[^/]+$/,
];
const PAGE_WAIT = 3000; // ms before a page falls back to the cached shell
const DATA_WAIT = 6000; // ms before a read falls back to its saved copy

self.addEventListener('install', e =>
  e.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      // A first install activates at once; an update waits for the page's OK.
      .then(() => self.registration.active || self.skipWaiting()),
  ),
);

self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
  // The You tab's About card asks which version this device runs.
  if (e.data?.type === 'VERSION') e.source?.postMessage({ type: 'VERSION', version: VERSION });
});

self.addEventListener('activate', e =>
  e.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith('arno-shell-') && name !== SHELL_CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  ),
);

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) {
    if (DATA.some(re => re.test(url.pathname))) e.respondWith(dataRead(e, url));
  } else if (url.pathname.startsWith('/auth/')) return;
  else if (e.request.mode === 'navigate') e.respondWith(page(e));
  else e.respondWith(staticFile(e));
});

/** The network's reply, or after `ms` (or on failure) what `fallback` finds;
 * when the fallback has nothing, keeps waiting for the network. */
async function networkFirst(net, ms, fallback) {
  let timer;
  const late = new Promise(done => (timer = setTimeout(done, ms)));
  try {
    const r = await Promise.race([net, late]);
    if (r) return r;
    return (await fallback()) || (await net);
  } catch {
    return fallback();
  } finally {
    clearTimeout(timer);
  }
}

/** The page itself (any path: the app routes on the client), falling back to
 * the cached shell, which a fresh copy of / replaces. */
function page(e) {
  const net = fetch(e.request).then(r => {
    if (r.ok && !r.redirected && new URL(e.request.url).pathname === '/') {
      const copy = r.clone();
      e.waitUntil(caches.open(SHELL_CACHE).then(c => c.put('/', copy)));
    }
    return r;
  });
  e.waitUntil(net.catch(() => {}));
  return networkFirst(net, PAGE_WAIT, async () => {
    const shell = await caches.match('/', { cacheName: SHELL_CACHE });
    return shell || Response.error();
  });
}

/** A cached static file at once, refreshed in the background. */
async function staticFile(e) {
  const cache = await caches.open(SHELL_CACHE),
    saved = await cache.match(e.request),
    net = fetch(e.request).then(r => {
      if (r.ok && r.type === 'basic') e.waitUntil(cache.put(e.request, r.clone()));
      return r;
    });
  if (!saved) return net;
  e.waitUntil(net.catch(() => {}));
  return saved;
}

/** The profile picture's address carries a cache-busting stamp; one copy is kept. */
function dataKey(url) {
  return url.pathname === '/api/account/avatar' ? url.origin + url.pathname : url.href;
}

/** A read endpoint: network first, keeping each good reply; the kept copy,
 * marked X-Arno-Offline, when the network fails. A 404 drops the kept copy
 * (a deleted conversation, a removed picture). */
function dataRead(e, url) {
  const key = dataKey(url),
    net = fetch(e.request).then(r => {
      if (r.ok) {
        const copy = r.clone();
        e.waitUntil(caches.open(DATA_CACHE).then(c => c.put(key, copy).catch(() => {})));
      } else if (r.status === 404) e.waitUntil(caches.open(DATA_CACHE).then(c => c.delete(key)));
      return r;
    });
  e.waitUntil(net.catch(() => {}));
  return networkFirst(net, DATA_WAIT, async () => {
    const saved = await caches.match(key, { cacheName: DATA_CACHE, ignoreVary: true });
    if (!saved)
      return Response.json(
        { error: 'You are offline, and this was not saved on this device.' },
        { status: 503, headers: { 'X-Arno-Offline': '1' } },
      );
    const headers = new Headers(saved.headers);
    headers.set('X-Arno-Offline', '1');
    return new Response(saved.body, { status: saved.status, headers });
  });
}

async function appWindows() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
}

self.addEventListener('push', e =>
  e.waitUntil(
    (async () => {
      let notice = { title: 'Arno', body: 'Your reply is ready.', url: '/' };
      try {
        const r = await fetch('/api/notifications/latest', {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (r.ok) notice = await r.json();
      } catch {
        // Show the generic notice: a push must always show one.
      }
      await self.registration.showNotification(notice.title, {
        body: notice.body,
        icon: '/brand/icon-192.png',
        badge: '/brand/icon-192.png',
        data: { url: notice.url },
        tag: 'arno-turn',
      });
    })(),
  ),
);

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil(
    (async () => {
      const open = (await appWindows())[0];
      if (open) {
        await open.focus();
        try {
          await open.navigate(url);
          return;
        } catch {
          // An uncontrolled window cannot be navigated: open a new one.
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
