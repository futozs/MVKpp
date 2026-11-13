import { useCallback, useEffect, useRef, type RefObject } from "react";
import L from "leaflet";
import type { Route } from "@/types";
import { routeAtPoint, WINDOW_SEC, windowStartOf, type HistoryWindow, type VehicleTrack } from "./historyData";
import { compassLabel, motionOf, sampleTrack, type Sample } from "./historySampler";
import { formatClock } from "./historyTime";
import { createVehicleIcon, safeHex } from "./vehicleIcon";
import { displayVehicleId, vehicleModeOf } from "@/lib/modes";

/** Saját pane a visszajátszott járműveknek: így betöltés közben egyben halványítható. */
const PANE = "mvkHistory";
const PANE_Z = "610";
const STALE_OPACITY = "0.35";
/** A nyitott buborék szövegét ennél sűrűbben nem írjuk újra. */
const POPUP_REFRESH_MS = 250;

export interface HistoryMarkerOptions {
  routeByShort: Map<string, Route>;
  isVisible: (vehicleId: string, routeShort: string | null) => boolean;
  isTracked: (vehicleId: string) => boolean;
  showIds: boolean;
  /** A térkép alját takaró idővonal-sáv magassága, a buborék ne bújjon alá. */
  bottomInset: number;
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
  marker: L.Marker;
  popup: L.Popup;
  iconKey: string;
  shown: boolean;
  hint: number;
  windowStart: number;
  frame: number;
  route: string | null;
  sample: Sample | null;
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

function buildPopup(
  vehicleId: string,
  route: Route | undefined,
  routeShort: string | null,
): { root: HTMLElement; refs: PopupRefs } {
  const root = el("div", "min-width:200px");

  const head = el("div", "display:flex;align-items:center;gap:9px;margin-bottom:10px");
  head.append(
    el(
      "span",
      `display:inline-flex;align-items:center;justify-content:center;min-width:40px;height:26px;padding:0 8px;border-radius:8px;font-weight:800;font-size:14px;background:#${safeHex(route?.color, "1FB574")};color:#${safeHex(route?.text, "FFFFFF")}`,
      routeShort ?? "?",
    ),
    el(
      "span",
      "font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:hsl(var(--muted-foreground))",
      "Visszajátszás",
    ),
  );

  const idBox = el(
    "div",
    "border-radius:10px;background:hsl(var(--primary)/0.09);border:1px solid hsl(var(--primary)/0.25);padding:9px 11px;margin-bottom:8px",
  );
  idBox.append(
    el(
      "div",
      "font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:hsl(var(--muted-foreground))",
      "Rendszám",
    ),
    el(
      "div",
      "font-family:var(--font-mono);font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;color:hsl(var(--foreground))",
      vehicleId,
    ),
  );

  const strong = "color:hsl(var(--foreground));font-weight:700";
  const refs: PopupRefs = {
    time: el("strong", strong),
    fix: el("span", "color:hsl(var(--foreground))"),
    heading: el("span", "color:hsl(var(--foreground))"),
    speed: el("span", "color:hsl(var(--foreground))"),
  };
  const grid = el(
    "div",
    "font-family:var(--font-mono);font-size:12px;font-variant-numeric:tabular-nums;color:hsl(var(--muted-foreground));display:grid;gap:3px",
  );
  grid.append(
    row("Időpont", refs.time),
    row("Utolsó jel", refs.fix),
    row("Irány", refs.heading),
    row("Sebesség", refs.speed),
  );

  root.append(head, idBox, grid);
  return { root, refs };
}

function fillPopup(refs: PopupRefs, t: number, sample: Sample | null): void {
  refs.time.textContent = formatClock(t);
  if (!sample) return;
  refs.fix.textContent = formatClock(sample.fixTs);
  const { bearing, speedKmh } = motionOf(sample);
  refs.heading.textContent =
    bearing == null ? "" : `${compassLabel(bearing)} · ${Math.round(bearing)}°`;
  refs.speed.textContent = speedKmh == null ? "" : `~${Math.round(speedKmh)} km/h`;
}

/**
 * A visszajátszott járművek Leaflet-rétege. A jelölők egyszer jönnek létre,
 * utána képkockánként csak `setLatLng` mozgatja őket.
 */
export function useHistoryMarkers(
  mapRef: RefObject<L.Map | null>,
  getWindow: (start: number) => HistoryWindow | undefined,
  options: HistoryMarkerOptions,
  onSettled: () => void,
): (t: number) => RenderResult {
  const layerRef = useRef<L.LayerGroup | null>(null);
  const statesRef = useRef(new Map<string, VehicleState>());
  const frameRef = useRef(0);
  const zoomingRef = useRef(false);
  const optionsRef = useRef(options);
  const getWindowRef = useRef(getWindow);
  const settledRef = useRef(onSettled);
  const openRef = useRef<{ id: string; refs: PopupRefs; at: number } | null>(null);
  const lastRef = useRef<RenderResult>({ ready: false, visible: 0 });
  const lastT = useRef(0);

  useEffect(() => {
    optionsRef.current = options;
    getWindowRef.current = getWindow;
    settledRef.current = onSettled;
  });

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const pane = map.getPane(PANE) ?? map.createPane(PANE);
    pane.style.zIndex = PANE_Z;
    pane.style.transition = "opacity var(--dur-fast) ease-out";
    const layer = L.layerGroup().addTo(map);
    layerRef.current = layer;
    const states = statesRef.current;

    // Animált zoom közben a jelölők már a cél-nagyításon állnak; egy ekkor
    // jövő setLatLng a régi nagyítás koordinátáira rántaná vissza őket.
    const onZoomAnim = () => {
      zoomingRef.current = true;
    };
    const onZoomEnd = () => {
      zoomingRef.current = false;
      settledRef.current();
    };
    map.on("zoomanim", onZoomAnim);
    map.on("zoomend", onZoomEnd);

    return () => {
      map.off("zoomanim", onZoomAnim);
      map.off("zoomend", onZoomEnd);
      layer.clearLayers();
      map.removeLayer(layer);
      pane.style.opacity = "";
      states.clear();
      layerRef.current = null;
      openRef.current = null;
    };
  }, [mapRef]);

  const createState = useCallback(
    (id: string, track: VehicleTrack, sample: Sample): VehicleState => {
      const popup = L.popup({ autoPanPaddingTopLeft: L.point(16, 16) });
      const marker = L.marker([sample.lat, sample.lon], {
        pane: PANE,
        keyboard: false,
        icon: createVehicleIcon("?", null, null, false, null),
      });

      const state: VehicleState = {
        marker,
        popup,
        iconKey: "",
        shown: false,
        hint: -1,
        windowStart: 0,
        frame: 0,
        route: track.route,
        sample,
      };

      // A kattintás a bindPopup előtt fut le: ekkor még átírható, mennyi
      // helyet hagyjon alul a buborék az idővonal-sávnak.
      marker.on("click", () => {
        popup.options.autoPanPaddingBottomRight = L.point(
          16,
          optionsRef.current.bottomInset + 16,
        );
        const { root, refs } = buildPopup(
          id,
          state.route ? optionsRef.current.routeByShort.get(state.route) : undefined,
          state.route,
        );
        fillPopup(refs, lastT.current, state.sample);
        popup.setContent(root);
        openRef.current = { id, refs, at: performance.now() };
      });
      marker.bindPopup(popup);
      marker.on("popupclose", () => {
        if (openRef.current?.id === id) openRef.current = null;
      });
      return state;
    },
    [],
  );

  return useCallback(
    (t: number): RenderResult => {
      const map = mapRef.current;
      const layer = layerRef.current;
      if (!map || !layer) return lastRef.current;
      lastT.current = t;

      const pane = map.getPane(PANE);
      const start = windowStartOf(t);
      const current = getWindowRef.current(start);
      if (!current) {
        // Nincs még adat: a régi kép halványan marad, nem ugrik el semmi.
        if (pane) pane.style.opacity = STALE_OPACITY;
        lastRef.current = { ready: false, visible: lastRef.current.visible };
        return lastRef.current;
      }
      if (pane) pane.style.opacity = "";
      if (zoomingRef.current) return lastRef.current;

      const prev = getWindowRef.current(start - WINDOW_SEC);
      const next = getWindowRef.current(start + WINDOW_SEC);
      const { routeByShort, isVisible, isTracked, showIds } = optionsRef.current;
      const states = statesRef.current;
      const frame = ++frameRef.current;
      let visible = 0;

      for (const [id, track] of current.tracks) {
        const existing = states.get(id);
        const hint = existing && existing.windowStart === start ? existing.hint : -1;
        const sample = sampleTrack(
          track,
          t,
          hint,
          prev?.tracks.get(id),
          next?.tracks.get(id),
        );
        if (!sample) continue;
        // A vonal a kurzornál lévő pontból jön: ablakon belül is válthat.
        const ref = sample.a ?? sample.b;
        const routeShort = ref ? routeAtPoint(ref.track, ref.i) : track.route;
        if (!isVisible(id, routeShort)) continue;

        const state = existing ?? createState(id, track, sample);
        if (!existing) states.set(id, state);
        state.hint = sample.index;
        state.windowStart = start;
        state.frame = frame;
        state.route = routeShort;
        state.sample = sample;

        const tracked = isTracked(id);
        const route = routeShort ? routeByShort.get(routeShort) : undefined;
        const iconKey = `${routeShort}|${route?.color}|${route?.text}|${tracked}|${showIds}`;
        if (iconKey !== state.iconKey) {
          state.iconKey = iconKey;
          const mode = vehicleModeOf({ id }, route?.type);
          state.marker.setIcon(
            createVehicleIcon(
              route?.short ?? routeShort ?? "?",
              route?.color,
              route?.text,
              tracked,
              showIds || tracked ? displayVehicleId(id) : null,
              { mode },
            ),
          );
          state.marker.setZIndexOffset(tracked ? 1000 : 500);
        }

        state.marker.setLatLng([sample.lat, sample.lon]);
        if (!state.shown) {
          layer.addLayer(state.marker);
          state.shown = true;
        }
        visible++;
      }

      for (const state of states.values()) {
        if (state.frame === frame || !state.shown) continue;
        layer.removeLayer(state.marker);
        state.shown = false;
      }

      const open = openRef.current;
      if (open && performance.now() - open.at >= POPUP_REFRESH_MS) {
        open.at = performance.now();
        fillPopup(open.refs, t, states.get(open.id)?.sample ?? null);
      }

      lastRef.current = { ready: true, visible };
      return lastRef.current;
    },
    [mapRef, createState],
  );
}
