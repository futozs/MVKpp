import { useEffect, useMemo, useState } from "react";
import { alightAt, boardAt, pathLengthM, rideStopIdx, stopTimes, type RideStopEvent, type RideStopTime } from "@mvk/core/rides";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RouteTile } from "@/components/transit/RouteTile";
import { cn } from "@/lib/utils";
import { fixRide, type Ride, type RideFix } from "@/lib/rides";
import { StopChoiceList } from "./StopChoiceList";
import { tripDetailUrl, type TripDetail, type TripStop } from "./useTripLive";

const WHEN = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

type Leg = { stops: TripStop[]; times: Map<number, RideStopTime>; from: number | null; to: number | null };
type Loaded = { state: "loading" } | { state: "missing" } | { state: "ok"; legs: Leg[] };

/** A menetek megállói és tény-idői a saját napjukról (a javítás a régi utazásokra is működjön). */
function useLegs(legs: Ride[], enabled: boolean): Loaded {
  const [data, setData] = useState<{ key: string; loaded: Loaded } | null>(null);
  const key = legs.map((r) => `${r.serviceDate}|${r.tripId}`).join(",");
  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    const one = (r: Ride) =>
      fetch(tripDetailUrl(r.tripId, r.serviceDate), { signal: ctl.signal })
        .then((res) => (res.ok ? (res.json() as Promise<TripDetail & { events?: RideStopEvent[] }>) : null))
        .then((d): Leg | null => {
          if (!d?.stops?.length) return null;
          const idx = rideStopIdx(d.stops, r.fromStopId, r.toStopId);
          return { stops: d.stops, times: stopTimes(d.events ?? []), ...idx };
        });
    Promise.all(legs.map(one))
      .then((ls) => setData({ key, loaded: ls.every(Boolean) ? { state: "ok", legs: ls as Leg[] } : { state: "missing" } }))
      .catch(() => !ctl.signal.aborted && setData({ key, loaded: { state: "missing" } }));
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return data?.key === key ? data.loaded : { state: "loading" };
}

/**
 * Utólagos javítás: hol szálltál fel és hol szálltál le. Körbeutazásnál az
 * egész út egyszerre — a felszállás az első, a leszállás az utolsó menetben.
 */
export function RideFixSheet({ legs, initial, onClose }: { legs: Ride[]; initial: "from" | "to"; onClose: () => void }) {
  const sorted = useMemo(() => [...legs].sort((a, b) => a.boardedAt - b.boardedAt), [legs]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const loaded = useLegs(sorted.length > 1 ? [first, last] : [first], true);
  const [mode, setMode] = useState(initial);
  const [pick, setPick] = useState<{ from: number | null; to: number | null } | null>(null);

  const legA = loaded.state === "ok" ? loaded.legs[0] : null;
  const legB = loaded.state === "ok" ? (loaded.legs[1] ?? loaded.legs[0]) : null;
  const single = sorted.length === 1;
  const fromIdx = pick?.from ?? legA?.from ?? null;
  const toIdx = pick?.to ?? legB?.to ?? null;

  // Egy menetnél a felszállás a leszállás előtt van; körbeutazásnál a felszállás az első
  // menet végállomása előtt, a leszállás az utolsó menet kezdete után.
  const range = (): [number, number] => {
    if (!legA || !legB) return [0, -1];
    if (mode === "from") {
      const end = single ? (toIdx ?? legA.stops.length - 1) : (legA.to ?? legA.stops.length - 1);
      return [0, end - 1];
    }
    const start = single ? (fromIdx ?? 0) : (legB.from ?? 0);
    return [start + 1, legB.stops.length - 1];
  };
  const [lo, hi] = range();
  const changed = (pick?.from != null && pick.from !== legA?.from) || (pick?.to != null && pick.to !== legB?.to);

  const save = () => {
    if (!legA || !legB || fromIdx == null || toIdx == null) return;
    const board = boardAt(legA.stops, legA.times, fromIdx, { at: fromIdx === legA.from ? first.boardedAt : null, delayS: first.delayAtBoardS });
    const alight = alightAt(legB.stops, legB.times, toIdx, { at: toIdx === legB.to ? last.alightedAt : null, delayS: last.delayAtAlightS });
    if (!board || !alight) return;
    const fixes: Record<string, RideFix> = {};
    if (single) {
      fixes[first.id] = { ...board, ...alight, stops: Math.max(0, toIdx - fromIdx), distanceM: pathLengthM(legA.stops, fromIdx, toIdx) };
    } else {
      const firstEnd = legA.to ?? legA.stops.length - 1;
      const lastStart = legB.from ?? 0;
      fixes[first.id] = { ...board, stops: Math.max(0, firstEnd - fromIdx), distanceM: pathLengthM(legA.stops, fromIdx, firstEnd) };
      fixes[last.id] = { ...alight, stops: Math.max(0, toIdx - lastStart), distanceM: pathLengthM(legB.stops, lastStart, toIdx) };
    }
    fixRide(
      sorted.map((r) => r.id),
      fixes,
    );
    onClose();
  };

  const fromName = legA && fromIdx != null ? legA.stops[fromIdx]?.name : first.fromStopName;
  const toName = legB && toIdx != null ? legB.stops[toIdx]?.name : last.toStopName;
  const leg = mode === "from" ? legA : legB;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-md">
        <DialogHeader className="px-5 pb-3 pt-5 text-left">
          <DialogTitle className="flex items-center gap-2.5 pr-6">
            <RouteTile short={first.route} color={first.color} text={first.text} size="sm" />
            Hol szálltál fel és le?
          </DialogTitle>
          <DialogDescription className="truncate">
            {first.headsign} · {WHEN.format(new Date(first.boardedAt * 1000))} · <span className="font-mono">{first.vehicleId}</span>
          </DialogDescription>
        </DialogHeader>

        <div role="tablist" aria-label="Mit javítasz" className="mx-5 grid grid-cols-2 gap-2">
          {(["from", "to"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "min-w-0 rounded-xl border px-3 py-2 text-left transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                mode === m ? "border-primary/60 bg-primary/10" : "border-border hover:bg-accent",
              )}
            >
              <span className={cn("block text-[10.5px] font-semibold uppercase tracking-wide", mode === m ? "text-primary" : "text-muted-foreground")}>
                {m === "from" ? "Felszállás" : "Leszállás"}
              </span>
              <span className="block truncate text-[13px] font-semibold">{(m === "from" ? fromName : toName) ?? "?"}</span>
            </button>
          ))}
        </div>

        {loaded.state === "loading" ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">A menet megállóit töltöm…</p>
        ) : loaded.state === "missing" || !leg ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">Ennek a menetnek a megállói már nem érhetők el, így most nem javítható.</p>
        ) : (
          <StopChoiceList
            key={mode}
            className="mt-2 max-h-[46dvh] px-3"
            stops={leg.stops}
            lo={lo}
            hi={hi}
            times={leg.times}
            timeOf={mode === "from" ? "dep" : "arr"}
            selected={mode === "from" ? fromIdx : toIdx}
            onPick={(idx) => setPick((p) => ({ from: p?.from ?? null, to: p?.to ?? null, [mode]: idx }))}
          />
        )}

        <DialogFooter className="gap-2 border-t border-border/70 px-5 py-4 sm:space-x-0">
          <Button variant="ghost" onClick={onClose}>
            Mégse
          </Button>
          <Button onClick={save} disabled={!changed || fromIdx == null || toIdx == null}>
            Mentés
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
