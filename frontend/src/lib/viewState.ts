import type { ActiveTab } from "@/types";

const VIEW_KEY = "mvk_view_state";
const MAP_KEY = "mvk_map_view";
const TIMETABLE_KEY = "mvk_timetable_view";

const MAX_AGE_MS = 8 * 3600_000;

const FOCUS_MAX_AGE_MS = 45 * 60_000;

interface Stored<T> {
  at: number;
  data: T;
}

function read<T>(
  key: string,
  maxAgeMs = MAX_AGE_MS,
): { data: T; ageMs: number } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored<T>;
    if (typeof parsed?.at !== "number" || parsed.data == null) return null;
    const ageMs = Date.now() - parsed.at;
    if (ageMs > maxAgeMs) return null;
    return { data: parsed.data, ageMs };
  } catch {
    return null;
  }
}

function write<T>(key: string, data: T) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ at: Date.now(), data } satisfies Stored<T>),
    );
  } catch {}
}

export interface ViewState {
  tab: ActiveTab;
  selectedStopId: string | null;
  focusTripId: string | null;
  focusVehicleId: string | null;
}

const TABS: ActiveTab[] = ["map", "multistop", "timetable", "stats"];

let cachedView: ViewState | null | undefined;

export function initialView(): ViewState | null {
  if (cachedView !== undefined) return cachedView;

  const stored = read<Partial<ViewState>>(VIEW_KEY);
  if (!stored) {
    cachedView = null;
    return null;
  }

  const { data, ageMs } = stored;
  const keepFocus = ageMs <= FOCUS_MAX_AGE_MS;

  cachedView = {
    tab: TABS.includes(data.tab as ActiveTab) ? (data.tab as ActiveTab) : "map",
    selectedStopId: data.selectedStopId ?? null,
    focusTripId: keepFocus ? (data.focusTripId ?? null) : null,
    focusVehicleId: keepFocus ? (data.focusVehicleId ?? null) : null,
  };
  return cachedView;
}

export function saveView(state: ViewState) {
  write(VIEW_KEY, state);
}

export interface MapView {
  lat: number;
  lon: number;
  zoom: number;
}

let cachedMap: MapView | null | undefined;

export function initialMapView(): MapView | null {
  if (cachedMap !== undefined) return cachedMap;

  const stored = read<Partial<MapView>>(MAP_KEY);
  const d = stored?.data;
  cachedMap =
    typeof d?.lat === "number" &&
    typeof d?.lon === "number" &&
    typeof d?.zoom === "number"
      ? { lat: d.lat, lon: d.lon, zoom: d.zoom }
      : null;
  return cachedMap;
}

export function saveMapView(view: MapView) {
  write(MAP_KEY, view);
}

export interface TimetableView {
  routeId: string | null;
  dir: string;
  tripId: string | null;
}

let cachedTimetable: TimetableView | null | undefined;

export function initialTimetableView(): TimetableView | null {
  if (cachedTimetable !== undefined) return cachedTimetable;

  const stored = read<Partial<TimetableView>>(TIMETABLE_KEY);
  const d = stored?.data;
  cachedTimetable = d?.routeId
    ? { routeId: d.routeId, dir: d.dir ?? "", tripId: d.tripId ?? null }
    : null;
  return cachedTimetable;
}

export function saveTimetableView(view: TimetableView) {
  write(TIMETABLE_KEY, view);
}
