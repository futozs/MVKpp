"use client";
import { RefreshCw } from "lucide-react";
import { isErr } from "@/lib/api";
import { ago, date, dateTime, duration, ms, num, pct, shortDay } from "@/lib/format";
import { useAction, useHub, useNow } from "@/lib/hooks";
import type { Maybe } from "@/lib/types";
import { Bars } from "../charts/charts";
import { PageHeader } from "../shell/Shell";
import { Button, Empty, ErrorNote, KeyValue, Loading, Panel, Pill, Stat } from "../ui/primitives";

type Switch = { at: string; to: "mvk" | "otp2"; reason: string | null };
type Build = { iso: string; at: string; ok: boolean; result: string; ms: number; counts?: Record<string, number> };
type ClientStats = { ok: number; fail: number; limited: number; lastOkAt: number; lastError: string | null; lastMs: number; queued: number };

/** a worker /system/sources válasza */
type Live = {
  mvk: { state: "mvk" | "otp2"; since: string; reason: string | null; fallbackSecToday: number; switches: Switch[]; poll: { ok: number; fail: number; lastOkAt: number; lastError: string | null; lastMs: number; vehiclesMax: number } };
  snapshot: { source: string | null; rtError: string | null; vehicles: number; regionalAt: number | null };
  shadow: { samples: number; lagP50: number | null; lagP95: number | null; coverage: number | null };
  regional: {
    feeds: { enabled: boolean; patterns: number | null; loaded: { iso: string; version: string; trips: number }[]; building: string[]; lastBuild: Build | null };
    builds: Build[];
    realtime: {
      enabled: boolean;
      regional: boolean;
      fallback: boolean;
      at: string | null;
      error: string | null;
      vehicles: number;
      mvkVehicles: number;
      hotStations: number;
      cancelled: number;
      alerts: number;
      client: ClientStats;
    };
  };
};

/** a hub saját lekérdezése (gtfs_feed, source_health) */
type Data = {
  feeds: { id: number; version: string; serviceDate: string; fetchedAt: string; stops: number; routes: number; trips: number; status: string; validation: string; zipBytes: number }[];
  health: { day: string; source: string; ok: number; fail: number; vehiclesMax: number; lagP50: number | null; lagP95: number | null; coverage: number | null; fallbackS: number }[];
};

type SourcesData = { live: Maybe<Live>; data: Maybe<Data> };

const SOURCE_LABEL = { mvk: "MVK (natív)", otp2: "MÁV+ (tartalék)" } as const;

/** Az árnyék-összevetés: a MÁV+ mennyivel később látja ugyanazt az MVK-jelet, és a járművek hány százalékát. */
function ShadowPanel({ live }: { live: Live }) {
  const s = live.shadow;
  return (
    <Panel
      title="Árnyék-összevetés (MVK ↔ MÁV+)"
      hint="Amíg az MVK a forrás, a MÁV+ ugyanazon járműveit is lekérjük: mennyivel később látja ugyanazt a GPS-jelet, és a járművek hány százalékát látja. Ebből tudjuk, mennyire jó a tartalék."
    >
      {s.samples ? (
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
          <Stat label="lefedettség" value={s.coverage != null ? pct(s.coverage * 100) : "–"} sub="a natív járművekből a MÁV+-ban is látszik" tone={s.coverage != null && s.coverage < 0.8 ? "warn" : "ok"} />
          <Stat label="késés (medián)" value={s.lagP50 != null ? `${num(s.lagP50)} mp` : "–"} sub="a MÁV+ jele a natívhoz képest" />
          <Stat label="késés (95%)" value={s.lagP95 != null ? `${num(s.lagP95)} mp` : "–"} tone={s.lagP95 != null && s.lagP95 > 60 ? "warn" : undefined} />
          <Stat label="minták ma" value={num(s.samples)} />
        </div>
      ) : (
        <Empty>{live.mvk.state === "otp2" ? "A tartalék fut — most nincs natív jel, amihez mérhetnénk." : "Még nincs összevethető minta ebben a futásban."}</Empty>
      )}
    </Panel>
  );
}

function BuildsPanel({ live, data, busy, onBuild }: { live: Live; data: Data | null; busy: boolean; onBuild: () => void }) {
  const f = live.regional.feeds;
  const building = f.building.length > 0;
  return (
    <Panel
      title="Regionális menetrend (Volán, vasút)"
      hint="A worker naponta kétszer (3:20, 15:20) a MÁV+-ból építi a következő napok menetrendjét a megyére (a megyét érintő járatok teljes útvonallal). Egy nap építése pár perc, a MÁV+ terhelési korlátja miatt sorban."
      action={
        <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} busy={busy} disabled={building || !f.enabled} onClick={onBuild}>
          {building ? `Épül: ${f.building.join(", ")}` : "Újraépítés"}
        </Button>
      }
    >
      {!f.enabled ? (
        <Empty>A regionális integráció ki van kapcsolva (OTP2_ENABLED=0 vagy REGIONAL=0).</Empty>
      ) : (
        <>
          <KeyValue
            className="mb-4 max-w-xl"
            rows={[
              ["betöltött napok", f.loaded.length ? f.loaded.map((x) => `${x.iso} (${num(x.trips)} menet)`).join(", ") : "–"],
              ["mintázatok", f.patterns != null ? num(f.patterns) : "– (még nem futott felderítés)"],
              ["utolsó építés", f.lastBuild ? `${dateTime(f.lastBuild.at)} · ${f.lastBuild.iso} · ${f.lastBuild.ok ? "rendben" : "hiba"} · ${ms(f.lastBuild.ms)}` : "–"],
            ]}
          />
          {live.regional.builds.some((b) => !b.ok) ? <ErrorNote className="mb-4" error={live.regional.builds.find((b) => !b.ok)!.result} /> : null}
          {data?.feeds.length ? (
            <div className="-mx-4 overflow-x-auto sm:-mx-5">
              <table className="w-full min-w-[640px] text-[12.5px]">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                    <th className="px-4 py-2 font-medium sm:px-5">nap</th>
                    <th className="px-2 py-2 font-medium">verzió</th>
                    <th className="px-2 py-2 font-medium">építve</th>
                    <th className="px-2 py-2 text-right font-medium">megálló / vonal / menet</th>
                    <th className="px-4 py-2 text-right font-medium sm:px-5">állapot</th>
                  </tr>
                </thead>
                <tbody>
                  {data.feeds.map((x) => (
                    <tr key={x.id} className="border-b border-border/60 last:border-0" title={x.validation}>
                      <td className="px-4 py-2 sm:px-5">{date(x.serviceDate)}</td>
                      <td className="px-2 py-2 font-mono">{x.version}</td>
                      <td className="px-2 py-2 text-muted-foreground">{dateTime(x.fetchedAt)}</td>
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
          ) : (
            <Empty>Még nem épült regionális menetrend.</Empty>
          )}
        </>
      )}
    </Panel>
  );
}

export function SourcesPage() {
  const { data, error, isLoading } = useHub<SourcesData>("/api/sources", 10_000);
  const now = useNow(1000);
  const { busy, run } = useAction();
  if (isLoading) return <Loading />;
  if (!data) return <ErrorNote error={error} />;
  const live = isErr(data.live) ? null : data.live;
  const d = isErr(data.data) ? null : data.data;
  const rt = live?.regional.realtime;
  const c = rt?.client;
  const fallbackDays = (d?.health ?? []).filter((h) => h.source === "otp2-mvk");
  const regionalDays = (d?.health ?? []).filter((h) => h.source === "otp2");

  return (
    <>
      <PageHeader
        title="Adatforrások"
        lead="Az MVK saját feedje az elsődleges. Ha a token hiányzik vagy elutasított (401/403), azonnal; ha az MVK egy percig nem válaszol, a MÁV+ (OTP2) adja az MVK járműveit — 5 sikeres MVK-lekérés után visszaváltunk. A Volán és a vasút mindig a MÁV+-ból jön."
      />
      {live ? (
        <>
          <Panel className="mb-5">
            <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-3 xl:grid-cols-6">
              <Stat
                label="az MVK forrása"
                value={SOURCE_LABEL[live.mvk.state]}
                sub={`${ago(live.mvk.since, now)} óta${live.mvk.reason ? ` · ${live.mvk.reason}` : ""}`}
                tone={live.mvk.state === "mvk" ? "ok" : "warn"}
              />
              <Stat label="tartalékon ma" value={duration(live.mvk.fallbackSecToday)} tone={live.mvk.fallbackSecToday > 0 ? "warn" : undefined} />
              <Stat label="járművek most" value={num(live.snapshot.vehicles)} sub={rt ? `ebből Volán + vasút ${num(rt.vehicles)}` : undefined} />
              <Stat
                label="MÁV+ utolsó sikeres"
                value={c?.lastOkAt ? `${Math.round((now - c.lastOkAt) / 1000)} mp` : "–"}
                sub={c?.lastOkAt ? ms(c.lastMs) : "ebben a futásban még nem volt"}
                tone={!c?.lastOkAt ? "warn" : now - c.lastOkAt > 120_000 ? "crit" : "ok"}
              />
              <Stat label="MÁV+ hívások" value={c ? `${num(c.ok)} / ${num(c.fail)}` : "–"} sub="sikeres / hibás" tone={c && c.fail > 0 ? "warn" : undefined} />
              <Stat label="terhelési korlát" value={c ? num(c.limited) : "–"} sub={c?.queued ? `${num(c.queued)} kérés sorban` : "„host limit” válaszok"} tone={c && c.limited > 0 ? "warn" : undefined} />
            </div>
            {rt?.error || c?.lastError ? <ErrorNote className="mt-4" error={`MÁV+: ${rt?.error ?? c?.lastError}`} /> : null}
            {live.snapshot.rtError ? <ErrorNote className="mt-4" error={`MVK GTFS-RT: ${live.snapshot.rtError}`} /> : null}
          </Panel>

          <div className="space-y-5">
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
              <ShadowPanel live={live} />
              <Panel title="Átváltások" hint="A legutóbbi forrásváltások ebben a futásban, újabb elöl.">
                {live.mvk.switches.length ? (
                  <ul className="divide-y divide-border/60 text-[12.5px]">
                    {live.mvk.switches.map((s) => (
                      <li key={s.at} className="flex items-center gap-3 py-2">
                        <Pill tone={s.to === "mvk" ? "ok" : "warn"}>{s.to === "mvk" ? "vissza az MVK-ra" : "MÁV+ tartalék"}</Pill>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{s.reason ?? ""}</span>
                        <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">{dateTime(s.at)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>Ebben a futásban nem volt átváltás.</Empty>
                )}
              </Panel>
            </div>

            {rt ? (
              <Panel title="Volán és vasút élőben" hint="A MÁV+ járműpozíciói, a figyelt állomások táblái (vágány, késés), a MÁV közleményei és a lemondott menetek.">
                <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-5">
                  <Stat label="járművek" value={num(rt.vehicles)} sub={rt.at ? `frissítve ${ago(rt.at, now)}` : undefined} />
                  <Stat label="MVK a MÁV+-ban" value={num(rt.mvkVehicles)} sub="a tartalékhoz" />
                  <Stat label="figyelt állomás" value={num(rt.hotStations)} sub="valaki épp nézi a tábláját" />
                  <Stat label="közlemény" value={num(rt.alerts)} sub="késésok, kocsiosztály, pótlás" />
                  <Stat label="lemondott menet" value={num(rt.cancelled)} tone={rt.cancelled > 0 ? "warn" : undefined} />
                </div>
              </Panel>
            ) : null}

            <BuildsPanel
              live={live}
              data={d}
              busy={busy === "build"}
              onBuild={() => void run("build", "/api/sources/regional-build", {}, { success: "A regionális menetrend építése elindult (pár perc napi)", refresh: ["/api/sources"] })}
            />

            {d ? (
              <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                <Panel title="Tartalékon töltött idő naponta" hint="source_health — 30 nap, percben">
                  <Bars data={fallbackDays.map((h) => ({ key: h.day, label: shortDay(h.day), value: Math.round(h.fallbackS / 60) }))} color="hsl(var(--nosignal))" yFormat={(v) => `${num(v)} p`} />
                </Panel>
                <Panel title="Volán + vasút járműmaximum" hint="egyszerre látott regionális járművek csúcsa naponta">
                  <Bars data={regionalDays.map((h) => ({ key: h.day, label: shortDay(h.day), value: h.vehiclesMax }))} yFormat={(v) => num(v)} />
                </Panel>
              </div>
            ) : (
              <ErrorNote error={data.data} />
            )}
          </div>
        </>
      ) : (
        <ErrorNote error={data.live} />
      )}
    </>
  );
}
