// Service worker: app shell offline, catalog network-first, covers cache-first.
const SHELL = 'folio-shell-v4';
const DATA = 'folio-data-v1';
const COVERS = 'folio-covers';
const SHELL_FILES = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => ![SHELL, DATA, COVERS].includes(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw new Error('offline');
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    if (url.pathname === '/api/catalog') return e.respondWith(networkFirst(req, DATA));
    if (url.pathname.startsWith('/api/cover/')) return e.respondWith(cacheFirst(req, COVERS));
    if (url.pathname.startsWith('/api/')) return; // book text: handled by IndexedDB in the app
    if (req.mode === 'navigate') return e.respondWith(networkFirst(new Request('/index.html'), SHELL));
    return e.respondWith(networkFirst(req, SHELL));
  }

  // Google Fonts
  if (url.host.endsWith('googleapis.com') || url.host.endsWith('gstatic.com')) {
    return e.respondWith(cacheFirst(req, SHELL));
  }
});
