import { Bus, TramFront, type LucideIcon } from "lucide-react";
import type { BoardSnapshot } from "@mvk/core";
import { cn } from "@/lib/utils";
import { busTile, tramTile, type Tile, type Tone } from "./fleetText";

const TONE: Record<Tone, { box: string; title: string; icon: string }> = {
  ok: { box: "border-border bg-card", title: "text-foreground", icon: "text-ontime" },
  off: { box: "border-border bg-card", title: "text-muted-foreground", icon: "text-muted-foreground" },
  warn: { box: "border-nosignal/40 bg-nosignal/[0.08]", title: "text-nosignal", icon: "text-nosignal" },
  bad: { box: "border-late/50 bg-late/10", title: "text-late", icon: "text-late" },
};

/** A két hálózat állapota egy-egy csempén; koppintásra a részletek (Hálózat). */
export function StatusTiles({ data, onOpen, className }: { data: BoardSnapshot; onOpen: () => void; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 gap-2", className)}>
      <TileButton icon={TramFront} label="Villamos" tile={tramTile(data.tram)} onClick={onOpen} />
      <TileButton icon={Bus} label="Busz" tile={busTile(data.bus)} onClick={onOpen} />
    </div>
  );
}

function TileButton({ icon: Icon, label, tile, onClick }: { icon: LucideIcon; label: string; tile: Tile; onClick: () => void }) {
  const t = TONE[tile.tone];
  return (
    <button
      type="button"
      onClick={onClick}
      role={tile.tone === "bad" ? "alert" : undefined}
      className={cn("flex min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors duration-fast hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", t.box)}
    >
      <Icon className={cn("h-5 w-5 shrink-0", t.icon)} aria-hidden />
      <span className="min-w-0">
        <span className="block text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className={cn("block truncate text-[15px] font-extrabold leading-tight", t.title)}>{tile.title}</span>
        <span className="block truncate text-[11.5px] text-muted-foreground">{tile.sub}</span>
      </span>
    </button>
  );
}
