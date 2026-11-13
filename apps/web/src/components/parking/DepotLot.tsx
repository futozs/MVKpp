import { TramFront, Warehouse } from "lucide-react";
import type { DepotLot, DepotReason, DepotVehicle } from "@/services/parkingApi";
import { cn } from "@/lib/utils";
import { depotLine, hmOfDaySec, pct, REASON_LABEL } from "./format";
import { FavoriteButton, PresenceStrip, SignalDot, TipChip } from "./parts";
import type { LotContext } from "./TerminalLot";
import { displayVehicleId, vehicleIdTitle } from "@/lib/modes";

const ORDER: DepotReason[] = ["pull-in", "seen", "timeout", "not-today"];

const REASON_HINT: Record<DepotReason, string> = {
  "pull-in": "G-járattal (garázsmenettel) ért be a telephelyre",
  seen: "élő GPS-jellel a telephelyen áll",
  timeout: "a végállomáson 1 óránál tovább néma volt  kikapcsolva ment vissza",
  "not-today": "ma még egy menetet sem vitt",
};

/** Egy kocsiszín: az ott álló járművek, aszerint, hogyan kerültek oda. */
export function DepotLotCard({
  lot,
  ctx,
  serviceDate,
  favorite,
  onToggleFavorite,
}: {
  lot: DepotLot;
  ctx: LotContext;
  serviceDate: string;
  favorite: boolean;
  onToggleFavorite: () => void;
}) {
  const Icon = lot.id === "tram" ? TramFront : Warehouse;
  const groups = ORDER.map((reason) => ({ reason, vehicles: lot.vehicles.filter((v) => v.reason === reason) })).filter((g) => g.vehicles.length);
  return (
    <section className={cn("overflow-hidden rounded-2xl border bg-card shadow-sm", favorite ? "border-primary/35" : "border-border")}>
      <header className="flex items-center gap-3 border-b border-border/70 px-4 py-3.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-depot/15 text-depot">
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-bold leading-tight tracking-tight">{lot.name}</h3>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            {lot.vehicles.length ? `${lot.vehicles.length} ${lot.id === "tram" ? "villamos" : "busz"} nincs bevetésen` : "Most mindenki kint van"}
          </p>
        </div>
        <FavoriteButton active={favorite} name={lot.name} onToggle={onToggleFavorite} />
      </header>
      <div className="space-y-4 px-3 pb-4 pt-3">
        {groups.map((g) => (
          <div key={g.reason}>
            <h4 className="mb-2 flex items-baseline gap-2 px-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground" title={REASON_HINT[g.reason]}>
              {REASON_LABEL[g.reason]}
              <span className="font-mono text-foreground/80">{g.vehicles.length}</span>
            </h4>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(122px,1fr))] gap-1.5">
              {g.vehicles.map((v) => (
                <DepotStall key={v.id} v={v} ctx={ctx} serviceDate={serviceDate} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function DepotStall({ v, ctx, serviceDate }: { v: DepotVehicle; ctx: LotContext; serviceDate: string }) {
  const h = ctx.history(v.id);
  // Aki ma még nem volt kint: a szokásos kiállása és hogy ilyen napokon mennyire jellemző.
  const habit = !v.next && h?.outShare != null && v.reason === "not-today" ? `${h.usualOutS != null ? `ált. ${hmOfDaySec(h.usualOutS)} · ` : ""}${pct(h.outShare)}` : null;
  return (
    <button
      type="button"
      onClick={() => ctx.onSelect(v.id)}
      className={cn(
        "flex flex-col gap-1.5 rounded-xl border border-border bg-background/50 px-2.5 py-2 text-left transition-[border-color,background-color] duration-fast",
        "hover:border-depot/60 hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        v.reason === "not-today" && "border-dashed",
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="font-mono text-[14px] font-bold leading-none tabular-nums" title={vehicleIdTitle(v.id)}>{displayVehicleId(v.id)}</span>
        {v.reason === "seen" ? <SignalDot online /> : h ? <PresenceStrip recent={h.recent.slice(-7)} /> : null}
      </span>
      <span className="truncate text-[11px] leading-tight text-muted-foreground">{depotLine(v, h, serviceDate)}</span>
      {v.next ? (
        <TipChip tip={v.next} lookup={ctx.lookup} midnight={ctx.midnight} now={ctx.now} variant="stall" />
      ) : habit ? (
        <span className="truncate font-mono text-[10.5px] text-muted-foreground/80" title="Szokásos kiállás ilyen napokon, és hogy az elmúlt 8 hét ilyen napjainak hány százalékán volt kint">
          {habit}
        </span>
      ) : null}
    </button>
  );
}
