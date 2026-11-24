import { useEffect, useMemo, useRef, useState } from "react";
import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { serverNow } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { fmtSec, heatColor, hourLabel } from "./heatScale";
import { Legend } from "./RouteHeat";
import { buildStyle, firstLabelLayer } from "@/components/map/gl/basemap";
import { loadMapLibre, loadTileset } from "@/components/map/gl/engine";
import { lookById } from "@/components/map/gl/looks";

export interface CitySegment {
  from: string;
  to: string;
  routes: string[];
  /** a szakasz hossza (m) */
  m: number;
  path: [number, number][];
  /** óránként (hours.from-tól): medián időveszteség a menetrendhez képest (mp) */
  ex: (number | null)[];
  n: number[];
  sched: (number | null)[];
}

export interface CityHeatData {
  days: number;
  daytype: number;
  hours: { from: number; to: number };
  segments: CitySegment[];
}

/** [lon, lat] */
const CENTER: [number, number] = [20.7784, 48.1035];
const PLAY_MS = 1100;
const SOURCE = "heat";
const LAYER = "heat-lines";

/** a vonal vastagsága a forgalomhoz (óránkénti buszszám) igazodik */
const weightOf = (n: number, days: number) => {
  const perHour = n / Math.max(1, days);
  return perHour >= 12 ? 6 : perHour >= 6 ? 5 : perHour >= 3 ? 4 : 3;
};

function initialHour(from: number, to: number) {
  const h = new Date(serverNow() * 1000).toLocaleString("en-GB", { timeZone: "Europe/Budapest", hour: "2-digit", hour12: false });
  const now = Number(h);
  return Math.min(to, Math.max(from, Number.isFinite(now) ? now : 8));
}

/**
 * Városi hőtérkép: minden megállóköz a napszaknak megfelelő színnel  mennyi
 * időt veszít ott a busz a menetrendhez képest (medián, a kiválasztott
 * naptípus utolsó heteiből). A csúszkával / lejátszással a nap végigjátszható.
 */
export function CityHeat({ data }: { data: CityHeatData }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const [ready, setReady] = useState(false);
  const [hour, setHour] = useState(() => initialHour(data.hours.from, data.hours.to));
  const [playing, setPlaying] = useState(false);
  const [picked, setPicked] = useState<CitySegment | null>(null);
  const idx = hour - data.hours.from;
  const dataRef = useRef(data);
  dataRef.current = data;

  // Térkép egyszer: a sötét nézet (a saját csempékből), hogy a színek beszéljenek.
  useEffect(() => {
    const container = el.current;
    if (!container) return;
    let cancelled = false;
    let ro: ResizeObserver | null = null;
    void Promise.all([loadMapLibre(), loadTileset()])
      .then(([ml, tileset]) => {
        if (cancelled) return;
        const style = buildStyle(lookById("dark"), tileset, { origin: window.location.origin });
        const m = new ml.Map({
          container,
          style,
          center: CENTER,
          zoom: 12,
          minZoom: 9,
          maxZoom: 18,
          attributionControl: { compact: true },
          pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
          canvasContextAttributes: { antialias: false, powerPreference: "default" },
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          renderWorldCopies: false,
          validateStyle: false,
        });
        m.touchZoomRotate.disableRotation();
        m.addControl(new ml.NavigationControl({ showCompass: false }), "top-left");
        m.on("error", () => undefined);
        m.once("style.load", () => {
          m.addSource(SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          m.addLayer(
            {
              id: LAYER,
              type: "line",
              source: SOURCE,
              layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["get", "ex"] },
              paint: { "line-color": ["get", "color"], "line-width": ["get", "w"], "line-opacity": 0.92 },
            },
            firstLabelLayer(m.getStyle()),
          );
          setReady(true);
        });
        m.on("click", (e) => {
          const { x, y } = e.point;
          const hit = m.queryRenderedFeatures(
            [
              [x - 6, y - 6],
              [x + 6, y + 6],
            ],
            { layers: [LAYER] },
          )[0];
          if (hit) setPicked(dataRef.current.segments[Number(hit.properties.i)] ?? null);
        });
        m.on("mousemove", LAYER, () => {
          m.getCanvas().style.cursor = "pointer";
        });
        m.on("mouseleave", LAYER, () => {
          m.getCanvas().style.cursor = "";
        });
        // A panel (lusta betöltés, elforgatás) a térkép létrejötte után is méreteződhet.
        ro = new ResizeObserver(() => m.resize());
        ro.observe(container);
        map.current = m;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      ro?.disconnect();
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // Nézet az adathoz: telefonon a belváros köré (az egész hálózat apró lenne).
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const pts = data.segments.flatMap((s) => s.path);
    if (!pts.length) return;
    const lons = pts.map((p) => p[1]);
    const lats = pts.map((p) => p[0]);
    const bounds: [[number, number], [number, number]] = [
      [Math.min(...lons), Math.min(...lats)],
      [Math.max(...lons), Math.max(...lats)],
    ];
    const narrow = m.getContainer().clientWidth < 520;
    if (narrow) m.jumpTo({ center: CENTER, zoom: Math.max(11, m.cameraForBounds(bounds)?.zoom ?? 11) });
    else m.fitBounds(bounds, { padding: 12, maxZoom: 13, animate: false });
  }, [data, ready]);

  // Színezés a választott órára; a legrosszabbak felül (line-sort-key).
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const features: GeoJSON.Feature[] = [];
    data.segments.forEach((seg, i) => {
      const ex = seg.ex[idx];
      if (ex == null) return;
      features.push({
        type: "Feature",
        properties: { i, ex, color: heatColor("loss", ex), w: weightOf(seg.n[idx], data.days) },
        geometry: { type: "LineString", coordinates: seg.path.map(([lat, lon]) => [lon, lat]) },
      });
    });
    (m.getSource(SOURCE) as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features });
  }, [idx, data, ready]);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setHour((h) => (h >= data.hours.to ? data.hours.from : h + 1)), PLAY_MS);
    return () => clearInterval(t);
  }, [playing, data.hours.from, data.hours.to]);

  const stats = useMemo(() => {
    const vals = data.segments.map((s) => ({ s, ex: s.ex[idx] })).filter((x): x is { s: CitySegment; ex: number } => x.ex != null);
    const top = [...vals].sort((a, b) => b.ex - a.ex).slice(0, 5);
    return { count: vals.length, slow: vals.filter((x) => x.ex >= 60).length, top };
  }, [data, idx]);

  const pickedEx = picked?.ex[idx] ?? null;

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-xl border border-border">
        <div ref={el} className="mvk-map h-[min(62dvh,520px)] w-full bg-muted" aria-label="Városi hőtérkép" />
        <div className="pointer-events-none absolute inset-x-2 top-2 z-[500] flex justify-center">
          <span className="rounded-full border border-border bg-card/90 px-3 py-1 font-mono text-sm font-bold tabular-nums shadow-md backdrop-blur-sm">
            {hourLabel(hour)} óra
          </span>
        </div>
        {picked ? (
          <div className="absolute inset-x-2 bottom-2 z-[500] rounded-xl border border-border bg-card/95 p-3 text-[12.5px] shadow-lg backdrop-blur-sm sm:left-auto sm:w-[320px]">
            <p className="font-semibold">
              {picked.from} → {picked.to}
            </p>
            <p className="mt-0.5 text-muted-foreground">
              {hourLabel(hour)} óra:{" "}
              {pickedEx != null ? (
                <>
                  <b className="font-mono text-foreground">{fmtSec(pickedEx)}</b> a menetrendhez képest
                  {picked.sched[idx] ? ` (menetrend ${fmtSec(picked.sched[idx]).replace(/^[+−±]/, "")})` : ""}, {picked.n[idx]} busz
                </>
              ) : (
                "ebben az órában nincs mérés"
              )}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {Math.round(picked.m)} m · {picked.routes.join(", ")}
            </p>
            <button type="button" onClick={() => setPicked(null)} className="pointer-events-auto mt-1.5 text-[11px] font-semibold text-primary">
              Bezárás
            </button>
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        <Button size="icon" variant={playing ? "default" : "outline"} className="h-9 w-9 shrink-0" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Megállítás" : "A nap lejátszása"}>
          {playing ? <Pause /> : <Play />}
        </Button>
        <input
          type="range"
          min={data.hours.from}
          max={data.hours.to}
          step={1}
          value={hour}
          onChange={(e) => {
            setPlaying(false);
            setHour(Number(e.target.value));
          }}
          aria-label="Napszak"
          aria-valuetext={`${hourLabel(hour)} óra`}
          className="h-2 min-w-0 flex-1 cursor-pointer accent-primary"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-muted-foreground">
          {stats.count} szakaszon van mérés · <span className={cn(stats.slow ? "font-semibold text-late" : "")}>{stats.slow} szakaszon 1+ perc veszteség</span>
        </p>
        <Legend metric="loss" />
      </div>

      {stats.top.length ? (
        <ol className="divide-y divide-border/60 rounded-xl border border-border">
          {stats.top.map(({ s, ex }, i) => (
            <li key={`${s.from}-${s.to}-${i}`}>
              <button type="button" onClick={() => setPicked(s)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent">
                <span className="w-4 font-mono text-xs text-muted-foreground">{i + 1}</span>
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: heatColor("loss", ex) }} />
                <span className="min-w-0 flex-1 truncate text-[12.5px]">
                  {s.from} → {s.to}
                </span>
                <span className="shrink-0 font-mono text-xs font-bold tabular-nums">{fmtSec(ex)}</span>
                <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">{s.routes.slice(0, 4).join(", ")}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
