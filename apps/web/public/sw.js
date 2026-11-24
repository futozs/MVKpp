const SHELL_CACHE = "mvk-shell-v8";
const SHELL_ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];
/** a buildenként új /_next/static darabok ne gyűljenek a végtelenségig */
const SHELL_CACHE_MAX = 400;

// Térkép: a csempék és a fontok/ikonok címében verzió van (immutable), ezért cache-first.
// A kézzel letöltött offline csomag (mvk-map-pack-*) a lapé: a SW csak olvassa, sosem törli.
const TILE_CACHE = "mvk-map-tiles-v1";
const TILE_CACHE_MAX = 3000;
const ASSET_CACHE = "mvk-map-assets-v1";
const PACK_PREFIX = "mvk-map-pack-";
const KEEP = [SHELL_CACHE, TILE_CACHE, ASSET_CACHE];

/** cache-enkénti írásszámláló: nem minden íráskor listázzuk végig a cache-t */
const puts = new Map();

async function trim(name, max) {
  const cache = await caches.open(name);
  // az app váza (offline indulás) sosem esik ki
  const keys = (await cache.keys()).filter((k) => !SHELL_ASSETS.includes(new URL(k.url).pathname));
  if (keys.length <= max) return;
  // a legrégebbiek mennek (a kulcsok beírási sorrendben jönnek), egy kis ráhagyással
  const excess = keys.length - Math.floor(max * 0.8);
  await Promise.all(keys.slice(0, excess).map((k) => cache.delete(k)));
}

async function store(name, max, request, response) {
  try {
    const cache = await caches.open(name);
    await cache.put(request, response);
    const n = (puts.get(name) || 0) + 1;
    puts.set(name, n);
    if (n % 150 === 0) await trim(name, max);
  } catch (err) {
    // betelt a tárhely: a futás közbeni térkép-cache megy, az offline csomag marad
    if (err && err.name === "QuotaExceededError") await caches.delete(TILE_CACHE);
  }
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
            .filter((k) => !KEEP.includes(k) && !k.startsWith(PACK_PREFIX))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => Promise.all([trim(TILE_CACHE, TILE_CACHE_MAX), trim(SHELL_CACHE, SHELL_CACHE_MAX)]))
      .then(() => self.clients.claim()),
  );
});

// Ezek mindig hálózatról jönnek (élő vagy személyes adat)  a service worker
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

/** Csempe / font / ikon: bármelyik cache-ből (az offline csomagból is), különben hálózat és mentés. */
function mapAsset(event, cacheName, max) {
  const { request } = event;
  event.respondWith(
    caches.match(request, { ignoreVary: true }).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((res) => {
        // 204: üres csempe (a készleten belül végleges); 206-ot és hibát nem mentünk
        if (res.ok && res.status !== 206 && res.type === "basic") event.waitUntil(store(cacheName, max, request, res.clone()));
        return res;
      });
    }),
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || request.headers.has("range")) return;
  // A modul-workerek (a térkép workere) betöltését a Safari elrontja, ha a SW válaszol rá.
  if (request.destination === "worker" || request.destination === "sharedworker") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/tiles/")) return mapAsset(event, TILE_CACHE, TILE_CACHE_MAX);
  if (url.pathname.startsWith("/map-assets/")) return mapAsset(event, ASSET_CACHE, Infinity);

  // Melyik csempekészlet él: hálózatról, offline a legutóbbi.
  if (url.pathname === "/tileset.json") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) event.waitUntil(store(SHELL_CACHE, SHELL_CACHE_MAX, request, res.clone()));
          return res;
        })
        .catch(() => caches.match(request).then((hit) => hit || Response.error())),
    );
    return;
  }

  if (LIVE_PREFIXES.some((p) => url.pathname.startsWith(p))) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/")));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) event.waitUntil(store(SHELL_CACHE, SHELL_CACHE_MAX, request, res.clone()));
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
  const url = (event.notification.data && event.notification.data.url) || "/#multistop";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Nyitott appnál nem töltünk újra: megkérjük, hogy a hivatkozott megállót mutassa.
      for (const client of clientList) {
        if (!("focus" in client)) continue;
        client.postMessage({ type: "mvk-open", url });
        return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});
