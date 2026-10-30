"use client";
import { XOctagon } from "lucide-react";
import { useState } from "react";
import { isErr } from "@/lib/api";
import { bytes, num, pct, shortDay } from "@/lib/format";
import { useAction, useHub } from "@/lib/hooks";
import type { Disk, Maybe } from "@/lib/types";
import { Bars, RankList } from "../charts/charts";
import { PageHeader } from "../shell/Shell";
import { ConfirmDialog } from "../ui/dialog";
import { Button, Empty, ErrorNote, KeyValue, Loading, Meter, Panel, Pill, Stat } from "../ui/primitives";

type Table = { name: string; kind: "hypertable" | "table" | "view"; totalBytes: number; tableBytes: number; indexBytes: number; rows: number; chunks: number | null; compressedBefore: number | null; compressedAfter: number | null };
type Db = {
  name: string;
  bytes: number;
  version: string | null;
  cacheHitPct: number | null;
  stats: { commits: number; rollbacks: number; deadlocks: number; temp_bytes: number; started: string | null } | null;
  connections: { total: number; max: number; byApp: { app: string; state: string; n: number }[] };
  extensions: { name: string; version: string }[];
  tables: Table[];
  growth: { day: string; bytes: number }[];
  volumes: Maybe<{ volumes: { name: string; sizeMb: number }[] }> | null;
  disk: Disk;
};
type Query = { pid: number; app: string; state: string; wait: string | null; seconds: number; query: string; client: string | null };

const TABLE_HINT: Record<string, string> = {
  veh_ping: "nyers GPS-jelek (örökre)",
  stop_event: "megállói érkezés / indulás",
  segment_run: "szakaszidők",
  trip_run: "menetek naplója",
  gtfs_feed: "menetrend-zipek",
  usage_day: "napi használat",
  hub_probe: "hub-mérések",
  user_state: "felhős szinkron",
};

function Queries() {
  const { data } = useHub<{ queries: Query[] }>("/api/db/queries", 5_000);
  const { run } = useAction();
  const [kill, setKill] = useState<Query | null>(null);
  if (!data) return <Loading />;
  if (!data.queries.length) return <Empty>Most nem fut lekérdezés.</Empty>;
  return (
    <>
      <ul className="divide-y divide-border">
        {data.queries.map((q) => (
          <li key={q.pid} className="py-2.5">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono text-muted-foreground">pid {q.pid}</span>
              <Pill tone={q.seconds > 30 ? "warn" : "idle"}>{q.seconds} mp</Pill>
              <span className="text-muted-foreground">{q.app || "?"} · {q.state}</span>
              {q.wait ? <span className="text-nosignal">vár: {q.wait}</span> : null}
              <Button size="sm" variant="ghost" className="ml-auto" icon={<XOctagon className="h-3.5 w-3.5" />} onClick={() => setKill(q)}>
                megszakít
              </Button>
            </div>
            <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/60 p-2 font-mono text-[11px] text-muted-foreground">{q.query}</pre>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={kill != null}
        onOpenChange={(o) => !o && setKill(null)}
        title={`Lekérdezés megszakítása (pid ${kill?.pid})`}
        description="A lekérdezés hibával áll le; a kapcsolat megmarad. A worker legközelebb újrapróbálja, amit kell."
        confirmLabel="Megszakítás"
        onConfirm={() => kill && run("cancel", `/api/db/queries/${kill.pid}/cancel`, { terminate: false }, { success: "megszakítva", refresh: ["/api/db/queries"] })}
      />
    </>
  );
}

export function DbPage() {
  const { data, error, isLoading } = useHub<Db>("/api/db", 60_000);
  if (isLoading) return <Loading />;
  if (!data) return <ErrorNote error={error} />;
  const hyper = data.tables.filter((t) => t.kind === "hypertable");
  const compressedSaved = hyper.reduce((a, t) => a + Math.max(0, (t.compressedBefore ?? 0) - (t.compressedAfter ?? 0)), 0);
  const avgDaily = data.growth.length > 1 ? data.growth.slice(0, -1).reduce((a, g) => a + g.bytes, 0) / (data.growth.length - 1) : null;
  const volume = data.volumes && !isErr(data.volumes) ? data.volumes.volumes.find((v) => /db/.test(v.name)) : null;

  return (
    <>
      <PageHeader title="Adatbázis" lead="Postgres + TimescaleDB: méret táblánként (a hypertable-ök darabjaival és tömörítésével), napi növekedés, kapcsolatok és a most futó lekérdezések." />
      <Panel className="mb-5">
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="méret" value={bytes(data.bytes)} sub={`${data.name} · PostgreSQL ${data.version ?? "?"}`} />
          <Stat label="kötet a lemezen" value={volume ? bytes(volume.sizeMb * 1048576) : "–"} sub={volume?.name ?? "Docker nélkül nem látszik"} />
          <Stat label="napi növekedés" value={avgDaily ? bytes(avgDaily) : "–"} sub="GPS-tábla, átlag" />
          <Stat label="tömörítés megtakarított" value={bytes(compressedSaved)} sub="hypertable-ök" tone={compressedSaved > 0 ? "ok" : undefined} />
          <Stat label="cache-találat" value={pct(data.cacheHitPct)} sub="99% fölött jó" tone={data.cacheHitPct != null && data.cacheHitPct < 95 ? "warn" : undefined} />
          <Stat label="kapcsolatok" value={`${data.connections.total} / ${data.connections.max}`} tone={data.connections.total > data.connections.max * 0.8 ? "warn" : undefined} />
        </div>
        {data.disk ? (
          <div className="mt-5 max-w-xl">
            <div className="mb-1 flex justify-between gap-3 text-xs text-muted-foreground">
              <span className="truncate" title={data.disk.path}>
                lemez · {data.disk.usedPct}% foglalt
              </span>
              <span className="shrink-0 font-mono">
                {data.disk.freeGb} GB szabad / {data.disk.totalGb} GB
              </span>
            </div>
            <Meter value={data.disk.usedPct} tone={data.disk.usedPct >= 90 ? "crit" : data.disk.usedPct >= 80 ? "warn" : "ok"} label="lemez" />
          </div>
        ) : null}
      </Panel>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Panel title="Táblák" hint="teljes méret (adat + index + TOAST)" className="xl:col-span-2">
          <div className="-mx-4 overflow-x-auto sm:-mx-5">
            <table className="w-full min-w-[640px] text-[12.5px]">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                  <th className="px-4 py-2 font-medium sm:px-5">tábla</th>
                  <th className="px-2 py-2 text-right font-medium">méret</th>
                  <th className="px-2 py-2 text-right font-medium">index</th>
                  <th className="px-2 py-2 text-right font-medium">sor (becsült)</th>
                  <th className="px-4 py-2 text-right font-medium sm:px-5">tömörítés</th>
                </tr>
              </thead>
              <tbody>
                {data.tables.slice(0, 30).map((t) => (
                  <tr key={t.name} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-2 sm:px-5">
                      <span className="font-mono">{t.name}</span>
                      {t.kind === "hypertable" ? <Pill className="ml-2" tone="info">{t.chunks} darab</Pill> : t.kind === "view" ? <Pill className="ml-2">nézet</Pill> : null}
                      {TABLE_HINT[t.name] ? <div className="text-[11px] text-muted-foreground">{TABLE_HINT[t.name]}</div> : null}
                    </td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">{bytes(t.totalBytes)}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums text-muted-foreground">{bytes(t.indexBytes)}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">{num(t.rows)}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground sm:px-5">
                      {t.compressedBefore ? `${bytes(t.compressedBefore)} → ${bytes(t.compressedAfter)}` : "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <div className="space-y-5">
          <Panel title="Napi GPS-adat" hint="a veh_ping napi darabjainak mérete">
            <Bars data={data.growth.map((g) => ({ key: g.day, label: shortDay(g.day), value: g.bytes / 1048576 }))} yFormat={(v) => `${Math.round(v)} MB`} />
          </Panel>
          <Panel title="Kapcsolatok alkalmazásonként">
            <RankList items={data.connections.byApp.map((c) => ({ key: `${c.app}|${c.state}`, label: `${c.app} · ${c.state}`, value: c.n }))} />
          </Panel>
          <Panel title="Statisztika">
            <KeyValue
              rows={[
                ["commit / rollback", data.stats ? `${num(data.stats.commits)} / ${num(data.stats.rollbacks)}` : "–"],
                ["deadlock", num(data.stats?.deadlocks)],
                ["ideiglenes fájlok", bytes(data.stats?.temp_bytes)],
                ...data.extensions.map((e) => [e.name, e.version] as [string, string]),
              ]}
            />
          </Panel>
        </div>
        <Panel title="Most futó lekérdezések" hint="5 mp-enként frissül" className="xl:col-span-3">
          <Queries />
        </Panel>
      </div>
    </>
  );
}
