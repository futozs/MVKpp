import {
  AlertTriangle,
  DatabaseZap,
  Loader2,
  Search,
  Star,
  X,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { normalizeSearchText } from "@/lib/utils";
import type { QueryState } from "./useStatsQuery";

export function QueryBoundary<T>({
  query,
  children,
  empty,
}: {
  query: QueryState<T>;
  children: (data: T) => ReactNode;
  empty?: (data: T) => boolean;
}) {
  if (query.unavailable) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border bg-card/50 px-6 py-10 text-center">
        <DatabaseZap className="h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-semibold">Az adatraktár nem érhető el</p>
        <p className="font-mono text-xs text-muted-foreground">
          npm run db:migrate
        </p>
      </div>
    );
  }

  if (query.error) {
    return (
      <div className="flex items-start gap-2 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="min-w-0 break-words">{query.error}</span>
      </div>
    );
  }

  if (query.loading && !query.data) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl border border-border bg-card px-6 py-10 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Betöltés…
      </div>
    );
  }

  if (!query.data || (empty && empty(query.data))) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card/50 px-6 py-10 text-center">
        <p className="text-sm font-semibold">
          Erre az időszakra még nincs adat
        </p>
      </div>
    );
  }

  return <>{children(query.data)}</>;
}

export function PillPicker<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  isFavorite,
  onToggleFavorite,
}: {
  items: { id: T; label: string; sub?: string; color?: string | null }[];
  value: T | null;
  onChange: (id: T) => void;
  ariaLabel: string;
  /** Ha adott, minden pill mellett csillag jelenik meg kedvenc jelöléshez. */
  isFavorite?: (id: T) => boolean;
  onToggleFavorite?: (id: T) => void;
}) {
  return (
    <div
      className="overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="group"
      aria-label={ariaLabel}
    >
      <div className="flex min-w-max gap-1.5">
        {items.map((it) => {
          const active = it.id === value;
          const favorite = isFavorite?.(it.id) ?? false;
          return (
            <span
              key={it.id}
              className={[
                "flex items-center gap-1 rounded-lg border pl-2.5 pr-1.5 py-1.5 text-xs font-semibold transition-colors",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
              ].join(" ")}
            >
              <button
                type="button"
                onClick={() => onChange(it.id)}
                aria-pressed={active}
                className="flex items-center gap-1.5 focus-visible:outline-none"
              >
                {it.color ? (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: `#${it.color}` }}
                  />
                ) : null}
                <span className="tabular-nums">{it.label}</span>
                {it.sub ? (
                  <span className="max-w-[9rem] truncate opacity-60">
                    {it.sub}
                  </span>
                ) : null}
              </button>
              {onToggleFavorite ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleFavorite(it.id);
                  }}
                  aria-pressed={favorite}
                  aria-label={
                    favorite ? "Eltávolítás a kedvencekből" : "Kedvencnek jelölés"
                  }
                  className={[
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                    favorite ? "text-early" : "opacity-40 hover:opacity-100",
                  ].join(" ")}
                >
                  <Star
                    className="h-3.5 w-3.5"
                    fill={favorite ? "currentColor" : "none"}
                  />
                </button>
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Kereshető változat: sok száz jármű vagy vonal között a vízszintes
 * görgetés önmagában használhatatlan, ezért szűrőmező kerül elé. A találatok
 * ugyanabban a pill-sorban jelennek meg, így a megszokott kép nem változik.
 */
export function SearchablePicker<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  placeholder,
  limit = 120,
  isFavorite,
  onToggleFavorite,
}: {
  /** A `search` csak a szűréshez kell — a pillen nem jelenik meg. */
  items: {
    id: T;
    label: string;
    sub?: string;
    search?: string;
    color?: string | null;
  }[];
  value: T | null;
  onChange: (id: T) => void;
  ariaLabel: string;
  placeholder: string;
  limit?: number;
  /** Ha adott, minden pill mellett csillag jelenik meg kedvenc jelöléshez. */
  isFavorite?: (id: T) => boolean;
  onToggleFavorite?: (id: T) => void;
}) {
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const t = normalizeSearchText(q.trim());
    if (!t) return items.slice(0, limit);
    return items
      .filter(
        (it) =>
          normalizeSearchText(it.label).includes(t) ||
          normalizeSearchText(it.sub ?? "").includes(t) ||
          normalizeSearchText(it.search ?? "").includes(t),
      )
      .slice(0, limit);
  }, [items, q, limit]);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className="pl-9 pr-9"
        />
        {q ? (
          <button
            type="button"
            onClick={() => setQ("")}
            aria-label="Keresés törlése"
            className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {filtered.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">
          Nincs „{q}” találat.
        </p>
      ) : (
        <>
          <PillPicker
            ariaLabel={ariaLabel}
            value={value}
            onChange={onChange}
            items={filtered}
            isFavorite={isFavorite}
            onToggleFavorite={onToggleFavorite}
          />
          {items.length > filtered.length ? (
            <p className="px-1 text-[11px] text-muted-foreground">
              {filtered.length} látszik a(z) {items.length} elemből — szűkíts a
              kereséssel.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
