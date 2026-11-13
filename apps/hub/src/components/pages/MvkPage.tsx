"use client";
import { FileDown, Play, RefreshCw } from "lucide-react";
import { useState } from "react";
import { isErr, post } from "@/lib/api";
import { ago, bytes, date, dateTime, ms, num, shortDay } from "@/lib/format";
import { useAction, useHub, useNow } from "@/lib/hooks";
import type { Maybe, WorkerMetrics } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Bars } from "../charts/charts";
import { PageHeader } from "../shell/Shell";
import { Button, ErrorNote, Input, KeyValue, Loading, Panel, Pill, Segmented, Stat } from "../ui/primitives";
import { RouteTable } from "./RouteTable";

type Feeds = {
  health: { day: string; ok: number; fail: number; pings: number; vehiclesMax: number }[];
  feeds: { id: number; version: string; fetchedAt: string; startDate: string | null; endDate: string | null; stops: number; routes: number; trips: number; status: string; validation: string; zipBytes: number }[];
};
type MvkData = { metrics: Maybe<WorkerMetrics>; feeds: Maybe<Feeds> };
type CallResult = { status: number; ms: number; contentType: string | null; bytes: number; body: unknown; text: string | null; truncated: boolean };

const PRESETS = [
  { label: "pozíciók", method: "GET", path: "/api/v1/gtfs/get-positions" },
  { label: "előrejelzések", method: "GET", path: "/api/v1/gtfs/get-updates" },
  { label: "törölt menetek", method: "GET", path: "/api/v1/gtfs/list-cancelled-trips" },
  { label: "paraméterek", method: "GET", path: "/api/v1/parameter/list" },
  { label: "időjárás", method: "GET", path: "/api/v1/weather/latest" },
] as const;

function Inspector() {
  const [method, setMethod] = useState<"GET" | "POST">("GET");
  const [path, setPath] = useState<string>(PRESETS[0].path);
  const [body, setBody] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CallResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await post<CallResult>("/api/mvk/call", { method, path, body: method === "POST" ? body : undefined }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const shown = result ? (result.body != null ? JSON.stringify(result.body, null, 2) : (result.text ?? "")) : "";
  return (
    <Panel title="API-vizsgáló" hint="Bármely MVK-végpont a szerver tokenjével. A GTFS-RT protobufot olvasható JSON-ná fejti (az első 25 elem). Minden hívás naplózva.">
      <div className="mb-3 flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.path}
            onClick={() => {
              setMethod(p.method);
              setPath(p.path);
            }}
            className={cn("rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors", path === p.path ? "border-signal-700 bg-accent text-foreground" : "border-border text-muted-foreground hover:text-foreground")}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Segmented value={method} onChange={setMethod} options={[{ value: "GET", label: "GET" }, { value: "POST", label: "POST" }]} />
        <Input value={path} onChange={(e) => setPath(e.target.value)} className="min-w-[240px] flex-1 font-mono" spellCheck={false} onKeyDown={(e) => e.key === "Enter" && void send()} />
        <Button variant="primary" icon={<Play className="h-3.5 w-3.5" />} busy={busy} onClick={() => void send()}>
          Küldés
        </Button>
      </div>
      {method === "POST" ? <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} spellCheck={false} className="mt-2 w-full rounded-xl border border-input bg-background/60 p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" /> : null}
      {error ? <ErrorNote error={error} className="mt-3" /> : null}
      {result ? (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            <Pill tone={result.status >= 400 || result.status === 0 ? "crit" : "ok"}>HTTP {result.status}</Pill>
            <span className="font-mono text-muted-foreground">{ms(result.ms)}</span>
            <span className="font-mono text-muted-foreground">{bytes(result.bytes)}</span>
            <span className="font-mono text-muted-foreground">{result.contentType ?? ""}</span>
            {result.truncated ? <Pill tone="warn">levágva 1 MB-nál</Pill> : null}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              icon={<FileDown className="h-3.5 w-3.5" />}
              onClick={() => {
                const url = URL.createObjectURL(new Blob([shown], { type: "application/json" }));
                const a = Object.assign(document.createElement("a"), { href: url, download: `mvk${path.replace(/\W+/g, "-")}.json` });
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Letöltés
            </Button>
          </div>
          <pre className="max-h-[480px] overflow-auto rounded-xl border border-border bg-background/70 p-3 font-mono text-[11.5px] leading-relaxed text-muted-foreground">{shown.slice(0, 200_000)}</pre>
        </div>
      ) : null}
    </Panel>
  );
}

export function MvkPage() {
  const { data, error, isLoading } = useHub<MvkData>("/api/mvk", 10_000);
  const now = useNow(1000);
  const { busy, run } = useAction();
  if (isLoading) return <Loading />;
  if (!data) return <ErrorNote error={error} />;
  const m = isErr(data.metrics) ? null : data.metrics;
  const f = isErr(data.feeds) ? null : data.feeds;
  const p = m?.poll;
  const total = p ? p.ok + p.fail : 0;

  return (
    <>
      <PageHeader
        title="MVK API"
        lead="Az MVK valós idejű feedje és menetrendje: lekérések, hibák, válaszidők végpontonként, napi feed-egészség, GTFS-verziók  és egy vizsgáló, amivel bármely végpontot kipróbálhatsz."
        actions={
          <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} busy={busy === "gtfs"} onClick={() => void run("gtfs", "/api/mvk/reload-gtfs", {}, { success: "GTFS ellenőrizve / újratöltve", refresh: ["/api/mvk"] })}>
            GTFS újratöltése
          </Button>
        }
      />
      {m && p ? (
        <Panel className="mb-5">
          <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="utolsó sikeres" value={p.lastOkAt ? `${Math.round((now - p.lastOkAt) / 1000)} mp` : "–"} sub={p.lastOkAt ? ago(p.lastOkAt, now) : "ebben a futásban még nem volt"} tone={!p.lastOkAt ? "warn" : now - p.lastOkAt > 60_000 ? "crit" : "ok"} />
            <Stat label="lekérés ideje" value={ms(p.lastMs)} sub="pozíció + előrejelzés" />
            <Stat label="ma sikeres" value={num(p.ok)} sub={total ? `${((p.ok / total) * 100).toFixed(2)}%` : "–"} />
            <Stat label="ma hibás" value={num(p.fail)} tone={p.fail > 0 ? "warn" : undefined} sub={p.lastError ?? "nincs hiba"} />
            <Stat label="járművek" value={num(p.vehicles)} sub={`ma max ${num(p.vehiclesMax)}`} />
            <Stat label="eltárolt jel" value={num(p.pingsKept)} sub="ma (GPS-pont)" />
          </div>
          {p.rtError ? <ErrorNote className="mt-4" error={`GTFS-RT: ${p.rtError}`} /> : null}
        </Panel>
      ) : (
        <ErrorNote className="mb-5" error={data.metrics} />
      )}

      <div className="space-y-5">
        <Panel title="Végpontok (utolsó óra)" hint="Minden hívás, amit a worker az MVK felé indít  a proxyn átmenőket is.">
          {m ? <RouteTable rows={m.upstream} windowMin={60} /> : null}
        </Panel>

        {f ? (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Panel title="Napi hibás lekérések" hint="feed_health  45 nap">
              <Bars data={f.health.map((d) => ({ key: d.day, label: shortDay(d.day), value: d.fail }))} color="hsl(var(--late))" yFormat={(v) => num(v)} />
            </Panel>
            <Panel title="Napi járműmaximum" hint="egyszerre kint lévő járművek csúcsa">
              <Bars data={f.health.map((d) => ({ key: d.day, label: shortDay(d.day), value: d.vehiclesMax }))} yFormat={(v) => num(v)} />
            </Panel>
          </div>
        ) : (
          <ErrorNote error={data.feeds} />
        )}

        {m ? (
          <Panel title="Menetrend (GTFS)">
            <KeyValue
              className="mb-4 max-w-xl"
              rows={[
                ["élő verzió", m.gtfs.feedVersion ?? "–"],
                ["mai nap", m.gtfs.today ? `${m.gtfs.today.feedVersion}${m.gtfs.today.fallback ? " (tartalék!)" : ""}` : "–"],
                ["betöltve", m.gtfs.loaded.join(", ") || "–"],
              ]}
            />
            {f?.feeds.length ? (
              <div className="-mx-4 overflow-x-auto sm:-mx-5">
                <table className="w-full min-w-[640px] text-[12.5px]">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                      <th className="px-4 py-2 font-medium sm:px-5">verzió</th>
                      <th className="px-2 py-2 font-medium">letöltve</th>
                      <th className="px-2 py-2 font-medium">érvényes</th>
                      <th className="px-2 py-2 text-right font-medium">megálló / vonal / menet</th>
                      <th className="px-4 py-2 text-right font-medium sm:px-5">állapot</th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.feeds.map((x) => (
                      <tr key={x.id} className="border-b border-border/60 last:border-0" title={x.validation}>
                        <td className="px-4 py-2 font-mono sm:px-5">{x.version}</td>
                        <td className="px-2 py-2 text-muted-foreground">{dateTime(x.fetchedAt)}</td>
                        <td className="px-2 py-2 text-muted-foreground">
                          {date(x.startDate)} – {date(x.endDate)}
                        </td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums">
                          {num(x.stops)} / {num(x.routes)} / {num(x.trips)}
                        </td>
                        <td className="px-4 py-2 text-right sm:px-5">
                          <Pill tone={x.status === "ok" ? "ok" : "crit"}>{x.status === "ok" ? "rendben" : "elutasítva"}</Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </Panel>
        ) : null}

        <Inspector />
      </div>
    </>
  );
}
