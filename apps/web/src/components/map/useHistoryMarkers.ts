import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { Popup } from "maplibre-gl";
import type { Route } from "@/types";
import { routeAtPoint, WINDOW_SEC, windowStartOf, type HistoryWindow } from "./historyData";
import { compassLabel, motionOf, sampleTrack, type Sample } from "./historySampler";
import { formatClock } from "./historyTime";
import { safeHex } from "./vehicleIcon";
import { displayVehicleId, vehicleModeOf } from "@/lib/modes";
import type { AtlasEntry, BadgeSpec } from "./gl/badges";
import type { LiveMapHandle } from "./gl/LiveMap";
import { hits, toSprite } from "./gl/vehicles";

/** Betöltés közben a régi kép halványan marad, nem ugrik el semmi. */
const STALE_ALPHA = 0.35;
/** A nyitott buborék szövegét ennél sűrűbben nem írjuk újra. */
const POPUP_REFRESH_MS = 250;
/** érintéskor ekkora ráhagyással találja el a járművet (px) */
const HIT_SLOP = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches ? 8 : 3;

export interface HistoryMarkerOptions {
  routeByShort: Map<string, Route>;
  isVisible: (vehicleId: string, routeShort: string | null) => boolean;
  isTracked: (vehicleId: string) => boolean;
  showIds: boolean;
}

export interface RenderResult {
  /** Van-e betöltött adat a kurzor ablakára. */
  ready: boolean;
  visible: number;
}

interface PopupRefs {
  time: HTMLElement;
  fix: HTMLElement;
  heading: HTMLElement;
  speed: HTMLElement;
}

interface VehicleState {
  id: string;
  key: string;
  badge: AtlasEntry | null;
  label: AtlasEntry | null;
  gen: number;
  spec: BadgeSpec;
  labelText: string | null;
  hint: number;
  windowStart: number;
  route: string | null;
  sample: Sample;
}

function el(tag: string, css: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.style.cssText = css;
  if (text != null) node.textContent = text;
  return node;
}

function row(label: string, value: HTMLElement): HTMLElement {
  const line = el("div", "display:flex;justify-content:space-between;gap:12px");
  line.append(el("span", "", label), value);
  return line;
}

function buildPopup(vehicleId: string, route: Route | undefined, routeShort: string | null): { root: HTMLElement; refs: PopupRefs } {
  const root = el("div", "min-width:200px");

  const head = el("div", "display:flex;align-items:center;gap:9px;margin-bottom:10px");
  head.append(
    el(
      "span",
      `display:inline-flex;align-items:center;justify-content:center;min-width:40px;height:26px;padding:0 8px;border-radius:8px;font-weight:800;font-size:14px;background:#${safeHex(route?.color, "1FB574")};color:#${safeHex(route?.text, "FFFFFF")}`,
      routeShort ?? "?",
    ),
    el("span", "font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:hsl(var(--muted-foreground))", "Visszajátszás"),
  );

  const idBox = el("div", "border-radius:10px;background:hsl(var(--primary)/0.09);border:1px solid hsl(var(--primary)/0.25);padding:9px 11px;margin-bottom:8px");
  idBox.append(
    el("div", "font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:hsl(var(--muted-foreground))", "Rendszám"),
    el("div", "font-family:var(--font-mono);font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;color:hsl(var(--foreground))", vehicleId),
  );

  const strong = "color:hsl(var(--foreground));font-weight:700";
  const refs: PopupRefs = {
    time: el("strong", strong),
    fix: el("span", "color:hsl(var(--foreground))"),
    heading: el("span", "color:hsl(var(--foreground))"),
    speed: el("span", "color:hsl(var(--foreground))"),
  };
  const grid = el("div", "font-family:var(--font-mono);font-size:12px;font-variant-numeric:tabular-nums;color:hsl(var(--muted-foreground));display:grid;gap:3px");
  grid.append(row("Időpont", refs.time), row("Utolsó jel", refs.fix), row("Irány", refs.heading), row("Sebesség", refs.speed));

  root.append(head, idBox, grid);
  return { root, refs };
}

function fillPopup(refs: PopupRefs, t: number, sample: Sample | null): void {
  refs.time.textContent = formatClock(t);
  if (!sample) return;
  refs.fix.textContent = formatClock(sample.fixTs);
  const { bearing, speedKmh } = motionOf(sample);
  refs.heading.textContent = bearing == null ? "" : `${compassLabel(bearing)} · ${Math.round(bearing)}°`;
  refs.speed.textContent = speedKmh == null ? "" : `~${Math.round(speedKmh)} km/h`;
}

/**
 * A visszajátszott járművek: ugyanazon a GPU-rétegen, ugyanazokkal a csempékkel, mint
 * az élő nézet. A helyük képkockánként a mintavételből jön; a térkép csak akkor rajzol
 * újra, amikor a kurzor halad.
 */
export function useHistoryMarkers(liveRef: RefObject<LiveMapHandle | null>, getWindow: (start: number) => HistoryWindow | undefined, options: HistoryMarkerOptions): (t: number) => RenderResult {
  const statesRef = useRef(new Map<string, VehicleState>());
  /** a kirajzolandók (alulról felfelé), a legutóbbi render szerint */
  const drawRef = useRef<VehicleState[]>([]);
  const alphaRef = useRef(1);
  const optionsRef = useRef(options);
  const getWindowRef = useRef(getWindow);
  const openRef = useRef<{ id: string; refs: PopupRefs; popup: Popup; at: number } | null>(null);
  const lastRef = useRef<RenderResult>({ ready: false, visible: 0 });
  const lastT = useRef(0);

  useEffect(() => {
    optionsRef.current = options;
    getWindowRef.current = getWindow;
  });

  useEffect(() => {
    const live = liveRef.current;
    const map = live?.map();
    if (!live || !map) return;
    const states = statesRef.current;

    const project = (s: VehicleState) => map.project([s.sample.lon, s.sample.lat]);
    const onClick = (x: number, y: number): boolean => {
      const draw = drawRef.current;
      for (let i = draw.length - 1; i >= 0; i--) {
        const s = draw[i];
        if (!s.badge || !hits(s.badge, project(s), x, y, HIT_SLOP)) continue;
        openRef.current?.popup.remove();
        const route = s.route ? optionsRef.current.routeByShort.get(s.route) : undefined;
        const { root, refs } = buildPopup(s.id, route, s.route);
        fillPopup(refs, lastT.current, s.sample);
        const popup = live.popup().setLngLat([s.sample.lon, s.sample.lat]).setDOMContent(root).addTo(map);
        const entry = { id: s.id, refs, popup, at: performance.now() };
        openRef.current = entry;
        popup.on("close", () => {
          if (openRef.current === entry) openRef.current = null;
        });
        return true;
      }
      return false;
    };

    const remove = live.addSprites((_t, labels, badges) => {
      const atlas = live.atlas();
      if (!atlas) return;
      const alpha = alphaRef.current;
      for (const s of drawRef.current) {
        if (s.gen !== atlas.generation || !s.badge) {
          s.badge = atlas.badge(s.spec);
          s.label = s.labelText ? atlas.label(s.labelText, s.spec.tracked) : null;
          s.gen = atlas.generation;
        }
        const p: [number, number, number] = [s.sample.lon, s.sample.lat, 0];
        if (s.label) labels.push(toSprite(p, s.label, alpha));
        badges.push(toSprite(p, s.badge, alpha));
      }
    }, onClick);

    return () => {
      remove();
      openRef.current?.popup.remove();
      openRef.current = null;
      states.clear();
      drawRef.current = [];
    };
  }, [liveRef]);

  return useCallback(
    (t: number): RenderResult => {
      const live = liveRef.current;
      const map = live?.map();
      if (!live || !map) return lastRef.current;
      lastT.current = t;

      const start = windowStartOf(t);
      const current = getWindowRef.current(start);
      if (!current) {
        if (alphaRef.current !== STALE_ALPHA) {
          alphaRef.current = STALE_ALPHA;
          map.triggerRepaint();
        }
        lastRef.current = { ready: false, visible: lastRef.current.visible };
        return lastRef.current;
      }
      alphaRef.current = 1;

      const prev = getWindowRef.current(start - WINDOW_SEC);
      const next = getWindowRef.current(start + WINDOW_SEC);
      const { routeByShort, isVisible, isTracked, showIds } = optionsRef.current;
      const states = statesRef.current;
      const draw: VehicleState[] = [];
      const tracked: VehicleState[] = [];

      for (const [id, track] of current.tracks) {
        const existing = states.get(id);
        const hint = existing && existing.windowStart === start ? existing.hint : -1;
        const sample = sampleTrack(track, t, hint, prev?.tracks.get(id), next?.tracks.get(id));
        if (!sample) continue;
        // A vonal a kurzornál lévő pontból jön: ablakon belül is válthat.
        const ref = sample.a ?? sample.b;
        const routeShort = ref ? routeAtPoint(ref.track, ref.i) : track.route;
        if (!isVisible(id, routeShort)) continue;

        const isTr = isTracked(id);
        const route = routeShort ? routeByShort.get(routeShort) : undefined;
        const key = `${routeShort}|${route?.color}|${route?.text}|${isTr}|${showIds}`;
        let state = existing;
        if (!state || state.key !== key) {
          const mode = vehicleModeOf({ id }, route?.type);
          state = {
            id,
            key,
            badge: null,
            label: null,
            gen: -1,
            spec: { text: route?.short ?? routeShort ?? "?", bg: safeHex(route?.color, "1FB574"), fg: safeHex(route?.text, "FFFFFF"), mode, tracked: isTr, estimated: false },
            labelText: showIds || isTr ? displayVehicleId(id) : null,
            hint: -1,
            windowStart: start,
            route: routeShort,
            sample,
          };
          states.set(id, state);
        }
        state.hint = sample.index;
        state.windowStart = start;
        state.route = routeShort;
        state.sample = sample;
        (isTr ? tracked : draw).push(state);
      }
      drawRef.current = [...draw, ...tracked];
      map.triggerRepaint();

      const open = openRef.current;
      if (open) {
        const s = states.get(open.id);
        if (s && drawRef.current.includes(s)) open.popup.setLngLat([s.sample.lon, s.sample.lat]);
        if (performance.now() - open.at >= POPUP_REFRESH_MS) {
          open.at = performance.now();
          fillPopup(open.refs, t, s?.sample ?? null);
        }
      }

      lastRef.current = { ready: true, visible: drawRef.current.length };
      return lastRef.current;
    },
    [liveRef],
  );
}
