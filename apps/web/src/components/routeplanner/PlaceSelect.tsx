import { useId, useMemo, useState } from "react";
import { MapPin } from "lucide-react";
import type { Stop } from "@/types";
import { Input } from "@/components/ui/input";
import { normalizeSearchText } from "@/lib/utils";

const MAX_MATCHES = 7;

type Props = {
  label: string;
  places: Stop[];
  value: string;
  onChange: (id: string) => void;
};

/** Megálló választása név szerint (ékezet- és kisbetű-független keresés). */
export function PlaceSelect({ label, places, value, onChange }: Props) {
  const [text, setText] = useState("");
  const inputId = useId();
  const matches = useMemo(() => {
    const t = normalizeSearchText(text.trim());
    if (!t) return [];
    const starts: Stop[] = [];
    const contains: Stop[] = [];
    for (const s of places) {
      const n = normalizeSearchText(s.name);
      if (n.startsWith(t)) starts.push(s);
      else if (n.includes(t)) contains.push(s);
    }
    return [...starts, ...contains].slice(0, MAX_MATCHES);
  }, [text, places]);
  const selected = places.find((s) => s.id === value);

  const pick = (id: string) => {
    onChange(id);
    setText("");
  };

  return (
    <div className="min-w-0 space-y-1.5">
      <label
        htmlFor={inputId}
        className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
      >
        {label}
      </label>
      {selected ? (
        <button
          id={inputId}
          type="button"
          onClick={() => pick("")}
          className="flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-primary/60 bg-primary/10 px-3 text-left text-sm font-semibold transition-colors duration-fast hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="flex min-w-0 items-center gap-2">
            <MapPin aria-hidden className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate">{selected.name}</span>
          </span>
          <span className="shrink-0 text-[11px] font-normal text-muted-foreground">módosít</span>
        </button>
      ) : (
        <>
          <Input
            id={inputId}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches[0]) {
                e.preventDefault();
                pick(matches[0].id);
              }
            }}
            placeholder="Megálló neve…"
            autoComplete="off"
            className="h-10"
          />
          {matches.length ? (
            <ul className="max-h-56 overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-md">
              {matches.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => pick(s.id)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  >
                    <MapPin aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{s.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : text.trim() ? (
            <p className="px-1 text-[11px] text-muted-foreground">Nincs ilyen nevű megálló.</p>
          ) : null}
        </>
      )}
    </div>
  );
}
