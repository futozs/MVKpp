/**
 * A fejléc közös fókusz- és felületstílusai — egy helyen, hogy az asztali és a
 * mobil fejléc minden vezérlője ugyanúgy reagáljon billentyűzetre.
 */

/** Különálló vezérlő (gomb, fül): gyűrű a kártya-háttértől elválasztva. */
export const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card";

/** Csoporton belüli szegmens: a gyűrű befelé rajzolódik, így nem vágja le a keret. */
export const FOCUS_RING_INSET =
  "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** A „mélyített” sáv, amelyben a fülek és az élő állapot ülnek. */
export const WELL =
  "rounded-lg border border-border bg-background/70 shadow-[inset_0_1px_2px_hsl(160_40%_2%/0.45)]";

/** Ikongomb a fejlécben (asztali: 36 px, mobil: 44 px érintési felület). */
export const ICON_BUTTON =
  "inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground active:bg-accent/70 [&_svg]:h-[18px] [&_svg]:w-[18px]";

/** Lenyíló panel felülete. */
export const PANEL_SURFACE =
  "rounded-lg border border-border bg-popover text-popover-foreground shadow-xl";
