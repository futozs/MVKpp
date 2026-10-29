import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Maximize, Minimize, Settings2 } from "lucide-react";
import type { Stop } from "@/types";
import { api } from "@/services/api";
import { useRealtimeConnected } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { KioskColumn } from "./KioskColumn";
import { KIOSK_MAX, KioskPicker } from "./KioskPicker";
import { useClock, useWakeLock } from "./useStopBoard";

/** A legutóbbi kijelző-választás (localStorage → a felhős szinkron is viszi). */
const KIOSK_KEY = "mvk_kiosk_stops";
const MONITORED_KEY = "mvk_monitored_stops";
const IDLE_MS = 4000;

const DATE_FMT = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", month: "long", day: "numeric", weekday: "long" });
const TIME_FMT = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", hour: "2-digit", minute: "2-digit", second: "2-digit" });

function readIds(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Kezdő megállók: az URL (?m=SP1,SP2), a legutóbbi kijelző, vagy a megállófigyelő első hármasa. */
function initialStops(): string[] {
  const fromUrl = new URLSearchParams(location.search).get("m");
  if (fromUrl) return fromUrl.split(",").map((s) => s.trim()).filter(Boolean).slice(0, KIOSK_MAX);
  const last = readIds(KIOSK_KEY);
  return (last.length ? last : readIds(MONITORED_KEY)).slice(0, KIOSK_MAX);
}

/**
 * Utastájékoztató kijelző: 1–3 megálló egymás mellett (álló képernyőn egymás
 * alatt), teljes képernyőn, élőben. A betűméret a képernyőhöz igazodik.
 */
export function KioskView() {
  const [ids, setIds] = useState<string[]>(initialStops);
  const [stops, setStops] = useState<Stop[]>([]);
  const [picking, setPicking] = useState(() => ids.length === 0);
  const [idle, setIdle] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const size = useViewport();
  const now = useClock();
  const live = useRealtimeConnected();
  useWakeLock(!picking);

  useEffect(() => {
    api.getStops().then(setStops).catch(() => setStops([]));
  }, []);

  // A választás az URL-ben (megosztható, könyvjelzőzhető) és a legutóbbiként is megmarad.
  useEffect(() => {
    if (!ids.length) return;
    const url = new URL(location.href);
    url.searchParams.set("m", ids.join(","));
    history.replaceState(null, "", url);
    try {
      localStorage.setItem(KIOSK_KEY, JSON.stringify(ids));
    } catch {
      /* privát mód */
    }
  }, [ids]);

  // Egér/érintés nélkül a vezérlők és a kurzor eltűnnek.
  useEffect(() => {
    let t = setTimeout(() => setIdle(true), IDLE_MS);
    const wake = () => {
      setIdle(false);
      clearTimeout(t);
      t = setTimeout(() => setIdle(true), IDLE_MS);
    };
    window.addEventListener("pointermove", wake);
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
    };
  }, []);

  useEffect(() => {
    const on = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);

  const byId = useMemo(() => new Map(stops.map((s) => [s.id, s])), [stops]);
  const n = Math.max(1, ids.length);
  const portrait = size.h > size.w && n > 1;
  const topH = Math.round(Math.max(48, Math.min(96, size.h * 0.085)));
  const colW = portrait ? size.w : size.w / n;
  const colH = portrait ? (size.h - topH) / n : size.h - topH;
  // Egy oszlop kb. 28 em széles és 25 em magas tartalmat kíván (fejléc, kiemelt busz, 5 sor, levegővel).
  const fontSize = Math.max(12, Math.min(40, colW / 28, colH / 25));
  // A kiemelt busz alatt annyi járat, amennyi kifér (fejléc + kiemelt ≈ 9,5 em, egy sor ≈ 3,4 em).
  const restRows = Math.max(3, Math.min(9, Math.floor((colH / fontSize - 9.5) / 3.4)));

  return (
    <div className={cn("flex h-[100dvh] w-full flex-col overflow-hidden bg-background text-foreground", idle && !picking && "cursor-none")}>
      <header className="flex shrink-0 items-center justify-between gap-4 px-[2vw]" style={{ height: topH }}>
        <div className="flex min-w-0 items-center gap-3">
          <span className="rounded-md bg-primary px-2 py-1 text-sm font-extrabold text-primary-foreground">MVK++</span>
          <span className="hidden truncate text-sm text-muted-foreground sm:inline">{DATE_FMT.format(now)}</span>
          <span className={cn("h-2 w-2 rounded-full", live ? "bg-live motion-safe:animate-live-pulse" : "bg-muted-foreground/50")} title={live ? "élő" : "kapcsolódás…"} />
        </div>
        <time className="font-mono font-bold tabular-nums leading-none" style={{ fontSize: topH * 0.5 }}>
          {TIME_FMT.format(now)}
        </time>
      </header>
      <main
        className="grid min-h-0 flex-1 gap-[0.6em] px-[0.6em] pb-[0.6em]"
        style={{
          fontSize,
          gridTemplateColumns: portrait ? "minmax(0,1fr)" : `repeat(${n}, minmax(0, 1fr))`,
          gridTemplateRows: portrait ? `repeat(${n}, minmax(0, 1fr))` : "minmax(0,1fr)",
        }}
      >
        {ids.map((id) => (
          <KioskColumn key={id} stopId={id} stop={byId.get(id)} rows={restRows} />
        ))}
      </main>
      <nav
        aria-label="Kijelző vezérlők"
        className={cn(
          "fixed bottom-4 right-4 flex gap-2 rounded-xl border border-border bg-card/90 p-1.5 shadow-lg backdrop-blur transition-opacity duration-normal",
          idle && !picking ? "pointer-events-none opacity-0" : "opacity-100",
        )}
      >
        <a href="/" className="flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold hover:bg-accent" title="Vissza az apphoz">
          <ArrowLeft className="h-4 w-4" /> Kilépés
        </a>
        <button type="button" onClick={() => setPicking(true)} className="flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold hover:bg-accent">
          <Settings2 className="h-4 w-4" /> Megállók
        </button>
        <button type="button" onClick={toggleFullscreen} className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-accent" aria-label={fullscreen ? "Kilépés a teljes képernyőből" : "Teljes képernyő"}>
          {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
        </button>
      </nav>
      {picking ? <KioskPicker stops={stops} selected={ids} onChange={setIds} onClose={ids.length ? () => setPicking(false) : null} /> : null}
    </div>
  );
}

function useViewport() {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return size;
}
