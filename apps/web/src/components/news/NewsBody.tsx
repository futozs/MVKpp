import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import type { NewsBlock, NewsListItem, NewsRoute, NewsRun } from "@mvk/core";
import { safeHex } from "@/components/map/vehicleIcon";
import { cn } from "@/lib/utils";
import { prettyUrl } from "./newsTime";

/**
 * Egy MVK-hír törzse a worker által előkészített blokkokból (core/news.ts) 
 * innerHTML nélkül, így az MVK szövegéből semmi sem futhat le. A szövegben
 * említett járat a saját színével jelenik meg, a menetrendi kivonat
 * („Végállomásról: 08:10, 09:15 …”) táblázatszerű kártyán.
 */

type Routes = Record<string, NewsRoute>;
type Kind = NewsBlock["kind"];

/** csupa időpont: „15:20, 16:20, 17:20” */
const TIMES_RE = /^\d{1,2}:\d{2}(?:,\s*\d{1,2}:\d{2})+$/;

const plain = (runs: NewsRun[]) => runs.map((r) => r.text).join("");

/** Járatjelzés a szövegben: a menetrendi színekkel, a sor magasságához igazítva. */
export function RouteMark({ text, route }: { text: string; route: NewsRoute | undefined }) {
  if (!route) return <>{text}</>;
  return (
    <span
      className="mx-px inline-flex h-[1.42em] min-w-[1.7em] items-center justify-center rounded-[0.32em] px-[0.32em] align-[-0.24em] text-[0.8em] font-extrabold leading-none tabular-nums tracking-tight ring-1 ring-inset ring-black/20"
      style={{ backgroundColor: `#${safeHex(route.color, "1FB574")}`, color: `#${safeHex(route.text, "FFFFFF")}` }}
    >
      {text}
    </span>
  );
}

function Run({ run, routes }: { run: NewsRun; routes: Routes }) {
  let node: ReactNode = run.route ? <RouteMark text={run.text} route={routes[run.route]} /> : run.text;
  if (run.href) {
    node = (
      <a
        href={run.href}
        target="_blank"
        rel="noopener noreferrer"
        title={run.href}
        className="font-medium text-primary underline decoration-primary/35 decoration-1 underline-offset-[3px] transition-colors hover:decoration-primary focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {run.text === run.href ? prettyUrl(run.href) : node}
        <ArrowUpRight aria-hidden className="ml-0.5 inline h-[0.9em] w-[0.9em] align-[-0.08em]" />
      </a>
    );
  }
  if (run.bold) node = <strong className="font-semibold text-foreground">{node}</strong>;
  if (run.italic) node = <em>{node}</em>;
  return <>{node}</>;
}

export function Runs({ runs, routes }: { runs: NewsRun[]; routes: Routes }) {
  // a blokkok tartalma sosem rendeződik át, a sorszám stabil kulcs
  return runs.map((r, i) => <Run key={i} run={r} routes={routes} />);
}

function ItemBody({ runs, routes }: { runs: NewsRun[]; routes: Routes }) {
  const text = plain(runs).trim();
  if (TIMES_RE.test(text)) {
    return (
      <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[13px] tabular-nums text-foreground">
        {text.split(/,\s*/).map((t, i) => (
          <span key={i}>{t}</span>
        ))}
      </p>
    );
  }
  return (
    <p className="mt-0.5 text-[14px] leading-relaxed">
      <Runs runs={runs} routes={routes} />
    </p>
  );
}

function NewsList({ items, routes }: { items: NewsListItem[]; routes: Routes }) {
  // „Végállomásról: időpontok” sorok: címke fölül, tartalom alatta, egy kártyán
  if (items.every((it) => it.lead)) {
    return (
      <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/80 bg-card/70">
        {items.map((it, i) => (
          <li key={i} className="px-3.5 py-2.5">
            <p className="text-[12.5px] font-semibold leading-snug text-foreground">
              <Runs runs={it.lead!} routes={routes} />
            </p>
            <ItemBody runs={it.runs} routes={routes} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="relative pl-4 before:absolute before:left-[3px] before:top-[0.68em] before:h-[5px] before:w-[5px] before:rounded-full before:bg-muted-foreground/60">
          {it.lead ? (
            <>
              <span className="font-semibold text-foreground">
                <Runs runs={it.lead} routes={routes} />
              </span>
              {": "}
            </>
          ) : null}
          <Runs runs={it.runs} routes={routes} />
        </li>
      ))}
    </ul>
  );
}

/** A blokkok közti térköz: az alcím elválaszt, a címke a tartalmához tapad. */
function gap(prev: Kind | undefined, cur: Kind): string {
  if (!prev) return "";
  if (cur === "h") return "mt-7";
  if (prev === "h" || prev === "label") return cur === "label" ? "mt-3" : "mt-2";
  return cur === "label" ? "mt-5" : "mt-3.5";
}

export function NewsBody({ blocks, routes }: { blocks: NewsBlock[]; routes: Routes }) {
  return (
    <div className="text-[14.5px] leading-[1.65] text-foreground/85">
      {blocks.map((b, i) => {
        const cls = gap(blocks[i - 1]?.kind, b.kind);
        if (b.kind === "list") {
          return (
            <div key={i} className={cls}>
              <NewsList items={b.items} routes={routes} />
            </div>
          );
        }
        if (b.kind === "h") {
          return (
            <h3 key={i} className={cn(cls, "text-[15px] font-bold leading-snug tracking-[-0.005em] text-foreground")}>
              <Runs runs={b.runs} routes={routes} />
            </h3>
          );
        }
        return (
          <p key={i} className={cn(cls, "whitespace-pre-line", b.kind === "label" && "text-[13.5px] font-semibold leading-snug text-foreground")}>
            <Runs runs={b.runs} routes={routes} />
          </p>
        );
      })}
    </div>
  );
}
