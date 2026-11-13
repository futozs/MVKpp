import { useCallback, useState } from "react";
import { statsV3, type RegionalStats } from "@/services/statsApi";
import { BarChart, ChartFrame, RankBars, StatTile } from "@/components/charts/Charts";
import { RouteTile } from "@/components/transit/RouteTile";
import { QueryBoundary, PillPicker } from "./PanelState";
import { useStatsQuery } from "./useStatsQuery";
import type { TransitMode } from "@/types";

const PERIODS = [
  { id: "7", label: "7 nap" },
  { id: "30", label: "30 nap" },
  { id: "90", label: "90 nap" },
] as const;

type Scope = "all" | "rail" | "coach";
const SCOPES: { id: Scope; label: string; modes: string }[] = [
  { id: "all", label: "Mind", modes: "coach,rail" },
  { id: "rail", label: "Vonat", modes: "rail" },
  { id: "coach", label: "Volán", modes: "coach" },
];

/** a nem késés-ok megjegyzések (kocsiösszeállítás, pótlóbusz) külön listában */
const KIND_LABEL: Record<string, string> = { composition: "kocsiösszeállítás", replacement: "pótlás", other: "közlemény" };

const fmtMin = (s: number | null | undefined) => (s == null ? "" : `${s >= 0 ? "+" : "−"}${(Math.abs(s) / 60).toFixed(1)} p`);
const hasRegionalData = (d: RegionalStats) => Boolean(d.summary?.n) || d.trains.length > 0 || d.causes.length > 0;

/** Vonatnál a kategória és a vonatszám („Sz 6612”), a Volánnál a vonal/menet („4001/748”). */
function trainLabel(t: RegionalStats["trains"][number]): string {
  return t.kind === "RAIL" && t.short_name ? `${t.short_name} ${t.name}` : t.name;
}

/**
 * Vasút és Volán  a MÁV+ adataiból mért pontosság a megyében: megállónkénti
 * érkezések, vonatonként a végállomáson mért késés, a MÁV által közölt késésokok
 * és a vágány-/kocsiállás-változások. Az MVK statisztikája a többi panelen marad.
 */
export function RegionalPanel({ modes }: { modes: TransitMode[] }) {
  const both = modes.includes("coach") && modes.includes("rail");
  const [scope, setScope] = useState<Scope>(both ? "all" : modes.includes("rail") ? "rail" : "coach");
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["id"]>("30");
  const active: Scope = both ? scope : modes.includes("rail") ? "rail" : "coach";
  const scopeModes = SCOPES.find((s) => s.id === active)!.modes;

  const q = useStatsQuery(
    useCallback(() => statsV3.regional(Number(period), scopeModes), [period, scopeModes]),
    [period, scopeModes],
  );

  const nouns = active === "coach" ? "járatok" : active === "rail" ? "vonatok" : "vonatok és járatok";

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-lg font-bold tracking-tight sm:text-xl">Vasút és Volán</h2>
        <div className="flex flex-wrap gap-2">
          {both ? <PillPicker ariaLabel="Mód" value={scope} onChange={(v) => setScope(v as Scope)} items={SCOPES.map((s) => ({ id: s.id, label: s.label }))} /> : null}
          <PillPicker ariaLabel="Időszak" value={period} onChange={(v) => setPeriod(v as typeof period)} items={PERIODS.map((p) => ({ id: p.id, label: p.label }))} />
        </div>
      </div>

      <QueryBoundary query={q} empty={(d) => !hasRegionalData(d)}>
        {(d) => {
          const s = d.summary;
          const causes = d.causes.filter((c) => c.kind === "cause");
          const other = d.causes.filter((c) => c.kind !== "cause");
          const worst = d.trains.filter((t) => t.avg_end_delay_s != null).slice(0, 15);
          const changed = d.platforms?.changed ?? 0;
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
                <StatTile label="Pontos érkezés" value={s?.ontime != null ? `${s.ontime}%` : ""} sub={s?.n ? `${s.n.toLocaleString("hu-HU")} megálló-érkezés` : "nincs adat"} tone="ontime" />
                <StatTile label="Átlagos késés" value={fmtMin(s?.avg_delay_s)} sub={s?.late != null ? `${s.late}% több mint 5 perccel késett` : undefined} tone="late" />
                <StatTile label="85%-ban legfeljebb" value={fmtMin(s?.p85_delay_s)} sub="a megállókban mért késés" />
                <StatTile
                  label="Vágány / kocsiállás"
                  value={d.platforms?.n ? `${changed} változás` : ""}
                  sub={d.platforms?.n ? `${d.platforms.n.toLocaleString("hu-HU")} figyelt indulásból` : "a figyelt állomásokon"}
                  tone={changed ? "late" : "default"}
                />
              </div>

              {d.daily.length > 1 ? (
                <ChartFrame title="Átlagos késés naponta" hint={`Megállónkénti érkezés a menetrendhez képest, az elmúlt ${d.days} nap. Pontos = 1 perc sietés és 5 perc késés között.`}>
                  <BarChart
                    unit="p"
                    data={d.daily.map((x) => ({
                      label: x.date.slice(5).replace("-", "."),
                      value: x.avg_delay_s == null ? null : Math.round(x.avg_delay_s / 6) / 10,
                      tone: (x.avg_delay_s ?? 0) > 180 ? "late" : (x.avg_delay_s ?? 0) < -30 ? "early" : "ontime",
                      title: `${x.date} · átlag ${fmtMin(x.avg_delay_s)} · ${x.ontime ?? ""}% pontos · ${x.n} mérés`,
                    }))}
                  />
                </ChartFrame>
              ) : null}

              <div className="grid gap-4 lg:grid-cols-2">
                <ChartFrame title={`Legtöbbet késő ${nouns}`} hint="A végállomáson (vagy a megye határán túli utolsó jelnél) mért átlagos késés; legalább két lefutott menet.">
                  {worst.length ? (
                    <RankBars
                      rows={worst.map((t) => ({
                        label: <RouteTile short={trainLabel(t)} color={t.color ?? "1E5AA8"} text={t.text_color ?? "FFFFFF"} size="sm" />,
                        sub: `${t.runs} menet · ${t.ontime_pct ?? ""}% pontos · 85%-ban legfeljebb ${fmtMin(t.p85_end_delay_s)}`,
                        value: Math.max(0, t.avg_end_delay_s ?? 0),
                        display: fmtMin(t.avg_end_delay_s),
                      }))}
                    />
                  ) : (
                    <p className="py-6 text-center text-sm text-muted-foreground">Ehhez még kevés a lefutott menet  pár nap múlva telik meg.</p>
                  )}
                </ChartFrame>

                <ChartFrame title="A késések okai" hint="A MÁV hivatalos megjegyzései a menetekhez: hány menetnél szerepelt az ok.">
                  {causes.length ? (
                    <RankBars rows={causes.slice(0, 12).map((c) => ({ label: c.text, value: c.n, display: `${c.n} menet` }))} />
                  ) : (
                    <p className="py-6 text-center text-sm text-muted-foreground">Ebben az időszakban nem volt közölt késésok.</p>
                  )}
                  {other.length ? (
                    <div className="mt-5 border-t border-border pt-4">
                      <p className="mb-3 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">Egyéb közlemények</p>
                      <RankBars
                        rows={other.slice(0, 6).map((c) => ({
                          label: c.text,
                          sub: KIND_LABEL[c.kind] ?? c.kind,
                          value: c.n,
                          display: `${c.n} menet`,
                          barClass: "bg-primary/60",
                        }))}
                      />
                    </div>
                  ) : null}
                </ChartFrame>
              </div>
            </div>
          );
        }}
      </QueryBoundary>
    </div>
  );
}
