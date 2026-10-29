import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { serverNow } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { fmtSec, heatColor, hourLabel } from "./heatScale";
import { Legend } from "./RouteHeat";

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

const CENTER: [number, number] = [48.1035, 20.7784];
const PLAY_MS = 1100;
const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> közreműködők';

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
 * Városi hőtérkép: minden megállóköz a napszaknak megfelelő színnel — mennyi
 * időt veszít ott a busz a menetrendhez képest (medián, a kiválasztott
 * naptípus utolsó heteiből). A csúszkával / lejátszással a nap végigjátszható.
 */
export function CityHeat({ data }: { data: CityHeatData }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const lines = useRef<{ seg: CitySegment; line: L.Polyline }[]>([]);
  const [hour, setHour] = useState(() => initialHour(data.hours.from, data.hours.to));
  const [playing, setPlaying] = useState(false);
  const [picked, setPicked] = useState<CitySegment | null>(null);
  const idx = hour - data.hours.from;

  // Térkép egyszer.
  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { center: CENTER, zoom: 13, zoomControl: true, attributionControl: true, preferCanvas: true });
    L.tileLayer(OSM_URL, { attribution: OSM_ATTRIB, maxZoom: 19, crossOrigin: true }).addTo(m);
    // A szűrő a teljes csemperétegen (csempénként hajszálvékony hézagok látszanának).
    m.getPane("tilePane")?.classList.add("heat-base-tiles");
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    // A panel (lusta betöltés, elforgatás) a térkép létrejötte után is méreteződhet.
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      layer.current = null;
      lines.current = [];
    };
  }, []);

  // Szakaszok kirajzolása (adatváltáskor).
  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const renderer = L.canvas({ padding: 0.3, tolerance: 6 });
    lines.current = data.segments.map((seg) => {
      const line = L.polyline(seg.path, { renderer, weight: 3, opacity: 0, lineCap: "round", lineJoin: "round" });
      line.on("click", () => setPicked(seg));
      line.addTo(g);
      return { seg, line };
    });
    const pts = data.segments.flatMap((s) => s.path);
    if (!pts.length) return;
    // A végleges méret az első képkocka után ismert.
    const raf = requestAnimationFrame(() => {
      m.invalidateSize();
      const bounds = L.latLngBounds(pts);
      // Keskeny (telefonos) térképen az egész hálózat apró lenne: a belváros köré.
      const narrow = m.getSize().x < 520;
      if (narrow) m.setView(CENTER, Math.max(12, m.getBoundsZoom(bounds)));
      else m.fitBounds(bounds, { padding: [12, 12], maxZoom: 14 });
    });
    return () => cancelAnimationFrame(raf);
  }, [data]);

  // Színezés a választott órára (a rétegek maradnak, csak a stílus változik).
  useEffect(() => {
    for (const { seg, line } of lines.current) {
      const ex = seg.ex[idx];
      if (ex == null) line.setStyle({ opacity: 0 });
      else line.setStyle({ color: heatColor("loss", ex), opacity: 0.92, weight: weightOf(seg.n[idx], data.days) });
    }
    // A legrosszabbak legfelül.
    for (const { seg, line } of [...lines.current].sort((a, b) => (a.seg.ex[idx] ?? -999) - (b.seg.ex[idx] ?? -999))) if (seg.ex[idx] != null) line.bringToFront();
  }, [idx, data]);

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
        <div ref={el} className="h-[min(62dvh,520px)] w-full bg-muted" aria-label="Városi hőtérkép" />
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
