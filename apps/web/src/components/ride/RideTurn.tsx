import { useEffect, useState } from "react";
import { LogOut, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RouteTile } from "@/components/transit/RouteTile";
import { API_BASE } from "@/lib/apiBase";
import { serverNow } from "@/lib/realtime";
import type { LoopPlan, RideTurn } from "@/lib/rides";

export interface ContinuationNext {
  tripId: string;
  route: string;
  color: string;
  text: string;
  headsign: string;
  firstStopId: string;
  firstStopName: string;
  depTs: number;
  depTime: string;
  /** loop: ugyanabból a megállóból indul · nearby: a szomszédos kocsiállásból · null: máshonnan */
  kind: "loop" | "nearby" | null;
  source: "live" | "plan";
  cancelled: boolean;
  departed: boolean;
  departedAt: number | null;
  startDelayS: number | null;
}

export interface Continuation {
  terminus: { stopId: string; name: string; idx: number };
  /** a végállomás fordulóhurok */
  loop: boolean;
  arrivedAt: number | null;
  vehicle: { lat: number; lon: number } | null;
  next: ContinuationNext | null;
}

const POLL_MS = 10_000;

export const continuationUrl = (tripId: string, vehicleId: string) =>
  `${API_BASE}/engine/continuation?trip=${encodeURIComponent(tripId)}&vehicle=${encodeURIComponent(vehicleId)}`;

/** Egyszeri lekérés: hogyan folytatja a busz a menet végállomásáról (null: nem elérhető). */
export async function fetchContinuation(tripId: string, vehicleId: string): Promise<Continuation | null> {
  const r = await fetch(continuationUrl(tripId, vehicleId), { cache: "no-store" }).catch(() => null);
  return r?.ok ? ((await r.json().catch(() => null)) as Continuation | null) : null;
}

/**
 * A végállomáson: hogyan folytatja a busz (melyik menettel, mikor, honnan).
 * Fordulás közben 10 mp-enként frissül, hogy az indulást azonnal lássuk.
 */
export function useContinuation(tripId: string, vehicleId: string, enabled: boolean): Continuation | null {
  const [data, setData] = useState<{ key: string; c: Continuation } | null>(null);
  const key = `${tripId}|${vehicleId}`;
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () =>
      fetchContinuation(tripId, vehicleId).then((c) => {
        if (alive && c) setData({ key, c });
      });
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [enabled, tripId, vehicleId, key]);
  return enabled && data?.key === key ? data.c : null;
}

const HM = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", hour: "2-digit", minute: "2-digit" });
const hm = (unix: number) => HM.format(new Date(unix * 1000));

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Math.round(serverNow()));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.round(serverNow())), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function inLabel(sec: number): string {
  if (sec <= 30) return "most indul";
  return `${Math.round(sec / 60)} perc múlva`;
}

/**
 * Körbeutazás a végállomáson: az utas előre megmondta, hogy a buszon marad.
 * Amint a busz a következő menetével elindul, ezzel az utazással folytatjuk 
 * akkor is, ha a telefon közben a zsebben van, lezárva.
 */
export function TurnCard({ turn, plan, cont, onAlight }: { turn: RideTurn; plan: LoopPlan; cont: Continuation | null; onAlight: () => void }) {
  const now = useNow(15_000);
  const next = cont?.next ?? null;
  const late = next ? Math.max(0, now - next.depTs) : 0;

  return (
    <div className="mx-4 mb-3 rounded-xl border border-primary/40 bg-primary/[0.08] px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
        <Repeat className="h-3.5 w-3.5" aria-hidden /> Körbeutazás · {turn.terminusName}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Beért {hm(turn.arrivedAt)}-kor. {next ? "Maradj ülve  a busz innen így megy tovább:" : "Keresem, mikor és merre indul tovább a busz…"}
      </p>
      {next ? (
        <div className="mt-2 flex items-center gap-2.5">
          <RouteTile short={next.route} color={next.color} text={next.text} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold">{next.headsign}</p>
            <p className="text-xs text-muted-foreground">
              indul <span className="font-mono font-bold text-foreground">{next.depTime}</span>
              {" · "}
              {next.departed ? "elindult" : late > 60 ? `${Math.round(late / 60)} perce esedékes` : inLabel(next.depTs - now)}
              {next.kind === "nearby" ? ` · a szomszédos kocsiállásból (${next.firstStopName})` : null}
              {next.cancelled ? " · törölték" : null}
            </p>
          </div>
        </div>
      ) : null}
      <p className="mt-2 text-[11.5px] text-muted-foreground">
        {plan.stopName ? (
          <>
            Leszállás: <span className="font-semibold text-foreground">{plan.stopName}</span>  ha odaértél, magától lezárom.
          </>
        ) : (
          "Ha a busz elindul, kiválaszthatod, hol szállsz le."
        )}
      </p>
      <Button size="sm" variant="outline" className="mt-2 w-full" onClick={onAlight}>
        <LogOut /> Mégis itt szálltam le
      </Button>
    </div>
  );
}
