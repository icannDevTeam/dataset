const CACHE_NAME = 'teacher-pwa-v3';
const PRECACHE = [
  '/teacher-manifest.webmanifest',
  '/binus-logo.jpg',
  '/pwa/teacher-icon-192.svg',
  '/pwa/teacher-icon-512.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // NEVER cache live API calls — stale feed data caused iPads to act on
  // events that no longer exist ("event not found" on Release/Hold).
  if (url.pathname.startsWith('/api/')) return;

  // Navigation: always go to network so new deploys land. Fall back to
  // a cached shell only when offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/pickup/teacher'))
    );
    return;
  }

  // Next.js hashed assets are immutable — safe to cache forever.
  // The HTML always references the latest hashes, so we never serve a
  // mismatched bundle. Use stale-while-revalidate for everything else.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
        }
        return res;
      }))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request).then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
