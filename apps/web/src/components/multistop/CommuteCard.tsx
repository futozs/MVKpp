import { useEffect, useMemo, useState } from "react";
import { BellRing, Repeat, Sparkles } from "lucide-react";
import { budapestMinute, detectCommutes, upcomingCommute, type Commute } from "@mvk/core/commute";
import type { ArrivalItem, StopArrivalsResponse } from "@/types";
import { api } from "@/services/api";
import { RouteTile } from "@/components/transit/RouteTile";
import { DelayBar } from "@/components/transit/DelayBar";
import { CatchLine, StartRiskLine, TrafficLine } from "@/components/transit/TripInsights";
import { expectedArrival, useCatchFor } from "@/hooks/useCatch";
import { addAlert, noPushNote, removeAlert, useAlerts } from "@/lib/alerts";
import { serverNow, useFallbackPoll, useServerClockVersion, useTopic } from "@/lib/realtime";
import { useRides } from "@/lib/rides";
import { useWatchFeatures } from "@/lib/watchPrefs";
import { modesParam, useEnabledModes } from "@/lib/modes";
import { serviceNow } from "@/lib/serviceDay";
import { cn } from "@/lib/utils";

const POLL_MS = 15_000;
const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** „hétfőnként” … „vasárnaponként” (ISO: 1 = hétfő). */
const DOW_ADVERB = ["", "hétfőnként", "keddenként", "szerdánként", "csütörtökönként", "péntekenként", "szombatonként", "vasárnaponként"];

/** Mikor szokásos: „minden munkanap” vagy „szerdánként és csütörtökönként”. */
function commuteDaysText(c: Pick<Commute, "daily" | "dayKind" | "dows">): string {
  if (c.daily) return c.dayKind === "workday" ? "minden munkanap" : "hétvégente";
  const names = c.dows.map((d) => DOW_ADVERB[d]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} és ${names[names.length - 1]}` : (names[0] ?? "");
}

/**
 * A szokásos utazás indulása ma: ugyanaz a vonal (lehetőleg ugyanaz az irány), a még
 * el nem ment indulások közül a szokásos időhöz legközelebbi (egyenlőnél a korábbi).
 */
function pickDeparture(c: Commute, arrivals: ArrivalItem[], now: number): ArrivalItem | null {
  const same = arrivals.filter((a) => a.route === c.route && !a.cancelled);
  const dir = same.filter((a) => a.headsign === c.headsign);
  const pool = (dir.length ? dir : same).filter((a) => expectedArrival(a, now).at >= now - 30);
  const off = (a: ArrivalItem) => (a.schedUnix != null ? Math.abs(budapestMinute(a.schedUnix) - c.minute) : Infinity);
  let best: ArrivalItem | null = null;
  for (const a of pool) if (!best || off(a) < off(best)) best = a;
  return best;
}

/**
 * „Szokásos utad”: az utazásnaplóból felismert rendszeres út (ugyanaz a vonal,
 * megálló és időpont) — a Figyelő tetején, a szokásos idő előtt másfél órával.
 * Mutatja a következő indulást, hogy eléred-e, és naponta szólni is tud.
 */
const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

export function CommuteCard({ className }: { className?: string }) {
  const rides = useRides();
  const [now, setNow] = useState(() => serverNow());
  // a szerver órája a kapcsolódáskor érkezik — addig a készüléké
  const clockVersion = useServerClockVersion();
  useEffect(() => {
    setNow(serverNow());
    const t = setInterval(() => setNow(serverNow()), 30_000);
    return () => clearInterval(t);
  }, [clockVersion]);
  const commutes = useMemo(() => detectCommutes(rides, now), [rides, now]);
  const c = useMemo(() => upcomingCommute(commutes, now, serviceNow(now * 1000).iso), [commutes, now]);

  const modesKey = modesParam(useEnabledModes());
  const [data, setData] = useState<StopArrivalsResponse | null>(null);
  const load = async () => {
    if (!c) return;
    try {
      setData(await api.getArrivals(c.fromStopId, 12, modesKey));
    } catch {
      /* a következő kör újra próbálja */
    }
  };
  useEffect(() => {
    setData(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c?.fromStopId, modesKey]);
  useTopic(c ? `stop:${c.fromStopId}@${modesKey}` : null, (m) => setData(m.data as StopArrivalsResponse));
  useFallbackPoll(load, POLL_MS, Boolean(c));

  const stopPos = data?.stop.lat != null && data.stop.lon != null ? { lat: data.stop.lat, lon: data.stop.lon } : null;
  const catchFor = useCatchFor(stopPos);
  const alerts = useAlerts();
  const f = useWatchFeatures();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (!c || !f.commute) return null;
  const dep = data ? pickDeparture(c, data.arrivals, now) : null;
  const verdict = dep ? catchFor.verdict(dep) : null;
  const daily = alerts.find((a) => a.stopId === c.fromStopId && a.slot.startsWith(`commute:${c.route}:`)) ?? null;

  // Naponta: a menetrend szerinti indulási percre (± 4 perc) — a mostani helyedtől számolt sétával.
  const toggleDaily = async () => {
    setBusy(true);
    setNote(null);
    try {
      if (daily) {
        await removeAlert(daily.stopId, daily.slot);
        return;
      }
      const schedMin = dep?.schedUnix != null ? budapestMinute(dep.schedUnix) : c.minute;
      const walkS = catchFor.walkS ?? 0;
      const r = await addAlert({
        slot: `commute:${c.route}:${schedMin}`,
        kind: "leave",
        stopId: c.fromStopId,
        stopName: c.fromStopName,
        routeShorts: [c.route],
        schedMin,
        // csak a szokásos napokon (pl. szerdán és csütörtökön), vagy minden munkanap / hétvégén
        params: { walkS, days: c.daily ? c.dayKind : c.dows },
      });
      if (!r.ok) setNote(r.reason ?? "Nem sikerült bekapcsolni.");
      else setNote(`${capitalize(commuteDaysText(c))} ${hm(schedMin)}-ra szólok, amikor indulni kell${walkS ? ` (${Math.round(walkS / 60)} perc séta innen)` : ""}.${r.push ? "" : ` ${noPushNote(r)}`}`);
    } finally {
      setBusy(false);
    }
  };

  const etaMin = dep ? Math.max(0, Math.round((expectedArrival(dep, now).at - now) / 60)) : null;

  return (
    <section aria-label="Szokásos utad" className={cn("rounded-xl border border-primary/30 bg-primary/[0.06] px-3 py-2.5", className)}>
      <div className="flex items-center gap-2">
        <Sparkles aria-hidden className="h-3.5 w-3.5 shrink-0 text-primary" />
        <p className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-primary">
          Szokásos utad · ~{hm(c.minute)}
        </p>
        <button
          type="button"
          onClick={() => void toggleDaily()}
          disabled={busy}
          aria-pressed={Boolean(daily)}
          title={daily ? `${capitalize(commuteDaysText(c))} szólok, amikor indulni kell — koppints a kikapcsoláshoz` : `Szólj ${commuteDaysText(c)}, amikor indulnom kell`}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold transition-colors",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            daily ? "border-primary bg-primary text-primary-foreground" : "border-primary/40 text-primary hover:bg-primary/10",
          )}
        >
          {daily ? <BellRing aria-hidden className="h-3 w-3" /> : <Repeat aria-hidden className="h-3 w-3" />}
          {daily ? "Szólok ilyenkor" : "Szólj ilyenkor"}
        </button>
      </div>

      <div className="mt-2 flex items-center gap-2.5">
        <RouteTile short={c.route} color={dep?.color ?? c.color} text={dep?.text ?? c.text} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold">
            {c.fromStopName} <span className="text-muted-foreground">{c.loop ? "· körbeutazás" : `→ ${c.toStopName ?? c.headsign}`}</span>
          </p>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            {dep ? (
              <>
                <span className="font-mono font-bold tabular-nums text-foreground">{dep.time}</span>
                <DelayBar delaySec={dep.delaySec ?? dep.measuredDelaySec ?? null} showLabel={false} />
              </>
            ) : (
              <span>{data ? "Most nincs közeli indulás ezen a vonalon." : "Indulások lekérése…"}</span>
            )}
          </div>
          {/* külön sorban: a napok listája telefonon sem vágódik le */}
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {c.rides} út · {commuteDaysText(c)}
          </p>
        </div>
        {etaMin != null ? (
          <span className="shrink-0 font-mono text-lg font-bold tabular-nums">
            {etaMin <= 0 ? <span className="text-live">most</span> : (
              <>
                {etaMin}
                <span className="ml-0.5 font-sans text-[11px] font-semibold text-muted-foreground">p</span>
              </>
            )}
          </span>
        ) : null}
      </div>

      {dep ? (
        <>
          {f.startRisk ? <StartRiskLine risk={dep.startRisk} className="mt-1.5" /> : null}
          {f.traffic ? <TrafficLine traffic={dep.trafficAhead} className="mt-1.5" /> : null}
          <CatchLine className="mt-2" verdict={f.catch ? verdict : null} alertOn={false} />
        </>
      ) : null}
      {note ? <p className="mt-1.5 text-[10.5px] text-muted-foreground">{note}</p> : null}
    </section>
  );
}
