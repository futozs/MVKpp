import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronLeft, ChevronRight, RotateCw, X } from "lucide-react";
import type { NewsFeed, NewsItem, NewsRoute } from "@mvk/core";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { RouteTile } from "@/components/transit/RouteTile";
import { cn } from "@/lib/utils";
import { NewsBody } from "./NewsBody";
import { dateTab, publishedLabel } from "./newsTime";

/** a lista egy sorában ennyi járat fér el, a többi „+N” */
const ROW_ROUTES_MAX = 6;
const PUSH = { duration: 0.24, ease: [0.22, 1, 0.36, 1] as const };

type Routes = Record<string, NewsRoute>;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  feed: NewsFeed | null;
  error: string | null;
  isLoading: boolean;
  /** a megnyitáskor még nem látott hírek */
  fresh: Set<number>;
  onRetry: () => void;
  /** csak ez a járat maradjon a térképen */
  onShowRoute: (routeId: string) => void;
};

/**
 * Az MVK hírei: lista → cikk, egy ablakon belül (a cikk ráfut a listára, a
 * lista görgetése megmarad). Esc a cikkből a listára lép vissza.
 */
export function NewsDialog({ open, onOpenChange, feed, error, isLoading, fresh, onRetry, onShowRoute }: Props) {
  const [openId, setOpenId] = useState<number | null>(null);
  const rows = useRef(new Map<number, HTMLButtonElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const current = feed?.items.find((it) => it.id === openId) ?? null;

  const back = () => {
    const id = openId;
    setOpenId(null);
    if (id != null) requestAnimationFrame(() => rows.current.get(id)?.focus());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(88dvh,760px)] max-h-[88dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px] sm:p-0 [&>button:last-child]:hidden"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          listRef.current?.focus();
        }}
        // a bezárás animációja után: a következő megnyitás a listával indul
        onCloseAutoFocus={() => setOpenId(null)}
        onEscapeKeyDown={(e) => {
          if (current) {
            e.preventDefault();
            back();
          }
        }}
      >
        <div className="relative min-h-0 flex-1">
          <section inert={Boolean(current)} className="absolute inset-0 flex flex-col">
            <header className="shrink-0 border-b border-border py-[18px] pl-5 pr-14">
              <DialogTitle className="text-[17px] font-bold leading-[21px]">Hírek</DialogTitle>
              <DialogDescription className="mt-1 text-[12px] leading-snug">
                Az MVK Zrt. közleményei{feed?.items.length ? ` · ${feed.items.length} aktuális` : ""}
              </DialogDescription>
              {feed?.stale ? (
                <p className="mt-2 flex items-center gap-1.5 text-[11.5px] font-medium text-nosignal">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-nosignal" />
                  Az MVK most nem válaszol — a legutóbb letöltött hírek látszanak.
                </p>
              ) : null}
            </header>
            {/* relative: a sorok sr-only címkéi is ezen belül maradjanak, különben az egész ablak görgethető lesz */}
            <div ref={listRef} tabIndex={-1} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)] focus:outline-none">
              <ListBody feed={feed} error={error} isLoading={isLoading} fresh={fresh} onRetry={onRetry} rows={rows.current} onOpen={setOpenId} />
            </div>
          </section>

          <AnimatePresence>
            {current && feed ? <Article key={current.id} item={current} routes={feed.routes} onBack={back} onShowRoute={onShowRoute} /> : null}
          </AnimatePresence>
        </div>

        <DialogClose
          aria-label="Bezárás"
          className="absolute right-2.5 top-2.5 z-10 inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <X className="h-[18px] w-[18px]" />
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

function ListBody({
  feed,
  error,
  isLoading,
  fresh,
  onRetry,
  rows,
  onOpen,
}: Pick<Props, "feed" | "error" | "isLoading" | "fresh" | "onRetry"> & { rows: Map<number, HTMLButtonElement>; onOpen: (id: number) => void }) {
  if (!feed && isLoading) return <ListSkeleton />;
  if (!feed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <p className="max-w-[280px] text-[13.5px] leading-relaxed text-muted-foreground">{error ?? "Az MVK hírei most nem érhetők el."}</p>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] font-semibold transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <RotateCw aria-hidden className="h-3.5 w-3.5" />
          Újra
        </button>
      </div>
    );
  }
  if (!feed.items.length) {
    return <p className="flex h-full items-center justify-center px-8 text-center text-[13.5px] text-muted-foreground">Most nincs aktuális MVK-közlemény.</p>;
  }
  return (
    <ol className="divide-y divide-border/60">
      {feed.items.map((it) => (
        <li key={it.id}>
          <button
            ref={(el) => {
              if (el) rows.set(it.id, el);
              else rows.delete(it.id);
            }}
            type="button"
            onClick={() => onOpen(it.id)}
            className="group grid w-full grid-cols-[2.75rem_minmax(0,1fr)_1rem] items-start gap-x-3.5 px-5 py-3.5 text-left transition-colors hover:bg-accent/45 focus-visible:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
          >
            <DateTab unix={it.modifiedAt} isFresh={fresh.has(it.id)} />
            <div className="min-w-0">
              {it.type ? <p className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{it.type}</p> : null}
              <h3 className="line-clamp-2 text-pretty text-[14.5px] font-semibold leading-snug text-foreground">
                {fresh.has(it.id) ? <span className="sr-only">Új: </span> : null}
                {it.title}
              </h3>
              {it.summary && it.summary !== it.title ? <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground">{it.summary}</p> : null}
              {it.routes.length ? <RouteStrip ids={it.routes} routes={feed.routes} /> : null}
            </div>
            <ChevronRight aria-hidden className="mt-1 h-4 w-4 text-muted-foreground/45 transition-[transform,color] duration-fast group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
          </button>
        </li>
      ))}
    </ol>
  );
}

/** Kis naptárlap: a hír utolsó módosításának napja; a még nem látottnál pötty. */
function DateTab({ unix, isFresh }: { unix: number; isFresh: boolean }) {
  const { day, month } = dateTab(unix);
  return (
    <div
      aria-hidden
      className={cn(
        "relative flex h-11 flex-col items-center justify-center rounded-lg border bg-card leading-none",
        isFresh ? "border-primary/45" : "border-border/80",
      )}
    >
      <span className="font-mono text-[16px] font-bold tabular-nums text-foreground">{day}</span>
      <span className="mt-1 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{month}</span>
      {isFresh ? <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-background" /> : null}
    </div>
  );
}

function RouteStrip({ ids, routes }: { ids: string[]; routes: Routes }) {
  const shown = ids.filter((id) => routes[id]).slice(0, ROW_ROUTES_MAX);
  const rest = ids.length - shown.length;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {shown.map((id) => (
        <RouteTile key={id} short={routes[id].short} color={routes[id].color} text={routes[id].text} size="sm" />
      ))}
      {rest > 0 ? <span className="pl-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground">+{rest}</span> : null}
    </div>
  );
}

function ListSkeleton() {
  return (
    <ul aria-busy="true" aria-label="Betöltés" className="divide-y divide-border/60">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-x-3.5 px-5 py-4">
          <div className="h-11 rounded-lg bg-muted motion-safe:animate-pulse" />
          <div className="space-y-2 pt-0.5">
            <div className="h-3.5 w-4/5 rounded bg-muted motion-safe:animate-pulse" />
            <div className="h-3 w-full rounded bg-muted/70 motion-safe:animate-pulse" />
            <div className="h-3 w-2/3 rounded bg-muted/70 motion-safe:animate-pulse" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Article({ item, routes, onBack, onShowRoute }: { item: NewsItem; routes: Routes; onBack: () => void; onShowRoute: (id: string) => void }) {
  const reduce = useReducedMotion();
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = `news-${item.id}`;
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  const from = reduce ? { opacity: 0 } : { opacity: 0, x: 28 };
  const affected = item.routes.filter((id) => routes[id]);

  return (
    <motion.section
      initial={from}
      animate={{ opacity: 1, x: 0 }}
      exit={from}
      transition={PUSH}
      aria-labelledby={titleId}
      className="absolute inset-0 flex flex-col bg-background"
    >
      <div className="flex h-14 shrink-0 items-center border-b border-border pl-2.5 pr-14">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-9 items-center gap-0.5 rounded-lg pl-1.5 pr-3 text-[13px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ChevronLeft aria-hidden className="h-[18px] w-[18px]" />
          Hírek
        </button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <article className="mx-auto max-w-[65ch] px-5 pb-[calc(2.5rem+env(safe-area-inset-bottom))] pt-5">
          <p className="text-[12px] font-medium text-muted-foreground">
            {publishedLabel(item.modifiedAt)}
            {item.type ? <span className="ml-2 rounded-md border border-border px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-[0.06em]">{item.type}</span> : null}
          </p>
          <h2 ref={heading} id={titleId} tabIndex={-1} className="mt-2 text-balance text-[20px] font-bold leading-[1.25] tracking-[-0.012em] text-foreground focus:outline-none">
            {item.title}
          </h2>

          {affected.length ? (
            <div className="mt-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Érintett járatok</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {affected.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onShowRoute(id)}
                    title="Csak ez a járat a térképen"
                    aria-label={`${routes[id].short}: csak ez a járat a térképen`}
                    className="rounded-md transition-transform duration-fast hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-95"
                  >
                    <RouteTile short={routes[id].short} color={routes[id].color} text={routes[id].text} />
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11.5px] text-muted-foreground">Koppints egy járatra: csak az marad a térképen.</p>
            </div>
          ) : null}

          <div className="mt-5 border-t border-border/70 pt-5">
            <NewsBody blocks={item.blocks} routes={routes} />
          </div>
        </article>
      </div>
    </motion.section>
  );
}
