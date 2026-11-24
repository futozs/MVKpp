/**
 * A járművek mozgása a térképen: ugyanaz a mozgásbecslés, mint eddig (negyedmásodpercenként
 * új cél a tanított modellből, a jármű sosem tolat vissza), két ütem között a kép minden
 * képkockán egyenletesen siklik. A kirajzolás a GPU-n (`VehicleLayer`), itt csak a helyek
 * és a csempék képei készülnek.
 */
import type { LiveMotion, LiveVehicle } from "@/types";
import type { GeoPosition } from "@/hooks/useGeolocation";
import { estimatePosition, type Shown } from "../liveMotion";
import { lerp, metersBetween } from "./chaseCam";
import { IMAGE_PAD, type AtlasEntry, type BadgeAtlas, type BadgeSpec } from "./badges";
import type { Sprite } from "./vehicleLayer";

/** a becslés üteme (ms) */
export const TICK_MS = 250;
/** ekkora ugrásnál nem siklik, hanem odaugrik (m)  új menet, hibás illesztés */
const SNAP_M = 400;

/** [lon, lat, magasság m]  a MapLibre sorrendje */
export type Pos = [number, number, number];

/** amit a becsléshez tudni kell egy járműről */
export type MotionSubject = { id: string; lat: number | null; lon: number | null; motion?: LiveMotion | null };

export type Track = { v: MotionSubject; shown?: Shown; from: Pos; to: Pos; t0: number; drawn: Pos };

export function newTrack(v: MotionSubject, pos: Pos, t: number): Track {
  return { v, from: pos, to: pos, t0: t, drawn: pos };
}

/** Hol jár a kép `t` pillanatban (az utolsó két cél között). */
export function trackAt(tr: Track, t: number): Pos {
  const k = (t - tr.t0) / TICK_MS;
  if (k >= 1) return tr.to;
  if (k <= 0) return tr.from;
  return [lerp(tr.from[0], tr.to[0], k), lerp(tr.from[1], tr.to[1], k), lerp(tr.from[2], tr.to[2], k)];
}

/** Új cél: onnan indul, ahol a kép most látszik (nagy ugrásnál nem siklik). */
export function retarget(tr: Track, target: Pos | null, t: number): void {
  if (!target) return;
  const cur = trackAt(tr, t);
  const far = metersBetween([cur[1], cur[0]], [target[1], target[0]]) > SNAP_M;
  tr.from = far ? target : cur;
  tr.to = target;
  tr.t0 = t;
}

/**
 * Hova tart a jármű most: a mozgásbecslés, vagy a valós jel helye. `freeze`: a valós jel
 * helyén áll (távoli Volán / vonat); `gps`: ezen a buszon utazol; `elevation`: a terep
 * magassága (3D), különben 0.
 */
export function estimateTarget(tr: Track, nowServer: number, freeze: boolean, gps: GeoPosition | null, elevation: (lon: number, lat: number) => number): Pos | null {
  const v = tr.v;
  if (freeze) {
    tr.shown = undefined;
    return v.lat != null && v.lon != null ? [v.lon, v.lat, elevation(v.lon, v.lat)] : null;
  }
  const est = estimatePosition(v.motion, nowServer, tr.shown, gps);
  if (!est) return v.lat != null && v.lon != null ? [v.lon, v.lat, elevation(v.lon, v.lat)] : null;
  tr.shown = est.shown;
  const [lat, lon] = est.latlng;
  return [lon, lat, elevation(lon, lat)];
}

const EARTH_R = 6371008.8;
const EARTH_C = 2 * Math.PI * EARTH_R;

/** lon/lat/m → Mercator 0..1 (z: magasság ugyanabban az egységben) a GPU-rétegnek */
export function toSprite(p: Pos, entry: AtlasEntry, alpha: number): Sprite {
  const lat = Math.max(-85.051129, Math.min(85.051129, p[1]));
  const my = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
  return { mx: (180 + p[0]) / 360, my, mz: p[2] / (EARTH_C * Math.cos((lat * Math.PI) / 180)), entry, alpha };
}

/** egy jármű kirajzolása: csempe, alatta (ha kell) a rendszám, átlátszóság, sorrend */
export type VehicleSpec = { v: LiveVehicle; badge: BadgeSpec; label: string | null; alpha: number; z: number };

type Entry = Track & { v: LiveVehicle; spec: VehicleSpec; badge: AtlasEntry; label: AtlasEntry | null; gen: number };

/** A pont a kép látható részére esik-e (az árnyék ráhagyása nélkül, `slop` px tűréssel). */
export function hits(b: AtlasEntry, c: { x: number; y: number }, x: number, y: number, slop: number): boolean {
  const p = IMAGE_PAD - slop;
  return x >= c.x + b.x + p && x <= c.x + b.x + b.w - p && y >= c.y + b.y + p && y <= c.y + b.y + b.h - p;
}

export class VehicleSet {
  private entries = new Map<string, Entry>();
  /** alulról felfelé (a `z` szerint) */
  private order: Entry[] = [];

  constructor(private readonly atlas: BadgeAtlas) {}

  /** A látható járművek: az újak kikerülnek, a régiek frissülnek, az eltűntek lekerülnek. */
  sync(specs: VehicleSpec[], t: number, elevation: (lon: number, lat: number) => number): void {
    const seen = new Set<string>();
    for (const s of specs) {
      const { v } = s;
      if (v.lat == null || v.lon == null) continue;
      seen.add(v.id);
      const e = this.entries.get(v.id);
      if (!e) {
        const pos: Pos = [v.lon, v.lat, elevation(v.lon, v.lat)];
        this.entries.set(v.id, { ...newTrack(v, pos, t), v, spec: s, ...this.images(s) });
        continue;
      }
      e.v = v;
      if (e.spec.badge !== s.badge || e.spec.label !== s.label) Object.assign(e, this.images(s));
      e.spec = s;
      // Nincs becslés (áll a kiinduló megállóban, vagy nincs menete): a valós jel helye.
      if (!v.motion) {
        e.shown = undefined;
        retarget(e, [v.lon, v.lat, elevation(v.lon, v.lat)], t);
      }
    }
    for (const id of this.entries.keys()) if (!seen.has(id)) this.entries.delete(id);
    this.order = [...this.entries.values()].sort((a, b) => a.spec.z - b.spec.z);
  }

  private images(s: VehicleSpec): { badge: AtlasEntry; label: AtlasEntry | null; gen: number } {
    const badge = this.atlas.badge(s.badge);
    const label = s.label ? this.atlas.label(s.label, s.badge.tracked) : null;
    return { badge, label, gen: this.atlas.generation };
  }

  /** Új célok a becslésből (`TICK_MS`-enként). */
  tick(nowServer: number, t: number, freeze: (v: LiveVehicle) => boolean, gpsFor: (v: LiveVehicle) => GeoPosition | null, elevation: (lon: number, lat: number) => number): void {
    for (const e of this.order) retarget(e, estimateTarget(e, nowServer, freeze(e.v), gpsFor(e.v), elevation), t);
  }

  /** Ennyi méter/mp a leggyorsabb látható jármű: ebből dől el, milyen sűrűn kell újrarajzolni. */
  maxSpeed(): number {
    let max = 0;
    for (const e of this.order) {
      const m = e.v.motion;
      if (m && m.v > max) max = m.v;
    }
    return max;
  }

  /** Képkockánként: a rendszámok alul, fölöttük a csempék (a fontosabb később, felül). */
  collect(t: number, labels: Sprite[], badges: Sprite[]): void {
    const gen = this.atlas.generation;
    for (const e of this.order) {
      if (e.gen !== gen) Object.assign(e, this.images(e.spec));
      const p = trackAt(e, t);
      e.drawn = p;
      if (e.label) labels.push(toSprite(p, e.label, e.spec.alpha));
      badges.push(toSprite(p, e.badge, e.spec.alpha));
    }
  }

  /** A legfelső jármű, amelynek csempéje a pontra esik (a képernyőre vetítés a térképé). */
  pick(project: (p: Pos) => { x: number; y: number }, x: number, y: number, slop: number): LiveVehicle | null {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const e = this.order[i];
      const c = project(e.drawn);
      if (hits(e.badge, c, x, y, slop)) return e.v;
    }
    return null;
  }

  /** Hol látszik most a jármű (a buborék ide mutat). */
  drawnOf(id: string): Pos | null {
    return this.entries.get(id)?.drawn ?? null;
  }

  vehicle(id: string): LiveVehicle | null {
    return this.entries.get(id)?.v ?? null;
  }

  clear(): void {
    this.entries.clear();
    this.order = [];
  }
}
