const CACHE_NAME = 'gc-cache-v5';
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Los datos en vivo (API y fotos) nunca se sirven de caché.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/photo') || url.pathname.startsWith('/.netlify/functions/')) return;
  if (event.request.method !== 'GET') return;

  // Red primero: así cada visita usa siempre la última versión publicada.
  // Solo se recurre a la copia guardada si no hay conexión.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ---------------------------------------------------------------------
// Notificaciones push: alguien del grupo ha añadido un gasto o un pago
// ---------------------------------------------------------------------

self.addEventListener('push', (event) => {
  let data = { title: 'Apokina la Pasta', body: 'Hay novedades en tu grupo' };
  try {
    if (event.data) data = event.data.json();
  } catch (e) { /* si no viene JSON, usamos el mensaje por defecto */ }

  event.waitUntil(
    self.registration.showNotification(data.title || 'Apokina la Pasta', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'apokina-movimiento',
      renotify: true,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      const existing = clientsArr.find((c) => 'focus' in c);
      if (existing) return existing.focus();
      return self.clients.openWindow('/');
    })
  );
});
