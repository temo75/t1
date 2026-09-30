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

  const notification = data.notification || data;
  const title = notification.title || data.title || '📖 TEMO — ჩანაწერის შეხსენება';

  const options = {
    body: notification.body || data.body || 'შეხსენების დრო მოვიდა',
    icon: notification.icon || data.icon || './icon.png',
    badge: notification.badge || data.badge || './icon.png',
    tag: notification.tag || data.tag || 'temo-note-reminder',
    silent: notification.silent === true ? true : false,
    requireInteraction: notification.requireInteraction !== false,
    renotify: notification.renotify !== false,
    data: notification.navigate || data.url || './'
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});
