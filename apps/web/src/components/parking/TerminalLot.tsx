import { SquareParking } from "lucide-react";
import type { FleetHistory, ParkedVehicle, TerminalLot } from "@/services/parkingApi";
import { cn } from "@/lib/utils";
import { durationText, hmOfDaySec } from "./format";
import { FavoriteButton, RouteChip, SignalDot, TipChip, type RouteLookup } from "./parts";
import { displayVehicleId, vehicleIdTitle } from "@/lib/modes";

export interface LotContext {
  now: number;
  midnight: number;
  limitS: number;
  lookup: RouteLookup;
  history: (id: string) => FleetHistory | undefined;
  onSelect: (id: string) => void;
  /** Volán / vasút: nincs kocsiszín, így a „néma → beáll” sáv sem */
  regional?: boolean;
}

/** Egy végállomás parkolója: fejléc a következő indulással, alatta a beállók. */
export function TerminalLotCard({
  lot,
  ctx,
  favorite,
  onToggleFavorite,
}: {
  lot: TerminalLot;
  ctx: LotContext;
  favorite: boolean;
  onToggleFavorite: () => void;
}) {
  const next = lot.vehicles
    .filter((v) => v.next)
    .sort((a, b) => a.next!.startS - b.next!.startS)[0];
  return (
    <section className={cn("flex flex-col overflow-hidden rounded-2xl border bg-card shadow-sm", favorite ? "border-primary/35" : "border-border")}>
      <header className="flex items-start gap-3 px-4 pb-3 pt-3.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-park/15 text-park">
          <SquareParking className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-bold leading-tight tracking-tight">{lot.name}</h3>
          <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
            {next?.next ? (
              <>
                Következő innen: <span className="font-mono font-semibold text-foreground">{next.next.route}</span>{" "}
                <span className="font-mono tabular-nums">{hmOfDaySec(next.next.startS)}</span> ·{" "}
                <span className="font-mono">{displayVehicleId(next.id)}</span>
                {next.next.certain ? "" : " (tipp)"}
              </>
            ) : (
              "Nincs ismert indulás innen"
            )}
          </p>
        </div>
        <span className="flex items-center gap-1">
          <span className="rounded-md bg-park/10 px-2 py-0.5 font-mono text-sm font-bold tabular-nums text-park">{lot.vehicles.length}</span>
          <FavoriteButton active={favorite} name={lot.name} onToggle={onToggleFavorite} />
        </span>
      </header>
      {/* A beállók: függőleges szaggatott vonalak választják el a járműveket, mint egy valódi parkolóban. */}
      <div className="grid flex-1 grid-cols-[repeat(auto-fill,minmax(138px,1fr))] border-t border-border/70 bg-muted/25 px-1.5 py-2">
        {lot.vehicles.length === 0 ? (
          <p className="col-span-full m-1 rounded-xl border border-dashed border-border px-3 py-4 text-center text-[12px] text-muted-foreground">
            Most senki sem parkol itt
          </p>
        ) : null}
        {lot.vehicles.map((v) => (
          <div
            key={v.id}
            className="relative p-1 after:absolute after:bottom-2 after:right-0 after:top-2 after:border-r after:border-dashed after:border-border"
          >
            <ParkedTile v={v} ctx={ctx} />
          </div>
        ))}
      </div>
    </section>
  );
}

export function ParkedTile({ v, ctx }: { v: ParkedVehicle; ctx: LotContext }) {
  // a vonat neve hosszabb a rendszámnál („FLIRT 415 112”): kisebb betűvel egy sorban marad
  const label = displayVehicleId(v.id);
  const parked = v.since ? Math.max(0, ctx.now - v.since) : null;
  // Néma járműnél az 1 órás határig hátralévő idő: utána a kocsiszínbe soroljuk.
  const silent = !v.online && v.lastSeen ? Math.max(0, ctx.now - v.lastSeen) : null;
  const toLimit = silent != null && !ctx.regional ? Math.min(1, silent / ctx.limitS) : null;
  return (
    <button
      type="button"
      onClick={() => ctx.onSelect(v.id)}
      className={cn(
        "group flex w-full flex-col gap-1.5 rounded-xl border bg-card px-2.5 pb-2 pt-2 text-left shadow-xs transition-[border-color,transform,box-shadow] duration-fast",
        "hover:-translate-y-px hover:border-park/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        v.next?.certain ? "border-primary/40" : "border-border",
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span
          className={cn("whitespace-nowrap font-mono font-bold leading-none tabular-nums", label.length > 9 ? "text-[12.5px]" : "text-[15px]")}
          title={vehicleIdTitle(v.id)}
        >
          {label}
        </span>
        <SignalDot online={v.online} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <RouteChip route={v.lastRoute} lookup={ctx.lookup} />
        <span className="truncate">{parked != null ? `áll ${durationText(parked)}` : v.online ? "itt áll" : ""}</span>
      </span>
      {toLimit != null ? (
        <span
          className="h-1 w-full overflow-hidden rounded-full bg-muted"
          title={`${durationText(silent!)} óta nincs jel  ${Math.round(ctx.limitS / 60)} perc után a kocsiszínbe soroljuk`}
        >
          <span
            className={cn("block h-full origin-left rounded-full", toLimit > 0.75 ? "bg-nosignal" : "bg-park/70")}
            style={{ transform: `scaleX(${toLimit})` }}
          />
        </span>
      ) : null}
      {v.next ? <TipChip tip={v.next} lookup={ctx.lookup} midnight={ctx.midnight} now={ctx.now} variant="tile" /> : null}
    </button>
  );
}
