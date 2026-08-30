/*
 * Service worker a telepíthetőséghez (Android „Kezdőképernyőre" prompt).
 *
 * Szándékosan minimális: CSAK az alkalmazás váza kerül gyorsítótárba.
 * A valós idejű végpontok (/live, /gtfs, /weather) SOHA — egy elmentett
 * járműpozíció rosszabb a semminél, mert helyesnek látszik.
 */
const SHELL_CACHE = 'mvk-shell-v1'
const SHELL_ASSETS = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

/** Ezekre soha nem nyúlunk hozzá: mindig a hálózat mondja meg az igazat. */
const LIVE_PREFIXES = ['/live', '/gtfs', '/weather', '/system', '/_health', '/_jwt', '/_export']

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (LIVE_PREFIXES.some((p) => url.pathname.startsWith(p))) return

  // Navigáció: hálózat először, offline esetén a mentett váz.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html')))
    return
  }

  // Statikus fájlok: gyorsítótárból azonnal, közben frissítjük.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy))
          }
          return res
        })
        .catch(() => cached)
      return cached || network
    })
  )
})
