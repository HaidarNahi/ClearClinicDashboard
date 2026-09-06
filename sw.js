/* Clear Pulse service worker — offline shell.
   Never caches Identity, functions, or the Firebase socket. */
const V = 'cp-v1';
const SHELL = [
  '/', '/index.html', '/404.html', '/privacy.html',
  '/css/app.css', '/css/shell.css',
  '/js/app.js', '/js/util.js', '/js/auth.js', '/js/store.js', '/js/ui.js', '/js/views.js',
  '/assets/favicon.svg', '/assets/logo.avif', '/site.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;            // let CDNs and Firebase pass through
  if (url.pathname.startsWith('/.netlify/')) return;      // never cache auth or functions
  if (url.pathname === '/sw.js') return;

  // HTML: network first, so a deploy is picked up immediately
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(V).then(c => c.put('/index.html', copy));
        return r;
      }).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // static: cache first, refresh in background
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(r => {
        if (r && r.status === 200) caches.open(V).then(c => c.put(e.request, r.clone()));
        return r;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
