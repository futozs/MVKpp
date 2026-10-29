/**
 * „Milyen menetrend volt/lesz ezen a napon?” — a menetrendkönyvhöz és a
 * tervezőhöz. Sorrend: rögzített döntés (service_day) → v2-archívum
 * (legacy_schedule_day) → fallback a legfrissebb feedből.
 */
import { gunzipSync } from "node:zlib";
import { buildRouteIndex, buildTable, dayInfo, serviceClock, shiftIso, type DaySchedule, type ServiceDay } from "@mvk/core";
import { sql } from "@mvk/db";
import type { FeedManager } from "./feeds.ts";

export type ScheduleSource =
  | { kind: "feed"; day: ServiceDay; archived: boolean }
  | { kind: "legacy"; data: DaySchedule; archived: true; fallbackFrom: string | null };

const legacyCache = new Map<string, { data: DaySchedule; nTrips: number } | null>();

async function loadLegacy(iso: string) {
  if (legacyCache.has(iso)) return legacyCache.get(iso)!;
  const r = await sql<{ feed_version: string; n_trips: number; payload: Buffer }>(
    `SELECT feed_version, n_trips, payload FROM legacy_schedule_day WHERE service_date = $1`,
    [iso],
  );
  let out: { data: DaySchedule; nTrips: number } | null = null;
  if (r[0]) {
    const parsed = JSON.parse(gunzipSync(r[0].payload).toString("utf8")) as Omit<DaySchedule, "date" | "feedVersion">;
    out = { data: { date: iso.replace(/-/g, ""), feedVersion: r[0].feed_version, ...parsed }, nTrips: r[0].n_trips };
  }
  legacyCache.set(iso, out);
  if (legacyCache.size > 20) legacyCache.delete(legacyCache.keys().next().value!);
  return out;
}

export async function scheduleFor(feeds: FeedManager, iso: string): Promise<ScheduleSource | null> {
  const today = serviceClock().iso;
  if (iso >= today) {
    const day = await feeds.serviceDay(iso);
    return day ? { kind: "feed", day, archived: false } : null;
  }
  const rec = await sql<{ feed_id: number | null; n_trips: number }>(`SELECT feed_id, n_trips FROM service_day WHERE service_date = $1`, [iso]);
  if (rec[0]?.feed_id && rec[0].n_trips > 0) {
    const day = await feeds.serviceDay(iso);
    if (day) return { kind: "feed", day, archived: true };
  }
  const legacy = await loadLegacy(iso);
  if (legacy && legacy.nTrips > 0) return { kind: "legacy", data: legacy.data, archived: true, fallbackFrom: null };
  if (legacy) {
    // Az MVK üres menetrendet adott ki erre a napra (pl. 2026-10-27): a
    // legközelebbi korábbi, azonos naptípusú archivált nap menetrendje.
    const want = dayInfo(iso);
    for (let i = 1; i <= 14; i++) {
      const d = shiftIso(iso, -i);
      if (dayInfo(d).daytype !== want.daytype) continue;
      const alt = await loadLegacy(d);
      if (alt && alt.nTrips > 0) return { kind: "legacy", data: { ...alt.data, date: iso.replace(/-/g, "") }, archived: true, fallbackFrom: d };
    }
  }
  const day = await feeds.serviceDay(iso);
  return day ? { kind: "feed", day, archived: true } : null;
}

export async function routeIndexFor(feeds: FeedManager, iso: string) {
  const src = await scheduleFor(feeds, iso);
  if (!src) return null;
  if (src.kind === "legacy") return { archived: true, routes: src.data.routes, fallback: src.fallbackFrom ? { templateIso: src.fallbackFrom } : null };
  return { archived: src.archived, routes: buildRouteIndex(src.day), fallback: src.day.fallback };
}

export async function tableFor(feeds: FeedManager, iso: string, routeId: string, dir: string) {
  const src = await scheduleFor(feeds, iso);
  if (!src) return null;
  if (src.kind === "legacy") {
    const t = src.data.tables[`${routeId}|${dir}`];
    if (t) return { ...t, date: iso.replace(/-/g, ""), archived: true };
    const route = src.data.routes.find((r) => r.id === routeId);
    if (!route) return { error: "Ismeretlen járat" as const };
    return {
      route: { id: route.id, short: route.short, long: route.long, type: route.type, color: route.color, text: route.text },
      dir,
      date: iso.replace(/-/g, ""),
      headsign: "",
      stops: [],
      trips: [],
      archived: true,
      note: "Ezen a napon nem közlekedett.",
    };
  }
  const table = buildTable(src.day, routeId, dir);
  if (!table) return { error: "Ismeretlen járat" as const };
  return { ...table, archived: src.archived, fallback: src.day.fallback };
}

export async function archiveRange(): Promise<{ from: string; to: string; days: number } | null> {
  const r = await sql<{ mn: string | null; mx: string | null; n: number }>(
    `SELECT min(d)::text AS mn, max(d)::text AS mx, count(*)::int AS n FROM (
       SELECT service_date AS d FROM legacy_schedule_day UNION SELECT service_date FROM service_day) x`,
  );
  const x = r[0];
  return x?.mn && x.mx ? { from: x.mn.replace(/-/g, ""), to: x.mx.replace(/-/g, ""), days: x.n } : null;
}
