import { useEffect, useMemo, useRef, useState } from "react";
import type { Stop } from "@/types";
import { api, type JourneyMode, type JourneyPlanResponse } from "@/services/api";
import { nowLocalTime, todayLocalIso } from "./format";
import { zonedUnix } from "@/components/map/historyTime";
import { serverNow } from "@/lib/realtime";
import { PlanForm, type PlanFormValue } from "./PlanForm";
import { PlanResults, ResultsSkeleton } from "./PlanResults";

/** A backend is így dönt: 10 percnél későbbi időpont már „jövő”. */
const NOW_WINDOW_SEC = 600;
const RESULT_LIMIT = 4;
/** élő tervnél ilyen gyakran frissítjük csendben az eredményt (ms) */
const LIVE_REFRESH_MS = 60_000;

type Result =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; plan: JourneyPlanResponse };

function usePlaces(stops: Stop[]) {
  return useMemo(() => {
    const byName = new Map<string, Stop>();
    for (const s of stops) if (!byName.has(s.name)) byName.set(s.name, s);
    return [...byName.values()].sort((a, b) =>
      a.name.localeCompare(b.name, "hu"),
    );
  }, [stops]);
}

/** A beírt nap és óra:perc budapesti idő szerint (nem a készülék időzónájában). */
function toUnix(date: string, time: string): number {
  const [h, m] = time.split(":").map(Number);
  return zonedUnix(date, h || 0) + (m || 0) * 60;
}

function clientMode(date: string, time: string): JourneyMode {
  if (date < todayLocalIso()) return "past";
  return toUnix(date, time) > serverNow() + NOW_WINDOW_SEC ? "future" : "now";
}

function scrollIntoViewIfHidden(el: HTMLElement | null) {
  if (!el) return;
  const { top } = el.getBoundingClientRect();
  if (top < window.innerHeight - 120) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
}

/**
 * Útvonaltervező a saját /engine/plan végpontunkra építve. Egy kérésből jön a
 * menetrendi itinerárium és mellé: múltbeli napnál a ténylegesen mért
 * indulás/érkezés (igazolásként másolható), mára és jövőre a várható késés
 * (élő adat vagy korábbi mérések) és az átszállások kockázata.
 */
export function RoutePlannerView({ stops }: { stops: Stop[] }) {
  const places = usePlaces(stops);
  const [form, setForm] = useState<PlanFormValue>(() => ({
    from: "",
    to: "",
    arriveBy: false,
    date: todayLocalIso(),
    time: nowLocalTime(),
  }));
  const [result, setResult] = useState<Result>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Élő tervnél percenként csendben frissítünk: a késések és az átszállási esélyek változnak.
  const liveResult = result.status === "done" && result.plan.mode === "now";
  useEffect(() => {
    if (!liveResult) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void run(true);
    }, LIVE_REFRESH_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveResult]);

  const mode = clientMode(form.date, form.time);
  const update = (patch: Partial<PlanFormValue>) => setForm((f) => ({ ...f, ...patch }));
  const setNow = () => update({ date: todayLocalIso(), time: nowLocalTime() });

  const lastQueryRef = useRef<{ from: string; to: string; at: number; arriveBy: boolean } | null>(null);

  const run = async (silent = false) => {
    const last = lastQueryRef.current;
    // Élő terv csendes frissítése: a mostani időponttól (különben a rég elment buszok maradnának elöl).
    const q = silent
      ? last && !last.arriveBy
        ? { ...last, at: Math.floor(serverNow()) }
        : last
      : form.from && form.to
        ? { from: form.from, to: form.to, at: toUnix(form.date, form.time), arriveBy: form.arriveBy }
        : null;
    if (!q) return;
    lastQueryRef.current = q;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (!silent) {
      setResult({ status: "loading" });
      requestAnimationFrame(() => scrollIntoViewIfHidden(resultsRef.current));
    }
    try {
      const plan = await api.planJourney({
        from: `stop:${q.from}`,
        to: `stop:${q.to}`,
        at: q.at,
        arriveBy: q.arriveBy,
        limit: RESULT_LIMIT,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setResult({ status: "done", plan });
    } catch (e) {
      // a csendes frissítés hibája nem tünteti el a meglévő eredményt
      if (controller.signal.aborted || silent) return;
      const message =
        e instanceof TypeError
          ? "Nem sikerült elérni a szervert. Ellenőrizd a kapcsolatot, és próbáld újra."
          : e instanceof Error
            ? e.message
            : "Ismeretlen hiba történt.";
      setResult({ status: "error", message });
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-4 px-3 py-4 sm:px-4 sm:py-6">
        <div className="px-1">
          <h1 className="text-lg font-bold tracking-tight sm:text-xl">Útvonaltervező</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Mikor érsz be valójában? Menetrend, élő adat és mért késések egy
            helyen — múltbeli napra azt is megmutatja, mi történt.
          </p>
        </div>

        <PlanForm
          places={places}
          value={form}
          onChange={update}
          onNow={setNow}
          onSubmit={() => void run()}
          mode={mode}
          isLoading={result.status === "loading"}
        />

        <div ref={resultsRef} className="scroll-mt-3" aria-busy={result.status === "loading"}>
          <p className="sr-only" aria-live="polite">
            {result.status === "loading"
              ? "Keresés…"
              : result.status === "done"
                ? `${result.plan.trips.length} útvonal`
                : ""}
          </p>
          {result.status === "loading" ? <ResultsSkeleton /> : null}
          {result.status === "error" ? (
            <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
              {result.message}
            </p>
          ) : null}
          {result.status === "done" ? <PlanResults plan={result.plan} /> : null}
        </div>
      </div>
    </div>
  );
}
