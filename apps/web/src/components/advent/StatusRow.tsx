import { Clock3, Gauge, TramFront, type LucideIcon } from "lucide-react";
import { END_LABEL } from "@mvk/core/advent/season";
import { cn } from "@/lib/utils";
import type { PublicDay, SeasonMeta } from "./adventApi";
import { delayTone, hm, TONE_BOX, TONE_TEXT } from "./adventText";

/**
 * A szerelvény most: állapot 1–2 szóban (bizonyossággal), a késés, és a következő
 * megálló vagy indulás. Alattuk a bizonyítékok (pl. „6 perce áll”, „mögötte 2 villamos”).
 */
export function StatusRow({ day, season }: { day: PublicDay; season: SeasonMeta }) {
  const now = day.now;
  const running = day.trips.find((t) => t.verdict === "running");
  const nextEta = running ? day.etas.find((e) => e.trip === running.key) : null;
  const delay = now.delayS;
  const delayWord = delay == null ? "–" : Math.abs(delay) < 90 ? "Pontos" : delay > 0 ? `+${Math.round(delay / 60)} perc` : `${Math.round(-delay / 60)} p korán`;
  const lastDone = [...day.trips].reverse().find((t) => t.arrDelayS != null);

  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1.4fr_1fr_1fr] xl:grid-cols-2">
        <Tile
          icon={TramFront}
          label={season.vehicleIds[0]}
          title={now.label}
          sub={now.detail}
          box={TONE_BOX[now.tone]}
          titleClass={TONE_TEXT[now.tone]}
          alert={now.tone === "bad"}
          badge={now.confidence}
          pulse={now.tone === "live"}
          className="col-span-2 sm:col-span-1 xl:col-span-2"
        />
        <Tile
          icon={Gauge}
          label="Késés"
          title={running ? delayWord : lastDone ? `${Math.round((lastDone.arrDelayS ?? 0) / 60) > 0 ? "+" : ""}${Math.round((lastDone.arrDelayS ?? 0) / 60)} perc` : "–"}
          sub={running ? "most" : lastDone ? `beérkezéskor, ${hm(lastDone.arr)}` : "még nincs mérés"}
          box="border-border bg-card"
          titleClass={running ? delayTone(delay) : lastDone ? delayTone(lastDone.arrDelayS) : "text-muted-foreground"}
        />
        <Tile
          icon={Clock3}
          label="Következő"
          title={nextEta ? hm(nextEta.eta) : now.next ? hm(now.next.expected) : "–"}
          sub={
            nextEta
              ? season.stops[nextEta.stop].name
              : now.next
                ? `${END_LABEL[now.next.from]}${now.next.expected > now.next.sched ? ` (${hm(now.next.sched)} helyett)` : ""}`
                : "ma nincs több"
          }
          box="border-border bg-card"
          titleClass="text-foreground"
        />
      </div>
      {now.chips.length ? (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Részletek">
          {now.chips.map((c) => (
            <li
              key={c}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold",
                now.tone === "bad" ? "border-late/40 text-late" : "border-border text-muted-foreground",
              )}
            >
              {c}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  title,
  sub,
  box,
  titleClass,
  alert,
  badge,
  pulse,
  className,
}: {
  icon: LucideIcon;
  label: string;
  title: string;
  sub: string | null;
  box: string;
  titleClass: string;
  alert?: boolean;
  badge?: string | null;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <div role={alert ? "alert" : undefined} className={cn("flex min-w-0 flex-col justify-between gap-1 rounded-xl border px-3 py-2", box, className)}>
      <span className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", titleClass)} aria-hidden />
        <span className="truncate">{label}</span>
        {pulse ? <span className="ml-auto h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-advent-gold motion-reduce:animate-none" aria-hidden /> : null}
      </span>
      <span className={cn("truncate text-[17px] font-extrabold leading-tight tracking-tight", titleClass)}>{title}</span>
      <span className="flex min-w-0 items-center gap-1 text-[11.5px] text-muted-foreground">
        <span className="truncate">{sub ?? " "}</span>
        {badge ? <span className="shrink-0 rounded bg-foreground/10 px-1 text-[10px] font-bold text-foreground/80">{badge}</span> : null}
      </span>
    </div>
  );
}
