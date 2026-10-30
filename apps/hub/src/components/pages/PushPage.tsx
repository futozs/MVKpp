"use client";
import { ago } from "@/lib/format";
import { useHub, useNow } from "@/lib/hooks";
import { RankList, StatusBar } from "../charts/charts";
import { PageHeader } from "../shell/Shell";
import { Empty, ErrorNote, Loading, Panel, Pill, Stat } from "../ui/primitives";

type Push = {
  subs: { total: number; enabled: number; failing: number; linked: number; deliveredWeek: number };
  byHost: { host: string; n: number }[];
  watches: { kind: string; n: number; stops: number }[];
  deliveries: { day: string; status: string; n: number }[];
  failures: { createdAt: string; kind: string; status: string; attempts: number; lastError: string | null; stopName: string; tripId: string }[];
  topStops: { name: string; id: string; n: number }[];
};

const KIND_LABEL: Record<string, string> = { arrival: "érkezik a busz", leave: "indulj most", traffic: "dugó előtte", transfer: "átszállás veszélyben" };
const STATUS = [
  { key: "sent", label: "kézbesítve", color: "hsl(var(--live))" },
  { key: "skipped", label: "kihagyva", color: "hsl(var(--depot))" },
  { key: "queued", label: "sorban", color: "hsl(var(--early))" },
  { key: "failed", label: "sikertelen", color: "hsl(var(--nosignal))" },
  { key: "gone", label: "megszűnt feliratkozás", color: "hsl(var(--late))" },
];

export function PushPage() {
  const { data, error, isLoading } = useHub<Push>("/api/push", 30_000);
  const now = useNow(30_000);
  if (isLoading) return <Loading />;
  if (!data) return <ErrorNote error={error} />;
  const totals = STATUS.map((s) => ({ ...s, value: data.deliveries.filter((d) => d.status === s.key).reduce((a, d) => a + d.n, 0) }));

  return (
    <>
      <PageHeader title="Push" lead="A web-push feliratkozások és figyelések, a kézbesítési napló (14 nap) és a hibák." />
      <Panel className="mb-5">
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-5">
          <Stat label="feliratkozás" value={data.subs.total} sub={`${data.subs.enabled} bekapcsolva`} />
          <Stat label="fiókhoz kötve" value={data.subs.linked} />
          <Stat label="kézbesített (7 nap)" value={data.subs.deliveredWeek} sub="feliratkozás" />
          <Stat label="hibázó" value={data.subs.failing} tone={data.subs.failing ? "warn" : undefined} />
          <Stat label="figyelés" value={data.watches.reduce((a, w) => a + w.n, 0)} sub={`${data.watches.length} fajta`} />
        </div>
      </Panel>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Panel title="Kézbesítések (14 nap)" className="xl:col-span-2">
          <StatusBar parts={totals} />
        </Panel>
        <Panel title="Szolgáltató">
          <RankList items={data.byHost.map((h) => ({ key: h.host, label: h.host, value: h.n }))} />
        </Panel>
        <Panel title="Figyelések fajta szerint">
          <RankList items={data.watches.map((w) => ({ key: w.kind, label: `${KIND_LABEL[w.kind] ?? w.kind} · ${w.stops} megálló`, value: w.n }))} />
        </Panel>
        <Panel title="Legfigyeltebb megállók" className="xl:col-span-2">
          <RankList items={data.topStops.map((s) => ({ key: s.id, label: s.name, value: s.n }))} />
        </Panel>
        <Panel title="Legutóbbi hibák" className="xl:col-span-3">
          {data.failures.length ? (
            <ul className="divide-y divide-border">
              {data.failures.map((f, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[12.5px]">
                  <Pill tone={f.status === "gone" ? "crit" : "warn"}>{f.status}</Pill>
                  <span className="font-semibold">{f.stopName}</span>
                  <span className="text-muted-foreground">{KIND_LABEL[f.kind] ?? f.kind}</span>
                  <span className="text-xs text-muted-foreground">{f.attempts}× próbálva</span>
                  <span className="ml-auto font-mono text-[11px] text-muted-foreground">{ago(f.createdAt, now)}</span>
                  {f.lastError ? <span className="w-full truncate text-xs text-late">{f.lastError}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nincs kézbesítési hiba.</Empty>
          )}
        </Panel>
      </div>
    </>
  );
}
