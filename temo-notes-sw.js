self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then(clients => {
      for (const client of clients) {
        if ('focus' in client) {
          return client.focus();
        }
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow('./');
      }
    })
  );
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
    silent: false,
    requireInteraction: true,
    renotify: true,
    data: data.url || './'
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});
