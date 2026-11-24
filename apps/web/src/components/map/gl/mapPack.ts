/**
 * Offline térkép: Miskolc csempéi (alaptérkép z5–15, domborzat), a fontok és az ikonok
 * egy külön cache-be, amit a service worker csak olvas. A csomag a csempekészlet
 * verziójához kötött; új készletnél az új letöltése után a régi törlődik. Megszakadás
 * után folytatható (ami már megvan, nem jön le újra), a végén egy jelző bejegyzés
 * mondja, hogy kész  a Safari az egész tárhelyet is kiürítheti, ezt is innen látjuk.
 */
import { ASSETS_PATH, type Tileset } from "./basemap";
import { loadTileset } from "./engine";

const PACK_PREFIX = "mvk-map-pack-";
const MARKER = "/__mvk-pack/complete";
/** az MVK megállói (és egy kis ráhagyás): [nyugat, dél, kelet, észak] */
const BBOX: [number, number, number, number] = [20.51, 48.03, 20.89, 48.17];
const VECTOR_ZOOM: [number, number] = [5, 15];
const DEM_ZOOM: [number, number] = [5, 11];
const FONTS = ["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic"];
const RANGES = ["0-255", "256-511", "8192-8447"];
const SPRITES = ["light", "dark", "grayscale"];
const CONCURRENCY = 4;
/** a gombon mutatott méret: ennyi helyet foglal a telefonon (mérve: 10,9 MB) */
export const PACK_SIZE_MB = 11;

export type PackState =
  | { status: "none" }
  | { status: "downloading"; done: number; total: number }
  | { status: "ready"; bytes: number; at: number }
  | { status: "error" };

type Marker = { bytes: number; at: number };

function lon2x(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function lat2y(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

function tileUrls(name: string, ext: string, [z0, z1]: [number, number]): string[] {
  const urls: string[] = [];
  for (let z = z0; z <= z1; z++) {
    const [x0, x1] = [lon2x(BBOX[0], z), lon2x(BBOX[2], z)];
    const [y0, y1] = [lat2y(BBOX[3], z), lat2y(BBOX[1], z)];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) urls.push(`/tiles/${name}/${z}/${x}/${y}.${ext}`);
  }
  return urls;
}

function packUrls(ts: Tileset): string[] {
  const scale = window.devicePixelRatio > 1 ? "@2x" : "";
  return [
    ...tileUrls(ts.vector, "mvt", VECTOR_ZOOM),
    ...tileUrls(ts.dem, "webp", DEM_ZOOM),
    ...FONTS.flatMap((f) => RANGES.map((r) => `${ASSETS_PATH}/fonts/${encodeURIComponent(f)}/${r}.pbf`)),
    ...SPRITES.flatMap((s) => [`${ASSETS_PATH}/sprites/${s}${scale}.json`, `${ASSETS_PATH}/sprites/${s}${scale}.png`]),
    "/tileset.json",
  ];
}

const cacheName = (ts: Tileset) => `${PACK_PREFIX}${ts.vector}-${ts.dem}`;

export function packSupported(): boolean {
  return typeof caches !== "undefined" && "serviceWorker" in navigator;
}

export async function packState(ts: Tileset): Promise<PackState> {
  // a caches.open üres cache-t hozna létre: előbb megnézzük, van-e
  if (!packSupported() || !(await caches.has(cacheName(ts)))) return { status: "none" };
  const cache = await caches.open(cacheName(ts));
  const hit = await cache.match(MARKER);
  if (!hit) return { status: "none" };
  const m: Marker = await hit.json();
  return { status: "ready", bytes: m.bytes, at: m.at };
}

/** Van-e korábbi készlethez letöltött csomag (a felhasználó egyszer már kérte). */
export async function hasOlderPack(ts: Tileset): Promise<boolean> {
  if (!packSupported()) return false;
  const name = cacheName(ts);
  return (await caches.keys()).some((k) => k.startsWith(PACK_PREFIX) && k !== name);
}

export async function downloadPack(ts: Tileset, onProgress: (done: number, total: number) => void, signal?: AbortSignal): Promise<PackState> {
  const cache = await caches.open(cacheName(ts));
  const urls = packUrls(ts);
  let done = 0;
  let bytes = 0;
  let failed = 0;
  let next = 0;
  onProgress(0, urls.length);
  const worker = async () => {
    while (next < urls.length && !signal?.aborted) {
      const url = urls[next++];
      const have = await cache.match(url);
      if (have) {
        bytes += (await have.clone().blob()).size;
      } else {
        try {
          const res = await fetch(url, { signal });
          // 204: üres csempe (pl. a megyehatáron kívül)  ez is a csomag része
          if (res.ok) {
            const body = await res.clone().blob();
            bytes += body.size;
            await cache.put(url, res);
          } else failed++;
        } catch {
          failed++;
        }
      }
      onProgress(++done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (signal?.aborted || failed > 0) return { status: "error" };
  const marker: Marker = { bytes, at: Date.now() };
  await cache.put(MARKER, new Response(JSON.stringify(marker), { headers: { "Content-Type": "application/json" } }));
  // a régi készlet csomagja ezzel feleslegessé vált
  const keep = cacheName(ts);
  for (const k of await caches.keys()) if (k.startsWith(PACK_PREFIX) && k !== keep) await caches.delete(k);
  return { status: "ready", bytes, at: marker.at };
}

/** Automatikus frissítés csak telepített appban, nem mobilnetről, adatkímélő mód nélkül. */
export function quietDownloadAllowed(): boolean {
  const c = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean; effectiveType?: string } }).connection;
  if (!c || c.saveData || c.type === "cellular" || c.effectiveType === "2g" || c.effectiveType === "3g") return false;
  return window.matchMedia("(display-mode: standalone)").matches;
}

/**
 * Ha a felhasználó egyszer már letöltötte a csomagot, de azóta új csempekészlet él,
 * a térkép megnyitásakor csendben letöltjük az újat (csak ha `quietDownloadAllowed`).
 */
export async function refreshPack(): Promise<void> {
  if (!packSupported() || !quietDownloadAllowed()) return;
  const ts = await loadTileset();
  if (!(await hasOlderPack(ts)) || (await packState(ts)).status !== "none") return;
  await downloadPack(ts, () => undefined);
}
