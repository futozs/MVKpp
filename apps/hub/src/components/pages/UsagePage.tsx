"use client";
import Link from "next/link";
import { useState } from "react";
import { isErr } from "@/lib/api";
import { ago, num, pct, shortDay } from "@/lib/format";
import { useHub, useNow } from "@/lib/hooks";
import type { Maybe } from "@/lib/types";
import { Bars, RankList, TimeChart } from "../charts/charts";
import { PageHeader } from "../shell/Shell";
import { ErrorNote, Loading, Panel, Pill, Segmented, Stat } from "../ui/primitives";

type Named = { id: string; n: number; name: string };
type Usage = {
  days: number;
  favDays: number;
  summary: {
    totals: { devices: number; today: number; week: number; month: number; standalone: number; linked: number; withFavorites: number } | null;
    platforms: { key: string; n: number }[];
    browsers: { key: string; n: number }[];
    views: { key: string; n: number; devices: number }[];
    recentDevices: { deviceId: string; platform: string | null; browser: string | null; standalone: boolean; lang: string | null; screen: string | null; firstSeen: string; lastSeen: string; opens: number; email: string | null; userId: string | null; activeDays: number; favoriteCount: number }[];
  };
  series: { day: string; dau: number; wau: number; mau: number; fresh: number; returning: number }[];
  favorites: Maybe<{
    lines: { routeId: string; dir: string; n: number; short: string; long: string; color: string; text: string }[];
    stops: Named[];
    statStops: Named[];
    vehicles: { id: string; n: number }[];
    parking: Named[];
    kiosk: Named[];
  }>;
  live: Maybe<{ clients: number; signedIn: number; devices: number; topics: Record<string, number>; topStops: { stopId: string; name: string; watchers: number }[] }>;
};

const VIEW_LABEL: Record<string, string> = { map: "Térkép", multistop: "Figyelő", timetable: "Menetrend", parking: "Parkoló", planner: "Útvonaltervező", stats: "Statisztika", kiosk: "Kijelző" };
const PLATFORM_LABEL: Record<string, string> = { ios: "iPhone / iPad", android: "Android", macos: "Mac", windows: "Windows", linux: "Linux", other: "egyéb" };
const TOPIC_LABEL: Record<string, string> = { vehicles: "térkép (járművek)", stop: "megállófigyelés", trip: "menetkövetés", parking: "parkoló", runs: "menetrend-napló", sync: "felhős szinkron" };

function RouteBadge({ short, color, text }: { short: string; color: string; text: string }) {
  return (
    <span className="inline-flex h-5 min-w-[28px] shrink-0 items-center justify-center rounded-md px-1.5 text-[11px] font-extrabold" style={{ background: `#${color}`, color: `#${text}` }}>
      {short}
    </span>
  );
}

function Favorites({ f }: { f: Exclude<Usage["favorites"], { error: string }> }) {
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 2xl:grid-cols-3">
      <Panel title="Kedvenc vonalak" hint="Menetrend → csillag (irányonként)">
        <RankList
          items={f.lines.map((l) => ({ key: `${l.routeId}|${l.dir}`, label: l.long ? `${l.long}${l.dir ? ` · ${l.dir === "0" ? "oda" : "vissza"}` : ""}` : l.routeId, value: l.n, swatch: <RouteBadge short={l.short} color={l.color} text={l.text} /> }))}
          format={(v) => `${v} eszköz`}
        />
      </Panel>
      <Panel title="Figyelt megállók" hint="a Figyelő megállói">
        <RankList items={f.stops.map((s) => ({ key: s.id, label: s.name, value: s.n }))} format={(v) => `${v} eszköz`} />
      </Panel>
      <Panel title="Kedvenc járművek" hint="Statisztika → Járművek">
        <RankList items={f.vehicles.map((v) => ({ key: v.id, label: <span className="font-mono">{v.id}</span>, value: v.n }))} format={(v) => `${v} eszköz`} />
      </Panel>
      <Panel title="Kedvenc parkolók" hint="végállomások és kocsiszínek">
        <RankList items={f.parking.map((p) => ({ key: p.id, label: p.name, value: p.n }))} format={(v) => `${v} eszköz`} />
      </Panel>
      <Panel title="Statisztika-kedvenc megállók">
        <RankList items={f.statStops.map((s) => ({ key: s.id, label: s.name, value: s.n }))} format={(v) => `${v} eszköz`} />
      </Panel>
      <Panel title="Kijelzők megállói" hint="/kijelzo beállításai">
        <RankList items={f.kiosk.map((s) => ({ key: s.id, label: s.name, value: s.n }))} format={(v) => `${v} eszköz`} />
      </Panel>
    </div>
  );
}

export function UsagePage() {
  const [days, setDays] = useState(30);
  const [favDays, setFavDays] = useState(60);
  const { data, error, isLoading } = useHub<Usage>(`/api/usage?days=${days}&favDays=${favDays}`, 30_000);
  const now = useNow(10_000);
  if (isLoading) return <Loading />;
  if (!data) return <ErrorNote error={error} />;
  const t = data.summary.totals;
  const live = isErr(data.live) ? null : data.live;
  const xs = (d: string) => Date.parse(`${d}T12:00:00`);

  return (
    <>
      <PageHeader
        title="Használat"
        lead="Ki és hogyan használja a webappot: aktív eszközök, visszatérők, platformok, nézetek — és mit tesznek kedvencnek. Névtelen: véletlen eszközazonosító, IP-cím nélkül; bejelentkezve a fiókhoz kötve."
        actions={<Segmented value={days} onChange={setDays} options={[{ value: 14, label: "14 nap" }, { value: 30, label: "30 nap" }, { value: 90, label: "90 nap" }]} />}
      />

      <Panel className="mb-5">
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4 xl:grid-cols-7">
          <Stat label="fent most" value={live ? num(live.clients) : "–"} sub={live ? `${live.signedIn} bejelentkezve` : "WebSocket"} tone={live && live.clients > 0 ? "ok" : undefined} />
          <Stat label="ma" value={num(t?.today)} sub="eszköz" />
          <Stat label="7 nap" value={num(t?.week)} sub="eszköz" />
          <Stat label="30 nap" value={num(t?.month)} sub="eszköz" />
          <Stat label="összes eszköz" value={num(t?.devices)} sub={`${num(t?.withFavorites)} kedvencekkel`} />
          <Stat label="telepített app" value={t?.month ? pct((t.standalone / t.month) * 100) : "–"} sub="főképernyőről (30 nap)" />
          <Stat label="fiókhoz kötve" value={num(t?.linked)} sub="eszköz" />
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Panel title="Aktív eszközök" hint="napi / 7 napos / 30 napos egyedi eszköz" className="xl:col-span-2">
          <TimeChart
            series={[
              { id: "dau", label: "napi", points: data.series.map((s) => [xs(s.day), s.dau]) },
              { id: "wau", label: "7 napos", points: data.series.map((s) => [xs(s.day), s.wau]) },
              { id: "mau", label: "30 napos", points: data.series.map((s) => [xs(s.day), s.mau]) },
            ]}
            height={220}
            xFormat={(x) => shortDay(new Date(x).toISOString().slice(0, 10))}
          />
        </Panel>
        <Panel title="Most élőben" hint="WebSocket-feliratkozások témánként">
          {live ? (
            <>
              <RankList items={Object.entries(live.topics).map(([k, v]) => ({ key: k, label: TOPIC_LABEL[k] ?? k, value: v }))} empty="Most senki sincs fent." />
              {live.topStops.length ? (
                <>
                  <div className="mb-2 mt-5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">legnézettebb megállók most</div>
                  <RankList items={live.topStops.map((s) => ({ key: s.stopId, label: s.name, value: s.watchers }))} max={6} />
                </>
              ) : null}
            </>
          ) : (
            <ErrorNote error={data.live} />
          )}
        </Panel>
        <Panel title="Új eszközök naponta" className="xl:col-span-2">
          <Bars data={data.series.map((s) => ({ key: s.day, label: shortDay(s.day), value: s.fresh }))} />
        </Panel>
        <Panel title="Nézetek (30 nap)" hint="megnyitások · eszközök">
          <RankList items={data.summary.views.map((v) => ({ key: v.key, label: `${VIEW_LABEL[v.key] ?? v.key} · ${v.devices} eszköz`, value: v.n }))} format={num} />
        </Panel>
        <Panel title="Platform (30 nap)">
          <RankList items={data.summary.platforms.map((p) => ({ key: p.key, label: PLATFORM_LABEL[p.key] ?? p.key, value: p.n }))} />
        </Panel>
        <Panel title="Böngésző (30 nap)">
          <RankList items={data.summary.browsers.map((p) => ({ key: p.key, label: p.key, value: p.n }))} />
        </Panel>
        <Panel title="Visszatérők ma" hint="aki ma használta, és nem ma látta először">
          <div className="grid grid-cols-2 gap-4">
            <Stat label="visszatérő" value={num(data.series.at(-1)?.returning)} />
            <Stat label="új" value={num(data.series.at(-1)?.fresh)} />
          </div>
        </Panel>
      </div>

      <div className="mb-3 mt-8 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold tracking-tight">Mit tesznek kedvencnek?</h2>
        <Segmented value={favDays} onChange={setFavDays} options={[{ value: 7, label: "7 nap" }, { value: 60, label: "60 nap" }, { value: 365, label: "1 év" }]} />
      </div>
      {isErr(data.favorites) ? <ErrorNote error={data.favorites} /> : <Favorites f={data.favorites} />}

      <Panel title="Eszközök" hint="a 200 legutóbb aktív" className="mt-8">
        <div className="-mx-4 overflow-x-auto sm:-mx-5">
          <table className="w-full min-w-[820px] text-[12.5px]">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                <th className="px-4 py-2 font-medium sm:px-5">eszköz</th>
                <th className="px-2 py-2 font-medium">platform</th>
                <th className="px-2 py-2 font-medium">fiók</th>
                <th className="px-2 py-2 text-right font-medium">aktív nap</th>
                <th className="px-2 py-2 text-right font-medium">megnyitás</th>
                <th className="px-2 py-2 text-right font-medium">kedvenc</th>
                <th className="px-2 py-2 font-medium">először</th>
                <th className="px-4 py-2 font-medium sm:px-5">utoljára</th>
              </tr>
            </thead>
            <tbody>
              {data.summary.recentDevices.map((d) => (
                <tr key={d.deviceId} className="border-b border-border/60 last:border-0 hover:bg-accent/30">
                  <td className="px-4 py-2 font-mono text-muted-foreground sm:px-5">{d.deviceId.slice(0, 8)}</td>
                  <td className="px-2 py-2">
                    {PLATFORM_LABEL[d.platform ?? "other"] ?? d.platform} <span className="text-muted-foreground">· {d.browser}</span> {d.standalone ? <Pill tone="info">app</Pill> : null}
                  </td>
                  <td className="px-2 py-2">{d.userId ? <Link className="text-primary hover:underline" href={`/felhasznalok/${d.userId}`}>{d.email}</Link> : <span className="text-muted-foreground">–</span>}</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums">{num(d.activeDays)}</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums">{num(d.opens)}</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums">{num(d.favoriteCount)}</td>
                  <td className="px-2 py-2 text-muted-foreground">{ago(d.firstSeen, now)}</td>
                  <td className="px-4 py-2 text-muted-foreground sm:px-5">{ago(d.lastSeen, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
