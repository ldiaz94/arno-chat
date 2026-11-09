/** Service worker, registered only while notifications are on (push.js). Pushes
 * carry no payload: on each one it fetches the notice with the user's cookie
 * and shows it, unless the app is already on screen. It has no fetch handler,
 * so it never touches the page's own requests. */
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

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
