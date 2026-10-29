import { useCallback, useState } from "react";
import { statsV3, type NetworkHour } from "@/services/statsApi";
import { BarChart, ChartFrame, RankBars, StatTile } from "@/components/charts/Charts";
import { QueryBoundary, PillPicker } from "./PanelState";
import { useStatsQuery } from "./useStatsQuery";

const DAYTYPES = [
  { id: "0", label: "Munkanap" },
  { id: "1", label: "Szombat" },
  { id: "2", label: "Vasárnap, ünnep" },
] as const;

const PERIODS = [
  { id: "30", label: "30 nap" },
  { id: "60", label: "60 nap" },
  { id: "120", label: "120 nap" },
] as const;

const WINDOWS = [
  { id: "am", label: "Reggeli csúcs", sub: "6–9", from: 6, to: 9 },
  { id: "mid", label: "Napközben", sub: "9–14", from: 9, to: 14 },
  { id: "pm", label: "Délutáni csúcs", sub: "14–18", from: 14, to: 18 },
  { id: "eve", label: "Este", sub: "18–23", from: 18, to: 23 },
] as const;

const fmtMin = (s: number | null | undefined) => (s == null ? "—" : `${s >= 0 ? "+" : "−"}${(Math.abs(s) / 60).toFixed(1)} p`);

function avgOver(hours: NetworkHour[], from: number, to: number) {
  const sel = hours.filter((h) => h.hour >= from && h.hour < to && h.avg_delay_s != null);
  const n = sel.reduce((a, h) => a + h.n, 0);
  if (!n) return null;
  return {
    delay: Math.round(sel.reduce((a, h) => a + (h.avg_delay_s ?? 0) * h.n, 0) / n),
    otp: Math.round(sel.reduce((a, h) => a + (h.otp_pct ?? 0) * h.n, 0) / n),
    n,
  };
}

/**
 * Hálózat — mikor és hol késnek a járatok.
 * Az adat a megálló-eseményekből jön (minden busz, minden megálló, ahol
 * láttuk), naptípus szerint átlagolva. A v2 itt egy soha le nem futó
 * éjszakai összesítőből olvasott, ezért volt üres a reggeli és az esti csúcs.
 */
export function NetworkPanel() {
  const [daytype, setDaytype] = useState<(typeof DAYTYPES)[number]["id"]>("0");
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["id"]>("30");
  const [win, setWin] = useState<(typeof WINDOWS)[number]["id"]>("am");
  const w = WINDOWS.find((x) => x.id === win)!;

  const q = useStatsQuery(
    useCallback(() => statsV3.network(Number(daytype), Number(period), w.from, w.to), [daytype, period, w.from, w.to]),
    [daytype, period, w.from, w.to],
  );

  const dayLabel = DAYTYPES.find((d) => d.id === daytype)!.label.toLowerCase();

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-lg font-bold tracking-tight sm:text-xl">Hálózat</h2>
        <div className="flex flex-wrap gap-2">
          <PillPicker ariaLabel="Naptípus" value={daytype} onChange={(v) => setDaytype(v as typeof daytype)} items={DAYTYPES.map((d) => ({ id: d.id, label: d.label }))} />
          <PillPicker ariaLabel="Időszak" value={period} onChange={(v) => setPeriod(v as typeof period)} items={PERIODS.map((p) => ({ id: p.id, label: p.label }))} />
        </div>
      </div>

      <QueryBoundary query={q} empty={(d) => d.hourly.length === 0}>
        {(d) => {
          const am = avgOver(d.hourly, 6, 9);
          const pm = avgOver(d.hourly, 14, 18);
          const worst = [...d.hourly].filter((h) => h.n >= 50 && h.hour >= 5 && h.hour <= 23).sort((a, b) => (b.avg_delay_s ?? 0) - (a.avg_delay_s ?? 0))[0];
          const totalN = d.hourly.reduce((a, h) => a + h.n, 0);
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
                <StatTile label="Reggeli csúcs (6–9)" value={fmtMin(am?.delay)} sub={am ? `${am.otp}% pontos érkezés` : "nincs adat"} tone="late" />
                <StatTile label="Délutáni csúcs (14–18)" value={fmtMin(pm?.delay)} sub={pm ? `${pm.otp}% pontos érkezés` : "nincs adat"} tone="late" />
                <StatTile label="Legrosszabb óra" value={worst ? `${worst.hour % 24}:00–${(worst.hour % 24) + 1}:00` : "—"} sub={worst ? `átlag ${fmtMin(worst.avg_delay_s)}` : undefined} />
                <StatTile label="Mérések" value={totalN.toLocaleString("hu-HU")} sub={`megálló-érkezés, ${d.days} nap ${dayLabel}jai`} />
              </div>

              <ChartFrame
                title="Átlagos késés a nap folyamán"
                hint={`Megállónkénti érkezés a menetrendhez képest, az elmúlt ${d.days} nap ${dayLabel}jain. Pontos = 1 perc sietés és 5 perc késés között.`}
              >
                <BarChart
                  unit="p"
                  data={d.hourly
                    .filter((h) => h.hour >= 4 && h.hour <= 24)
                    .map((h) => ({
                      label: `${h.hour % 24}`,
                      value: h.avg_delay_s == null ? null : Math.round(h.avg_delay_s / 6) / 10,
                      tone: (h.avg_delay_s ?? 0) > 180 ? "late" : (h.avg_delay_s ?? 0) < -30 ? "early" : "ontime",
                      title: `${h.hour % 24}:00–${(h.hour % 24) + 1}:00 · átlag ${fmtMin(h.avg_delay_s)} · ${h.otp_pct ?? "—"}% pontos · 85%-ban legfeljebb ${fmtMin(h.p85_delay_s)} · ${h.n} mérés`,
                    }))}
                  labelEvery={2}
                />
              </ChartFrame>

              <div className="space-y-2">
                <PillPicker ariaLabel="Napszak" value={win} onChange={(v) => setWin(v as typeof win)} items={WINDOWS.map((x) => ({ id: x.id, label: x.label, sub: x.sub }))} />
                <ChartFrame
                  title="Hol lassul be a forgalom"
                  hint={`${w.label} (${w.sub} óra) · megállóközök, ahol a buszok a menetrendnél a legtöbbet lassabbak (medián menetidő − menetrendi idő)`}
                >
                  {d.slow.length ? (
                    <RankBars
                      rows={d.slow.slice(0, 15).map((s) => ({
                        label: `${s.from_name} → ${s.to_name}`,
                        sub: `terv ${Math.round(s.sched_s / 6) / 10} p · tény ${Math.round(s.p50_s / 6) / 10} p (85%: ${Math.round(s.p85_s / 6) / 10} p) · ${s.n} áthaladás`,
                        value: Math.max(0, s.excess_s),
                        display: `+${Math.round(s.excess_s / 6) / 10} p${s.excess_pct != null ? ` (${s.excess_pct}%)` : ""}`,
                      }))}
                    />
                  ) : (
                    <p className="py-6 text-center text-sm text-muted-foreground">Ebben a napszakban még kevés a mérés.</p>
                  )}
                </ChartFrame>
              </div>
            </div>
          );
        }}
      </QueryBoundary>
    </div>
  );
}
