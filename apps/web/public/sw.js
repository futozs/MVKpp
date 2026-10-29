const SHELL_CACHE = "mvk-shell-v7";
const SHELL_ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

const TILE_CACHE = "mvk-tiles-v1";
const TILE_HOSTS = [
  "tile.openstreetmap.org",
  "tile.opentopomap.org",
  "server.arcgisonline.com",
];
const TILE_CACHE_MAX = 4000;

function isTileRequest(url) {
  const host = url.hostname;
  return TILE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

async function trimTileCache() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  if (keys.length <= TILE_CACHE_MAX) return;
  const excess = keys.length - TILE_CACHE_MAX;
  await Promise.all(keys.slice(0, excess).map((k) => cache.delete(k)));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== TILE_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => trimTileCache())
      .then(() => self.clients.claim()),
  );
});

// Ezek mindig hálózatról jönnek (élő vagy személyes adat) — a service worker
// nem gyorsítótárazza őket, különben régi járműhelyzetet / statisztikát mutatna.
const LIVE_PREFIXES = [
  "/live",
  "/gtfs",
  "/weather",
  "/system",
  "/engine",
  "/stats",
  "/account",
  "/push",
  "/v3",
  "/api",
  "/ws",
  "/_",
];

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (isTileRequest(url)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const res = await fetch(request);
        if (res.ok) {
          await cache.put(request, res.clone());
          if (Math.random() < 0.05) event.waitUntil(trimTileCache());
        }
        return res;
      }),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (LIVE_PREFIXES.some((p) => url.pathname.startsWith(p))) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/")));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || "MVK értesítés";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icon-192.png",
      tag: data.tag,
      renotify: true,
      requireInteraction: false,
      data: { url: data.url || "/#multistop" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      const url = (event.notification.data && event.notification.data.url) || "/#multistop";
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});
