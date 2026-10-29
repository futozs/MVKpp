import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A térkép egyetlen vezérlő-eleme: mind a négy sarokban ugyanaz a méret
 * (44 px — ujjal is biztosan eltalálható), ugyanaz az üveghatású kártya,
 * ugyanaz a hover / fókusz / bekapcsolt állapot.
 */
const BASE = cn(
  "pointer-events-auto relative inline-flex h-11 shrink-0 select-none items-center justify-center gap-2 rounded-xl",
  "border border-border/80 bg-card/90 text-foreground shadow-md backdrop-blur-md",
  "text-[13px] font-semibold transition-[background-color,border-color,color,transform] duration-fast",
  "hover:bg-accent active:scale-[0.97]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  "disabled:pointer-events-none disabled:opacity-50",
);

export type MapControlProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  icon: LucideIcon;
  /** a felirat (képernyőolvasónak mindig, látványként a `showLabel` szerint) */
  label: string;
  /** always: mindig · wide: csak sm+ szélességen · never: csak ikon */
  showLabel?: "always" | "wide" | "never";
  /** bekapcsolt állapot (pl. szűrés él, helymeghatározás fut, lenyíló nyitva) */
  active?: boolean;
  /** kis számláló a sarokban (pl. hány szűrő él) */
  badge?: number | null;
  /** ikon animálása (pl. helyzet keresése közben) */
  busy?: boolean;
  children?: ReactNode;
};

export const MapControl = forwardRef<HTMLButtonElement, MapControlProps>(function MapControl(
  { icon: Icon, label, showLabel = "never", active = false, badge, busy, className, children, ...rest },
  ref,
) {
  const labelled = showLabel !== "never";
  return (
    <button
      ref={ref}
      type="button"
      aria-label={showLabel === "always" ? undefined : label}
      aria-pressed={rest["aria-expanded"] === undefined ? active : undefined}
      className={cn(
        BASE,
        labelled ? (showLabel === "wide" ? "w-11 sm:w-auto sm:px-3.5" : "px-3.5") : "w-11",
        active && "border-primary/60 bg-card text-primary",
        className,
      )}
      {...rest}
    >
      <Icon aria-hidden className={cn("h-[18px] w-[18px] shrink-0", busy && "animate-pulse")} />
      {labelled ? <span className={cn(showLabel === "wide" && "hidden sm:inline", "whitespace-nowrap")}>{label}</span> : null}
      {children}
      {badge ? (
        <span
          aria-hidden
          className="absolute -right-1.5 -top-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 font-mono text-[10px] font-bold tabular-nums text-primary-foreground ring-2 ring-background"
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
});

/** Egymáshoz tapadó vezérlők egy kártyán (pl. nagyítás + / −). */
export function MapControlGroup({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "pointer-events-auto flex flex-col overflow-hidden rounded-xl border border-border/80 bg-card/90 shadow-md backdrop-blur-md",
        "divide-y divide-border/70",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function MapGroupButton({ icon: Icon, label, onClick, disabled }: { icon: LucideIcon; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-11 w-11 items-center justify-center text-foreground transition-colors duration-fast hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:opacity-40"
    >
      <Icon aria-hidden className="h-[18px] w-[18px]" />
    </button>
  );
}

type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

const CORNER: Record<Corner, string> = {
  "top-left": "left-3 top-3 items-start",
  "top-right": "right-3 top-3 items-end",
  "bottom-left": "bottom-3 left-3 items-start mb-[env(safe-area-inset-bottom)]",
  "bottom-right": "bottom-3 right-3 items-end mb-[env(safe-area-inset-bottom)]",
};

/**
 * Egy sarok vezérlői egymás alatt, egységes 12 px-es margóval. Az üres
 * terület átengedi az érintést a térképnek.
 */
export function MapCorner({
  corner,
  children,
  className,
  style,
  row,
}: {
  corner: Corner;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** egymás mellett (vízszintesen) a függőleges oszlop helyett */
  row?: boolean;
}) {
  return (
    <div
      className={cn("pointer-events-none absolute z-overlay flex gap-2", row ? "flex-row" : "flex-col", CORNER[corner], className)}
      style={style}
    >
      {children}
    </div>
  );
}
