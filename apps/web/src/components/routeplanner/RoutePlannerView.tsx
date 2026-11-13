import { useEffect, useMemo, useRef, useState } from "react";
import type { Stop, TransitMode } from "@/types";
import { api, type JourneyMode, type JourneyPlanResponse } from "@/services/api";
import { nowLocalTime, todayLocalIso } from "./format";
import { zonedUnix } from "@/components/map/historyTime";
import { serverNow } from "@/lib/realtime";
import { feedOfId, isMergedTwin, modesParam, pickableStops, regionRank, useEnabledModes, useStopMerge } from "@/lib/modes";
import { usePreference } from "@/hooks/usePreference";
import { PlanForm, type PlanFormValue } from "./PlanForm";
import { PlanResults, ResultsSkeleton } from "./PlanResults";
import { travelEmptyHint, type PlanTravel } from "./TravelModes";

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

/**
 * A választható helyek a pipák szerint: az MVK megállói mindig, a Volánéi és a vasútállomások
 * csak bepipálva. Az állomás vágányai nem külön tételek; a megyén belüliek elöl.
 */
function usePlaces(stops: Stop[], travel: PlanTravel) {
  const merge = useStopMerge();
  return useMemo(() => {
    const allowed = (s: Stop) => {
      const f = s.feed && s.feed !== "mvk" ? s.feed : feedOfId(s.id);
      return f === "mvk" || (f === "coach" ? travel.coach : travel.rail);
    };
    const byName = new Map<string, Stop>();
    for (const s of pickableStops(stops)) if (allowed(s) && !isMergedTwin(s, merge) && !byName.has(s.name)) byName.set(s.name, s);
    return [...byName.values()].sort((a, b) => regionRank(a) - regionRank(b) || a.name.localeCompare(b.name, "hu"));
  }, [stops, travel.coach, travel.rail, merge]);
}

/**
 * Mivel tervezzünk: a tervező saját pipái (Volán, vonat), amíg a felhasználó nem állítja
 * őket, a Beállítások szerint. Ha a tervezőben olyan mód van bepipálva, ami a Beállításokban
 * ki van kapcsolva, annak a megállóit itt külön kérjük le.
 */
function useTravel(stops: Stop[]) {
  const enabled = useEnabledModes();
  const [coachPref, setCoach] = usePreference<boolean | null>("mvk_pref_plan_coach", null);
  const [railPref, setRail] = usePreference<boolean | null>("mvk_pref_plan_rail", null);
  const travel: PlanTravel = { coach: coachPref ?? enabled.includes("coach"), rail: railPref ?? enabled.includes("rail") };
  const modes: TransitMode[] = ["tram", "bus", ...(travel.coach ? (["coach"] as const) : []), ...(travel.rail ? (["rail"] as const) : [])];
  const key = modesParam(modes);
  const missing = (travel.coach && !enabled.includes("coach")) || (travel.rail && !enabled.includes("rail"));
  const [own, setOwn] = useState<{ key: string; stops: Stop[] } | null>(null);
  useEffect(() => {
    if (!missing) return;
    let alive = true;
    api
      .getStops(key)
      .then((list) => alive && setOwn({ key, stops: list }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [missing, key]);
  const change = (patch: Partial<PlanTravel>) => {
    if (patch.coach !== undefined) setCoach(patch.coach);
    if (patch.rail !== undefined) setRail(patch.rail);
  };
  return { travel, modes: key, change, stops: missing && own?.key === key ? own.stops : stops };
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
  const travel = useTravel(stops);
  const places = usePlaces(travel.stops, travel.travel);
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

  const lastQueryRef = useRef<{ from: string; to: string; at: number; arriveBy: boolean; modes: string } | null>(null);

  const run = async (silent = false) => {
    const last = lastQueryRef.current;
    // Élő terv csendes frissítése: a mostani időponttól (különben a rég elment buszok maradnának elöl).
    const q = silent
      ? last && !last.arriveBy
        ? { ...last, at: Math.floor(serverNow()) }
        : last
      : form.from && form.to
        ? { from: form.from, to: form.to, at: toUnix(form.date, form.time), arriveBy: form.arriveBy, modes: travel.modes }
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
        modes: q.modes,
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

  // Át-pipáláskor: a már nem választható hely (pl. vonat nélkül Budapest-Keleti) kiürül,
  // különben a meglévő terv azonnal újraszámolódik az új módokkal.
  const travelSeen = useRef(travel.modes);
  useEffect(() => {
    if (travelSeen.current === travel.modes) return;
    travelSeen.current = travel.modes;
    const ids = new Set(places.map((p) => p.id));
    const gone: Partial<PlanFormValue> = {
      ...(form.from && !ids.has(form.from) ? { from: "" } : {}),
      ...(form.to && !ids.has(form.to) ? { to: "" } : {}),
    };
    if (Object.keys(gone).length) {
      update(gone);
      abortRef.current?.abort();
      lastQueryRef.current = null;
      setResult({ status: "idle" });
      return;
    }
    if (lastQueryRef.current) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [travel.modes, places]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-4 px-3 py-4 sm:px-4 sm:py-6">
        <div className="px-1">
          <h1 className="text-lg font-bold tracking-tight sm:text-xl">Útvonaltervező</h1>
        </div>

        <PlanForm
          places={places}
          value={form}
          onChange={update}
          onNow={setNow}
          onSubmit={() => void run()}
          mode={mode}
          isLoading={result.status === "loading"}
          travel={travel.travel}
          onTravelChange={travel.change}
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
          {result.status === "done" ? <PlanResults plan={result.plan} emptyHint={travelEmptyHint(travel.travel)} /> : null}
        </div>
      </div>
    </div>
  );
}
