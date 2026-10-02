self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  event.waitUntil((async () => {
    const scopeUrl = new URL(self.registration.scope);
    let targetUrl;
    try {
      targetUrl = new URL(event.notification.data || './', scopeUrl);
    } catch (e) {
      targetUrl = scopeUrl;
    }
    if (targetUrl.origin !== scopeUrl.origin || !targetUrl.pathname.startsWith(scopeUrl.pathname)) {
      targetUrl = scopeUrl;
    }

    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = clients.find(candidate => {
      try {
        const url = new URL(candidate.url);
        return url.origin === scopeUrl.origin && url.pathname.startsWith(scopeUrl.pathname);
      } catch (e) {
        return false;
      }
    });

    if (client) {
      if (client.url !== targetUrl.href && 'navigate' in client) {
        try {
          await client.navigate(targetUrl.href);
        } catch (e) {}
      }
      return client.focus();
    }

    return self.clients.openWindow(targetUrl.href);
  })());
});

self.addEventListener('push', event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {
      title: '📖 TEMO',
      body: event.data ? event.data.text() : 'ახალი შეხსენება'
    };
  }

  const title = data.title || '📖 TEMO — ჩანაწერის შეხსენება';

  const options = {
    body: data.body || 'შეხსენების დრო მოვიდა',
    icon: data.icon || './icon.png',
    badge: data.badge || './icon.png',
    tag: data.tag || 'temo-note-reminder',
    requireInteraction: true,
    renotify: true,
    data: data.url || './'
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});
