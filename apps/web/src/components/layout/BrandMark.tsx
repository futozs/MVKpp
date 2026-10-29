import { cn } from "@/lib/utils";
import { FOCUS_RING } from "./headerStyles";

interface BrandMarkProps {
  /** A logó a kezdőnézetre (forgalmi térkép) visz. */
  onSelect: () => void;
  /** A másodlagos felirat („Forgalmi pult · Miskolc”) láthatósága. */
  labelClassName?: string;
  /** Mobilon 44 px magas érintési felület. */
  isTouch?: boolean;
}

/**
 * Szöveges márkajel. A csempe a térképen futó járművek viszonylatszám-csempéit
 * idézi (ugyanaz a súly, sarok és belső fény), így a fejléc és a térkép egy
 * nyelvet beszél.
 */
export function BrandMark({ onSelect, labelClassName, isTouch }: BrandMarkProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label="MVK++ — ugrás a forgalmi térképre"
      className={cn(
        "group flex shrink-0 items-center gap-2.5 rounded-md",
        isTouch ? "h-11 px-0.5" : "h-9 pr-1",
        FOCUS_RING,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-flex h-7 items-baseline rounded-[7px] bg-primary px-[7px] pt-[7px] font-sans font-extrabold leading-none text-primary-foreground",
          "border border-black/40 shadow-[inset_0_1px_0_hsl(0_0%_100%/0.22),0_1px_3px_hsl(160_40%_2%/0.6)]",
          "transition-transform duration-fast ease-out group-active:scale-[0.97]",
        )}
      >
        <span className="text-[13px] tracking-[-0.03em]">MVK</span>
        <span className="ml-px text-[10px] tracking-[-0.06em] opacity-60">++</span>
      </span>
      <span
        aria-hidden
        className={cn("flex-col items-start leading-none", labelClassName ?? "hidden")}
      >
        <span className="text-[13px] font-bold tracking-tight text-foreground">
          Forgalmi pult
        </span>
        <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Miskolc
        </span>
      </span>
    </button>
  );
}
