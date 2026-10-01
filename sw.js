const CACHE = 'spanslator-v7';
const ASSETS = ['./', './index.html', './app.js', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
self.addEventListener('install', e => {
  // cache:'reload' bypasses the browser HTTP cache (GitHub Pages sends max-age=600)
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(ASSETS.map(a => fetch(new Request(a, { cache: 'reload' })).then(r => r.ok && c.put(a, r)).catch(() => {}))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network-first for everything same-origin (app.js, index.html, ...); cache is only the offline fallback.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return; // never touch translation API calls
  e.respondWith(
    fetch(req, { cache: 'no-store' }).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
