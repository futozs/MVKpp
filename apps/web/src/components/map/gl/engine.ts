/**
 * A térképmotor betöltése: a MapLibre (és a workere) csak akkor jön le, amikor a
 * térkép kell. A csempekészletet a /tileset.json mondja meg; offline indításkor az
 * utoljára látott marad (a service worker a csempéit is megőrizte).
 */
import type { Tileset } from "./basemap";

type MapLibre = typeof import("maplibre-gl");

let lib: Promise<MapLibre> | null = null;

export function loadMapLibre(): Promise<MapLibre> {
  lib ??= import("maplibre-gl").then((m) => {
    // A worker a buildben külön (hash-elt) fájl; enélkül a MapLibre nem találná meg.
    m.setWorkerUrl(new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).toString());
    return m;
  });
  return lib;
}

/** A térkép előkészítése még a megnyitása előtt (a worker elindul, amíg a lap mást csinál). */
export function prewarmMap(): void {
  const run = () => void loadMapLibre().then((m) => m.prewarm());
  if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 600);
}

const TILESET_KEY = "mvk_tileset";

function isTileset(v: unknown): v is Tileset {
  if (typeof v !== "object" || v === null) return false;
  const t: { vector?: unknown; dem?: unknown } = v;
  return typeof t.vector === "string" && typeof t.dem === "string";
}

let tileset: Promise<Tileset> | null = null;

export function loadTileset(): Promise<Tileset> {
  tileset ??= fetch("/tileset.json", { cache: "no-cache" })
    .then(async (res) => {
      const body: unknown = await res.json();
      if (!res.ok || !isTileset(body)) throw new Error(`tileset.json: HTTP ${res.status}`);
      try {
        localStorage.setItem(TILESET_KEY, JSON.stringify(body));
      } catch {
        /* privát mód */
      }
      return body;
    })
    .catch((err: unknown) => {
      tileset = null;
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(TILESET_KEY) ?? "null");
        if (isTileset(saved)) return saved;
      } catch {
        /* nincs mentett */
      }
      throw err;
    });
  return tileset;
}

/** Gyenge (kevés memóriájú) eszköz: kevesebb csempe marad a memóriában. */
export function lowMemoryDevice(): boolean {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return mem != null && mem <= 4;
}
