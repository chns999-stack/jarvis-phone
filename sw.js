// Keeps the app opening with no signal; the relay itself is always live.
const CACHE = 'jarvis-phone-v11'
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.origin !== location.origin || e.request.method !== 'GET') return
  // Network first, so updates land; the cache when there is no signal.
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache' })
      .then((r) => {
        const copy = r.clone()
        caches.open(CACHE).then((c) => c.put(e.request, copy))
        return r
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r ?? caches.match('index.html'))),
  )
})
