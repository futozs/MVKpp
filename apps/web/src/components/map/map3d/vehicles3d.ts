/**
 * A járművek a 3D térképen: ugyanaz a csempe és ugyanaz a mozgásbecslés, mint a
 * 2D-ben (negyedmásodpercenként új cél), de két ütem között a jelölő minden
 * képkockán egyenletesen siklik  a követő kamera is folyamatosan halad vele.
 */
import { Marker, Popup, type Map as MLMap } from "maplibre-gl";
import type { LiveMotion, LiveVehicle } from "@/types";
import type { GeoPosition } from "@/hooks/useGeolocation";
import { getActiveRide } from "@/lib/rides";
import { estimatePosition, type Shown } from "../liveMotion";
import { VEHICLE_ICON_SIZE } from "../vehicleIcon";
import { vehiclePopupHtml, wireVehiclePopup } from "../vehiclePopup";
import { lerp, metersBetween } from "./chaseCam";

/** a becslés üteme (ms)  mint a 2D-ben */
export const TICK_MS = 250;
/** ekkora ugrásnál nem siklik, hanem odaugrik (m)  új menet, hibás illesztés */
const SNAP_M = 400;
/** a terep mögé került jelölő ennyire látszik */
const COVERED_OPACITY = "0.2";

/** [lon, lat]  a MapLibre sorrendje */
export type LngLat = [number, number];

/** amit a becsléshez tudni kell egy járműről */
export type MotionSubject = { id: string; lat: number | null; lon: number | null; motion?: LiveMotion | null };

export type Track = { v: MotionSubject; shown?: Shown; from: LngLat; to: LngLat; t0: number; drawn: LngLat };

export function newTrack(v: MotionSubject, pos: LngLat, t: number): Track {
  return { v, from: pos, to: pos, t0: t, drawn: pos };
}

/** Hol jár a jelölő `t` pillanatban (az utolsó két cél között). */
export function trackAt(tr: Track, t: number): LngLat {
  const k = (t - tr.t0) / TICK_MS;
  if (k >= 1) return tr.to;
  if (k <= 0) return tr.from;
  return [lerp(tr.from[0], tr.to[0], k), lerp(tr.from[1], tr.to[1], k)];
}

/** Új cél: onnan indul, ahol a jelölő most látszik (nagy ugrásnál nem siklik). */
export function retarget(tr: Track, target: LngLat | null, t: number): void {
  if (!target) return;
  const cur = trackAt(tr, t);
  const far = metersBetween([cur[1], cur[0]], [target[1], target[0]]) > SNAP_M;
  tr.from = far ? target : cur;
  tr.to = target;
  tr.t0 = t;
}

/**
 * Hova tart a jármű most: a mozgásbecslés (mint a 2D-ben), vagy a valós jel helye.
 * `freeze`: a valós jel helyén áll (távoli Volán / vonat); `gps`: ezen a buszon utazol.
 */
export function estimateTarget(tr: Track, nowServer: number, freeze: boolean, gps: GeoPosition | null): LngLat | null {
  const v = tr.v;
  const raw: LngLat | null = v.lat != null && v.lon != null ? [v.lon, v.lat] : null;
  if (freeze) {
    tr.shown = undefined;
    return raw;
  }
  const est = estimatePosition(v.motion, nowServer, tr.shown, gps);
  if (!est) return raw;
  tr.shown = est.shown;
  return [est.latlng[1], est.latlng[0]];
}

/** A csempe-jelölő eleme (a `.mvk-vehicle` stílusai a 2D-vel közösek). */
export function vehicleElement(html: string, interactive: boolean): HTMLDivElement {
  const el = document.createElement("div");
  el.className = interactive ? "mvk-v3d" : "mvk-v3d mvk-v3d-static";
  el.style.width = `${VEHICLE_ICON_SIZE[0]}px`;
  el.style.height = `${VEHICLE_ICON_SIZE[1]}px`;
  el.innerHTML = html;
  return el;
}

export function vehicleMarker(map: MLMap, el: HTMLElement, pos: LngLat, opacity = 1): Marker {
  return new Marker({ element: el, anchor: "center", subpixelPositioning: true, opacity: String(opacity), opacityWhenCovered: COVERED_OPACITY }).setLngLat(pos).addTo(map);
}

/** egy jármű kirajzolási adatai; a HTML csak akkor készül el, ha a `key` változott */
export type MarkerSpec = { v: LiveVehicle; key: string; html: () => string; z: number; opacity: number };

type Entry = Track & { v: LiveVehicle; marker: Marker; el: HTMLDivElement; key: string };

export class VehicleMarkers {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly map: MLMap,
    private readonly onFocusTrip: (tripId: string, vehicleId?: string) => void,
  ) {}

  /** A látható járművek: az újak kikerülnek, a régiek frissülnek, az eltűntek lekerülnek. */
  sync(specs: MarkerSpec[], t: number): void {
    const seen = new Set<string>();
    for (const s of specs) {
      const { v } = s;
      if (v.lat == null || v.lon == null) continue;
      seen.add(v.id);
      const e = this.entries.get(v.id);
      if (!e) {
        this.entries.set(v.id, this.create(s, [v.lon, v.lat], t));
        continue;
      }
      e.v = v;
      if (e.key !== s.key) {
        e.el.innerHTML = s.html();
        e.el.style.zIndex = String(s.z);
        e.marker.setOpacity(String(s.opacity), COVERED_OPACITY);
        e.key = s.key;
      }
      // Nincs becslés (áll a kiinduló megállóban, vagy nincs menete): a valós jel helye.
      if (!v.motion) {
        e.shown = undefined;
        retarget(e, [v.lon, v.lat], t);
      }
    }
    for (const [id, e] of this.entries) {
      if (seen.has(id)) continue;
      e.marker.remove();
      this.entries.delete(id);
    }
  }

  /** Új célok a becslésből (`TICK_MS`-enként). */
  tick(nowServer: number, t: number, freeze: (v: LiveVehicle) => boolean, gpsFor: (v: LiveVehicle) => GeoPosition | null): void {
    for (const e of this.entries.values()) retarget(e, estimateTarget(e, nowServer, freeze(e.v), gpsFor(e.v)), t);
  }

  /** Képkockánként: a jelölők a céljuk felé siklanak (a látott részen kívül csak a cél kerül ki). */
  frame(t: number, visible: (p: LngLat) => boolean): void {
    for (const e of this.entries.values()) {
      const p = trackAt(e, t);
      if (p[0] === e.drawn[0] && p[1] === e.drawn[1]) continue;
      if (p !== e.to && !visible(p)) continue;
      e.drawn = p;
      e.marker.setLngLat(p);
    }
  }

  clear(): void {
    for (const e of this.entries.values()) e.marker.remove();
    this.entries.clear();
  }

  private create(s: MarkerSpec, pos: LngLat, t: number): Entry {
    const el = vehicleElement(s.html(), true);
    el.style.zIndex = String(s.z);
    const marker = vehicleMarker(this.map, el, pos, s.opacity);
    const entry: Entry = { ...newTrack(s.v, pos, t), v: s.v, marker, el, key: s.key };
    // A buborék megnyitáskor készül, így mindig a friss adatot mutatja (mint a 2D-ben).
    const popup = new Popup({ offset: 14, maxWidth: "300px", className: "mvk-popup", focusAfterOpen: false });
    popup.on("open", () => {
      // Utazás közben a többi busz csak nézelődésre való: se követésre váltás, se felszállás róla.
      popup.setHTML(vehiclePopupHtml(entry.v, !getActiveRide()));
      wireVehiclePopup(popup.getElement(), () => entry.v, this.onFocusTrip, () => popup.remove());
    });
    marker.setPopup(popup);
    return entry;
  }
}
