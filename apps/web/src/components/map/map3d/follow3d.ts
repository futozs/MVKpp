/**
 * Követés 3D-ben: a kamera rárepül a buszra, aztán mögüle, a haladási irányba
 * nézve viszi a várost — a busz a látott rész alsó harmadában, előtte az út.
 * Elhúzásra megáll (mint a 2D-ben, „Busz középre” folytatja); kézi forgatás után
 * pár másodpercig a felhasználó iránya marad, utána visszafordul a busz mögé.
 */
import type { Map as MLMap, Marker, PaddingOptions } from "maplibre-gl";
import type { GeoPosition } from "@/hooks/useGeolocation";
import { pointAt, shapeFor } from "../liveMotion";
import { projectOnShape, type ShapeLine } from "../onboard";
import { coveredBottom, coveredRight } from "../mapCover";
import { angleDelta, approachAngle, arcDepth, bearingTo, easeInOutCubic, lerp, metersBetween, type LatLon } from "./chaseCam";
import { setFocusLine, setFocusProgress } from "./overlays3d";
import { estimateTarget, newTrack, retarget, trackAt, vehicleElement, vehicleMarker, type LngLat, type MotionSubject, type Track } from "./vehicles3d";

export type Focus3D = {
  /** a követés azonosítója (menet + jármű): ha változik, új rárepülés */
  key: string;
  /** a menet útja ([lat, lon]) */
  shape: [number, number][] | null;
  /** a vonal színe hexában (# nélkül) */
  color: string;
  /** a követett jármű csempéje */
  html: string;
  vehicle: MotionSubject | null;
};

/** követéskor legalább ekkora nagyítás (MapLibre-szint; a 2D-ben ~17) */
const FOLLOW_ZOOM = 16.2;
/** a követő kamera dőlése (fok) */
const FOLLOW_PITCH = 60;
/** ennyivel a busz előtt nézzük a nyomvonal irányát (m): a kanyar előtt már fordul */
const LOOKAHEAD_M = 45;
/** nyomvonal nélkül: ennyi elmozdulás után számolunk új irányt (m) */
const HEADING_STEP_M = 12;
/** kézi forgatás után ennyi ideig a felhasználó iránya marad (ms) */
const USER_BEARING_HOLD_MS = 5000;
/** a „Busz középre” csúszása (ms) */
const RESUME_MS = 650;
/** a látott rész felső részének ekkora hányada üres sáv: a busz lejjebb, előtte az út */
const CHASE_TOP_SHARE = 0.3;
/** a takaró panelek (követés kártyája) helyét ilyen gyakran nézzük meg (ms) */
const PAD_REFRESH_MS = 500;
/** a megtett / hátralévő út határát ilyen gyakran frissítjük (ms) */
const PROGRESS_MS = 1000;
/** ennél messzebb a vonaltól a busz nem ezen az úton jár (m) — nincs halványítás */
const OFF_LINE_M = 80;

const NO_PAD: PaddingOptions = { top: 0, bottom: 0, left: 0, right: 0 };

type Intro = { t0: number; dur: number; center: LngLat; zoom: number; pitch: number; bearing: number; pad: PaddingOptions; toZoom: number; toPitch: number; arc: number };

function shapeLine(shape: [number, number][]): ShapeLine {
  const cum = [0];
  for (let i = 1; i < shape.length; i++) cum.push(cum[i - 1] + metersBetween(shape[i - 1], shape[i]));
  return { pts: shape, cum };
}

/** A pont vetülete a teljes vonalra (a `projectOnShape` csak egy ablakban keres). */
function projectAnywhere(line: ShapeLine, lat: number, lon: number): { along: number; dist: number } | null {
  const total = line.cum[line.cum.length - 1];
  let best: { along: number; dist: number } | null = null;
  for (let near = 0; near <= total + 1000; near += 1000) {
    const hit = projectOnShape(line, lat, lon, near);
    if (hit && (!best || hit.dist < best.dist)) best = hit;
  }
  return best;
}

const lerpPad = (a: PaddingOptions, b: PaddingOptions, k: number): PaddingOptions => ({
  top: lerp(a.top ?? 0, b.top ?? 0, k),
  bottom: lerp(a.bottom ?? 0, b.bottom ?? 0, k),
  left: lerp(a.left ?? 0, b.left ?? 0, k),
  right: lerp(a.right ?? 0, b.right ?? 0, k),
});

export class FocusFollower {
  private key = "";
  private track: Track | null = null;
  private marker: Marker | null = null;
  private el: HTMLDivElement | null = null;
  private html = "";
  private shape: [number, number][] | null = null;
  private color = "#1FB574";
  private line: ShapeLine | null = null;
  private lineAlong: number | null = null;
  private progressAt = -Infinity;
  private fitted = false;
  private paused = false;
  private introPending = false;
  private intro: Intro | null = null;
  private heading: number | null = null;
  private anchor: LatLon | null = null;
  private userBearingUntil = 0;
  private pad: PaddingOptions = NO_PAD;
  private padAt = -Infinity;
  private last: { lng: number; lat: number; bearing: number } | null = null;

  constructor(
    private readonly map: MLMap,
    private readonly onPausedChange: (paused: boolean) => void,
    private readonly passedColor: () => string,
  ) {}

  get active(): boolean {
    return this.key !== "";
  }

  /** A követett menet adatai (az élő adatfolyamból, másodpercenként). */
  set(focus: Focus3D | null, t: number): void {
    if (!focus) {
      if (this.active) this.end(true);
      return;
    }
    if (focus.key !== this.key) {
      this.end(false);
      this.key = focus.key;
      this.introPending = true;
      this.zoomAroundCenter(true);
    }
    if (focus.shape !== this.shape || `#${focus.color}` !== this.color) {
      this.shape = focus.shape;
      this.color = `#${focus.color}`;
      this.line = focus.shape && focus.shape.length > 1 ? shapeLine(focus.shape) : null;
      this.lineAlong = null;
      this.progressAt = -Infinity;
      setFocusLine(this.map, focus.shape, this.color);
      setFocusProgress(this.map, this.color, this.passedColor(), null);
    }
    const v = focus.vehicle;
    if (v && v.lat != null && v.lon != null) {
      if (!this.track) {
        const pos: LngLat = [v.lon, v.lat];
        this.track = newTrack(v, pos, t);
        this.el = vehicleElement(focus.html, false);
        this.el.style.zIndex = "20";
        this.marker = vehicleMarker(this.map, this.el, pos);
      } else {
        this.track.v = v;
        if (!v.motion) {
          this.track.shown = undefined;
          retarget(this.track, [v.lon, v.lat], t);
        }
      }
    } else if (this.track) {
      // a busz egy körre kiesett a jelentésből: ott marad, ahol látszik (nem ugrik vissza a régi jelére)
      const [lon, lat] = this.track.drawn;
      this.track.v = { id: this.track.v.id, lat, lon, motion: null };
    }
    if (this.el && focus.html !== this.html) this.el.innerHTML = focus.html;
    this.html = focus.html;
    // Busz még nincs (nem indult el, nincs jele): a teljes út látszik.
    if (!this.track && this.shape && this.shape.length > 1 && !this.fitted) {
      this.fitted = true;
      const lons = this.shape.map((p) => p[1]);
      const lats = this.shape.map((p) => p[0]);
      this.map.fitBounds(
        [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)],
        ],
        { padding: 60, maxZoom: 15, duration: 900 },
      );
    }
  }

  /** Stílusváltás után a menet útja újra felkerül. */
  restyle(): void {
    setFocusLine(this.map, this.active ? this.shape : null, this.color);
    this.progressAt = -Infinity;
  }

  tick(nowServer: number, t: number, gps: GeoPosition | null): void {
    const tr = this.track;
    if (!tr) return;
    retarget(tr, estimateTarget(tr, nowServer, false, gps), t);
    if (t - this.progressAt >= PROGRESS_MS) {
      this.progressAt = t;
      this.updateProgress(tr.to);
    }
  }

  /** Képkockánként: a jelölő siklik, a kamera vele megy (ha épp nem a felhasználó mozgatja). */
  frame(t: number, dtS: number, interacting: boolean): void {
    const tr = this.track;
    if (!tr || !this.marker) return;
    const pos = trackAt(tr, t);
    if (pos[0] !== tr.drawn[0] || pos[1] !== tr.drawn[1]) {
      tr.drawn = pos;
      this.marker.setLngLat(pos);
    }
    const heading = this.headingTarget(tr);
    if (this.paused || interacting) {
      this.last = null;
      return;
    }
    if (t - this.padAt >= PAD_REFRESH_MS) {
      this.pad = this.padding();
      this.padAt = t;
    }
    if (this.introPending) this.startIntro(t, true);
    if (this.intro) {
      this.introFrame(t, pos, heading);
      return;
    }
    const cur = this.map.getBearing();
    const bearing = heading != null && t >= this.userBearingUntil ? approachAngle(cur, heading, dtS) : cur;
    const last = this.last;
    // áll a busz, és a kamera is beállt: nincs mit újrarajzolni
    if (last && last.lng === pos[0] && last.lat === pos[1] && Math.abs(angleDelta(last.bearing, bearing)) < 0.01 && this.padAt !== t) return;
    this.map.jumpTo({ center: pos, bearing, padding: this.pad });
    this.last = { lng: pos[0], lat: pos[1], bearing };
  }

  /** A felhasználó elhúzta a térképet: körül lehet nézni, a kamera nem rángat vissza. */
  pauseByUser(): void {
    if (!this.active || this.paused) return;
    this.paused = true;
    this.intro = null;
    this.zoomAroundCenter(false);
    this.onPausedChange(true);
  }

  /** „Busz középre”: visszacsúszik a buszra, és újra mögé fordul. */
  resume(t: number): void {
    if (!this.active) return;
    this.paused = false;
    this.userBearingUntil = 0;
    this.zoomAroundCenter(true);
    if (this.track) this.startIntro(t, false);
    this.onPausedChange(false);
  }

  userRotate(phase: "start" | "end", t: number): void {
    if (!this.active) return;
    if (phase === "start") this.userBearingUntil = Infinity;
    else if (this.userBearingUntil === Infinity) this.userBearingUntil = t + USER_BEARING_HOLD_MS;
  }

  destroy(): void {
    this.end(false);
  }

  private end(animate: boolean): void {
    this.marker?.remove();
    this.marker = null;
    this.el = null;
    this.track = null;
    const wasActive = this.active;
    this.key = "";
    this.shape = null;
    this.line = null;
    this.fitted = false;
    this.paused = false;
    this.intro = null;
    this.introPending = false;
    this.heading = null;
    this.anchor = null;
    this.userBearingUntil = 0;
    this.last = null;
    if (!wasActive) return;
    setFocusLine(this.map, null, this.color);
    this.zoomAroundCenter(false);
    this.pad = NO_PAD;
    if (animate) this.map.easeTo({ padding: NO_PAD, duration: 600 });
  }

  /** Követés közben a nagyítás (csípés, görgő) a busz körül marad. */
  private zoomAroundCenter(on: boolean): void {
    const opts = on ? ({ around: "center" } as const) : undefined;
    this.map.scrollZoom.enable(opts);
    this.map.touchZoomRotate.enable(opts);
  }

  private padding(): PaddingOptions {
    const el = this.map.getContainer();
    const h = el.clientHeight;
    const bottom = coveredBottom(el);
    return { top: Math.round(Math.max(0, h - bottom) * CHASE_TOP_SHARE), bottom, left: 0, right: coveredRight(el) };
  }

  /** Merre néz a kamera: a nyomvonalon a busz előtt, vagy (nyomvonal nélkül) az eddigi haladás iránya. */
  private headingTarget(tr: Track): number | null {
    const m = tr.v.motion;
    const shape = m && tr.shown?.shape === m.s ? shapeFor(m.s) : null;
    if (shape && tr.shown) {
      const a = pointAt(shape, tr.shown.along);
      const b = pointAt(shape, tr.shown.along + LOOKAHEAD_M);
      if (metersBetween(a, b) > HEADING_STEP_M / 2) {
        this.heading = bearingTo(a, b);
        return this.heading;
      }
    }
    const cur: LatLon = [tr.drawn[1], tr.drawn[0]];
    if (!this.anchor) this.anchor = cur;
    else if (metersBetween(this.anchor, cur) > HEADING_STEP_M) {
      this.heading = bearingTo(this.anchor, cur);
      this.anchor = cur;
    }
    return this.heading;
  }

  private startIntro(t: number, follow: boolean): void {
    this.introPending = false;
    const tr = this.track;
    if (!tr) return;
    const c = this.map.getCenter();
    const dist = metersBetween([c.lat, c.lng], [tr.drawn[1], tr.drawn[0]]);
    const zoom = this.map.getZoom();
    const pitch = this.map.getPitch();
    this.intro = {
      t0: t,
      dur: follow ? Math.min(2400, Math.max(1100, 900 + dist / 4)) : RESUME_MS,
      center: [c.lng, c.lat],
      zoom,
      pitch,
      bearing: this.map.getBearing(),
      pad: this.map.getPadding(),
      toZoom: follow ? Math.max(zoom, FOLLOW_ZOOM) : zoom,
      toPitch: follow ? Math.max(pitch, FOLLOW_PITCH) : pitch,
      arc: follow ? arcDepth(dist) : 0,
    };
  }

  /** A rárepülés: középpont, nagyítás (távolról ívben), dőlés, irány és a takarás együtt úszik át. */
  private introFrame(t: number, pos: LngLat, heading: number | null): void {
    const i = this.intro!;
    const u = Math.min(1, (t - i.t0) / i.dur);
    const e = easeInOutCubic(u);
    const bearing = heading == null ? i.bearing : i.bearing + angleDelta(i.bearing, heading) * e;
    this.map.jumpTo({
      center: [lerp(i.center[0], pos[0], e), lerp(i.center[1], pos[1], e)],
      zoom: lerp(i.zoom, i.toZoom, e) - i.arc * Math.sin(Math.PI * u),
      pitch: lerp(i.pitch, i.toPitch, e),
      bearing,
      padding: lerpPad(i.pad, this.pad, e),
    });
    if (u >= 1) this.intro = null;
  }

  private updateProgress(at: LngLat): void {
    const line = this.line;
    if (!line) return;
    const [lon, lat] = at;
    const hit = this.lineAlong != null ? projectOnShape(line, lat, lon, this.lineAlong) : projectAnywhere(line, lat, lon);
    const total = line.cum[line.cum.length - 1];
    if (!hit || hit.dist > OFF_LINE_M || total <= 0) {
      this.lineAlong = null;
      setFocusProgress(this.map, this.color, this.passedColor(), null);
      return;
    }
    this.lineAlong = hit.along;
    setFocusProgress(this.map, this.color, this.passedColor(), hit.along / total);
  }
}
