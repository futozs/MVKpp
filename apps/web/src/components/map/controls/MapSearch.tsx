import { useEffect, useMemo, useRef, useState } from "react";
import { Bus, MapPin, Plus, Search, Star, X } from "lucide-react";
import type { LiveVehicle, Stop } from "@/types";
import { RouteTile } from "@/components/transit/RouteTile";
import { api } from "@/services/api";
import { distanceKm, formatDistance } from "@/lib/geo";
import { cn, normalizeSearchText } from "@/lib/utils";
import { MapControl } from "./MapControl";
import { displayVehicleId, isRegionalId, pickableStops, regionRank, vehicleModeOf } from "@/lib/modes";
import { stopKindLabel } from "@/components/transit/RegionalBits";

const MAX_STOPS = 40;
const MAX_VEHICLES = 8;
const NEAR_KM = 0.6;

type StopGroup = { name: string; group: Stop[]; lat: number; lon: number; km: number | null };

const compact = (t: string) => t.replace(/[\s-]/g, "").toUpperCase();

/**
 * Egy jármű illik-e a kereséshez: az MVK-é a rendszám számjegyeire (mint eddig), a
 * Volán-buszé a rendszámára (betűkkel is), a vonaté a vonatszámára.
 */
function vehicleMatches(v: LiveVehicle, raw: string, digits: string | null): boolean {
  const mode = vehicleModeOf(v);
  if (mode === "rail") return Boolean(digits && digits.length >= 2 && v.trainNo?.startsWith(digits));
  if (mode === "coach") {
    const qv = compact(raw);
    return qv.length >= 2 && /^[A-Z0-9]+$/.test(qv) && compact(displayVehicleId(v.id, v.plate)).includes(qv);
  }
  return Boolean(digits && v.id.includes(digits));
}

/** a megálló sora alatt: az MVK-é a táblán látható kód, a regionálisé a fajtája (Vasútállomás…) */
const stopSub = (s: Stop) => (isRegionalId(s.id) ? stopKindLabel(s) : `kód ${s.id.replace(/^SP/i, "")}`);

/** a találat sorában: a vonat a vonatszámával, a Volán-busz a rendszámával */
const vehicleTitle = (v: LiveVehicle) => (vehicleModeOf(v) === "rail" && v.trainNo ? `${v.trainNo}${v.trainName ? ` ${v.trainName}` : ""}` : displayVehicleId(v.id, v.plate));

/**
 * Keresés (bal alsó sarok): megálló neve vagy a táblán látható kódja, és
 * jármű rendszáma  egy mezőben. Üresen a közeli megállókat mutatja.
 */
export function MapSearch({
  stops,
  vehicles,
  position,
  monitoredStopIds,
  watched,
  onToggleMonitorStop,
  onPickStop,
  onPickPlace,
  onPickVehicle,
  onToggleWatch,
  onOpenChange,
}: {
  stops: Stop[];
  vehicles: LiveVehicle[];
  position: { lat: number; lon: number } | null;
  monitoredStopIds: string[];
  watched: string[];
  onToggleMonitorStop: (id: string) => void;
  onPickStop: (stop: Stop) => void;
  /** több kocsiállásos hely: oda közelítünk, a pöttyöt a felhasználó választja */
  onPickPlace: (lat: number, lon: number) => void;
  onPickVehicle: (v: LiveVehicle) => void;
  onToggleWatch: (vehicleId: string) => void;
  /** nyitáskor a szülő a többi vezérlő fölé emeli a sarkot */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    onOpenChange?.(v);
  };
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => input.current?.focus());
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const close = () => {
    setOpen(false);
    setQ("");
    setError(null);
  };

  const term = normalizeSearchText(q.trim());
  const digits = /^\d+$/.test(q.trim()) ? q.trim() : null;

  // Kódra pontos egyezés: a táblán csak a szám áll, a GTFS-azonosító „SP” + kód.
  const byCode = useMemo(() => (digits ? (stops.find((s) => s.id.toLowerCase() === `sp${digits}`) ?? null) : null), [digits, stops]);

  // az állomás a vágányaival egy tétel (a vágányok külön nem kellenek a keresőben)
  const pickable = useMemo(() => pickableStops(stops), [stops]);
  const groups = useMemo((): StopGroup[] => {
    const source = term
      ? pickable.filter((s) => normalizeSearchText(s.name).includes(term) || (s.code && normalizeSearchText(s.code) === term))
      : position
        ? pickable.filter((s) => distanceKm(position.lat, position.lon, s.lat, s.lon) <= NEAR_KM)
        : [];
    const byName = new Map<string, Stop[]>();
    for (const s of source) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
    const out = [...byName.entries()].map(([name, group]) => {
      const lat = group.reduce((a, s) => a + s.lat, 0) / group.length;
      const lon = group.reduce((a, s) => a + s.lon, 0) / group.length;
      return { name, group, lat, lon, km: position ? distanceKm(position.lat, position.lon, lat, lon) : null };
    });
    out.sort((a, b) => (term ? regionRank(a.group[0]) - regionRank(b.group[0]) || a.name.localeCompare(b.name, "hu") : (a.km ?? 0) - (b.km ?? 0)));
    return out.slice(0, MAX_STOPS);
  }, [pickable, term, position]);

  const raw = q.trim();
  const vehicleHits = useMemo(
    () => (raw.length >= 1 ? vehicles.filter((v) => vehicleMatches(v, raw, digits)).sort((a, b) => a.id.length - b.id.length).slice(0, MAX_VEHICLES) : []),
    [raw, digits, vehicles],
  );

  // Kód, ami nincs a betöltött listában: a szerver még ismerheti.
  const lookupCode = async () => {
    if (!digits || byCode) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.getArrivals(`SP${digits}`, 1);
      const s = res.stop;
      if (s?.lat != null && s?.lon != null) {
        onPickStop({ id: s.id, code: s.code ?? digits, name: s.name ?? `SP${digits}`, lat: s.lat, lon: s.lon });
        close();
      } else setError(`Nincs ${digits} kódú megálló.`);
    } catch {
      setError(`Nincs ${digits} kódú megálló.`);
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (byCode) {
      onPickStop(byCode);
      close();
    } else if (vehicleHits.length === 1) {
      onPickVehicle(vehicleHits[0]);
      close();
    } else if (groups.length === 1) {
      pickGroup(groups[0]);
    } else void lookupCode();
  };

  const pickGroup = (g: StopGroup) => {
    if (g.group.length === 1) onPickStop(g.group[0]);
    else onPickPlace(g.lat, g.lon);
    close();
  };

  const empty = term && !byCode && !groups.length && !vehicleHits.length;

  return (
    <>
      <MapControl icon={Search} label="Keresés" showLabel="wide" active={open} aria-expanded={open} aria-haspopup="dialog" onClick={() => (open ? close() : setOpen(true))} />
      {open ? (
        <div className="pointer-events-auto fixed inset-0 z-drawer flex flex-col justify-end sm:absolute sm:inset-auto sm:bottom-[56px] sm:left-0 sm:block">
          <button type="button" aria-label="Keresés bezárása" onClick={close} className="absolute inset-0 bg-background/60 backdrop-blur-[2px] sm:hidden" />
          <div
            role="dialog"
            aria-label="Keresés a térképen"
            className={cn(
              "relative flex max-h-[72dvh] flex-col overflow-hidden rounded-t-2xl border border-border bg-card shadow-2xl",
              "pb-[env(safe-area-inset-bottom)] sm:max-h-[min(70dvh,520px)] sm:w-[360px] sm:rounded-2xl sm:pb-0",
              "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-4",
            )}
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
              className="flex shrink-0 items-center gap-2 border-b border-border p-2.5"
            >
              <div className="relative min-w-0 flex-1">
                <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={input}
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setError(null);
                  }}
                  enterKeyHint="search"
                  autoComplete="off"
                  placeholder="Megálló, kód, rendszám vagy vonatszám"
                  aria-label="Megálló neve, megállókód, rendszám vagy vonatszám"
                  className="h-11 w-full rounded-xl border border-input bg-background pl-9 pr-3 text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />
              </div>
              <button type="button" onClick={close} aria-label="Bezárás" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-accent hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </form>

            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {error ? (
                <p role="alert" className="mx-3 my-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </p>
              ) : null}

              {byCode ? (
                <Section title="Megállókód">
                  <StopRow
                    name={byCode.name}
                    sub={`${digits}. számú megálló`}
                    watched={monitoredStopIds.includes(byCode.id)}
                    onPick={() => {
                      onPickStop(byCode);
                      close();
                    }}
                    onToggleWatch={() => onToggleMonitorStop(byCode.id)}
                  />
                </Section>
              ) : null}

              {vehicleHits.length ? (
                <Section title="Járművek">
                  {vehicleHits.map((v) => {
                    const on = watched.includes(v.id);
                    return (
                      <li key={v.id} className="flex items-center gap-1 pr-2">
                        <button
                          type="button"
                          onClick={() => {
                            onPickVehicle(v);
                            close();
                          }}
                          className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left hover:bg-accent"
                        >
                          <RouteTile short={v.routeShort} color={v.routeColor} text={v.routeText} />
                          <span className="min-w-0">
                            <span className="block font-mono text-sm font-bold tabular-nums">{vehicleTitle(v)}</span>
                            <span className="block truncate text-[11.5px] text-muted-foreground">{v.headsign}</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onToggleWatch(v.id)}
                          aria-pressed={on}
                          aria-label={on ? `${vehicleTitle(v)} kiemelésének levétele` : `${vehicleTitle(v)} kiemelése a térképen`}
                          title={on ? "Kiemelés levétele" : "Kiemelés a térképen"}
                          className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg hover:bg-accent", on ? "text-primary" : "text-muted-foreground")}
                        >
                          <Star className={cn("h-4 w-4", on && "fill-current")} />
                        </button>
                      </li>
                    );
                  })}
                </Section>
              ) : null}

              {groups.length ? (
                <Section title={term ? "Megállók" : "A közeledben"}>
                  {groups.map((g) => {
                    const single = g.group.length === 1 ? g.group[0] : null;
                    return (
                      <StopRow
                        key={g.name}
                        name={g.name}
                        multi={!single}
                        sub={[single ? stopSub(single) : `${g.group.length} kocsiállás`, g.km != null ? formatDistance(g.km) : null].filter(Boolean).join(" · ")}
                        watched={single ? monitoredStopIds.includes(single.id) : undefined}
                        onPick={() => pickGroup(g)}
                        onToggleWatch={single ? () => onToggleMonitorStop(single.id) : undefined}
                      />
                    );
                  })}
                </Section>
              ) : null}

              {empty ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {busy ? "Keresés…" : digits ? `Nincs ilyen rendszámú jármű vagy ${digits} kódú megálló a listában  Enterrel a szervertől is megkérdezem.` : `Nincs „${q.trim()}” nevű megálló.`}
                </p>
              ) : null}

              {!term && !groups.length ? (
                <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">
                  Írd be a megálló nevét, a táblán látható kódját, egy busz rendszámát vagy egy vonat számát.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="py-1">
      <h3 className="px-4 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <ul>{children}</ul>
    </section>
  );
}

function StopRow({ name, sub, multi, watched, onPick, onToggleWatch }: { name: string; sub: string; multi?: boolean; watched?: boolean; onPick: () => void; onToggleWatch?: () => void }) {
  return (
    <li className="flex items-center gap-1 pr-2">
      <button type="button" onClick={onPick} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left hover:bg-accent">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          {multi ? <MapPin className="h-4 w-4" /> : <Bus className="h-4 w-4" />}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] font-semibold">{name}</span>
          <span className="block truncate font-mono text-[11px] tabular-nums text-muted-foreground">{sub}</span>
        </span>
      </button>
      {onToggleWatch ? (
        <button
          type="button"
          onClick={onToggleWatch}
          aria-pressed={watched}
          aria-label={watched ? `${name} levétele a figyelőről` : `${name} felvétele a figyelőre`}
          title={watched ? "Levétel a figyelőről" : "Felvétel a figyelőre"}
          className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg hover:bg-accent", watched ? "text-primary" : "text-muted-foreground")}
        >
          <Plus className={cn("h-4 w-4 transition-transform", watched && "rotate-45")} />
        </button>
      ) : null}
    </li>
  );
}
