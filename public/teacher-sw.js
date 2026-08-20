const CACHE_NAME = 'teacher-pwa-v8';
const PRECACHE = [
  '/teacher-manifest.webmanifest',
  '/binus-logo.jpg',
  '/apple-touch-icon.png',
  '/pwa/teacher-icon-192.png',
  '/pwa/teacher-icon-512.png',
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

  // For this deployment we run Next in dev mode on LAN during ops, where
  // chunk filenames are stable (main.js/_app.js) rather than content-hashed.
  // Cache-first here can pin stale JS forever (e.g. old gate-window labels).
  // Use network-first so tablets always pick up current runtime bundles.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(event.request))
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
