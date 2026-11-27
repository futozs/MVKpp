/**
 * Az adventi villamos nyilvános API-ja (/engine/advent/…). Változat nélküli,
 * de csak bővül: egy későbbi külön oldal (közösségi felület) is ebből dolgozik.
 */
import { isPlausibleIso, nowUnix, serviceClock } from "@mvk/core";
import type { AdventDay } from "@mvk/core/advent/day";
import { SEASONS, seasonOf, seasonOn } from "@mvk/core/advent/season";
import { seasonSummary } from "@mvk/core/advent/seasonStats";
import { dayCards, seasonCards } from "@mvk/core/advent/wrapped";
import { cached } from "@mvk/cache";
import type { AdventTracker } from "../advent.ts";
import { HttpError, sendJson, type Router } from "./router.ts";

/** a nap nyilvános alakja: a menetek GPS-pontjai nélkül (azok a /track-en) */
export function publicDay(day: AdventDay) {
  return { ...day, legs: day.legs.map(({ fixes, passes, ...l }) => ({ ...l, fixes: fixes.length, passes: passes.length })) };
}

/** hányadik napja az évadnak (az évadon kívül null) */
function dayNo(iso: string): number | null {
  const s = seasonOn(iso);
  return s ? Math.round((Date.parse(iso) - Date.parse(s.start)) / 86_400_000) + 1 : null;
}

function dateParam(raw: string | null, today: string): string {
  const iso = (raw ?? "").trim() || today;
  if (!isPlausibleIso(iso, today, 3 * 366)) throw new HttpError(400, "érvénytelen dátum");
  return iso;
}

export function registerAdvent(r: Router, advent: AdventTracker) {
  /** az évadok (menetrend, megállók, vonal) és a mai nap */
  r.get("/engine/advent", async (req, res) => {
    const today = serviceClock().iso;
    const lc = advent.line();
    const body = await cached(`advent:meta:${today}:${lc ? "1" : "0"}`, 300, async () => ({
      today,
      current: advent.season(today).year,
      inSeason: seasonOn(today) != null,
      seasons: SEASONS.map((s) => ({ ...s, stops: s.stops.map((st, i) => ({ ...st, outAt: lc?.line.platforms[i]?.out ?? null, backAt: lc?.line.platforms[i]?.back ?? null })) })),
      line: lc ? { out: lc.out.shape.points.map(([la, lo]) => [Math.round(la * 1e6) / 1e6, Math.round(lo * 1e6) / 1e6]), lengthM: Math.round(lc.out.shape.lengthM) } : null,
    }));
    sendJson(req, res, 200, body, { "cache-control": "public, max-age=300" });
  });

  /** a mai nap élőben: állapot, menetek, várható érkezések, zavarok, számok */
  r.get("/engine/advent/live", (req, res) => {
    const now = nowUnix();
    const day = advent.live(now);
    if (!day) throw new HttpError(503, "a vonal még nem töltődött be");
    sendJson(req, res, 200, { at: now, day: publicDay(day), cards: dayCards(advent.season(day.iso), day, dayNo(day.iso)) }, { "cache-control": "public, max-age=4" });
  });

  /** egy nap (a mai élőben, a múltbeli a tárolt pontokból) */
  r.get("/engine/advent/day", async (req, res) => {
    const now = nowUnix();
    const today = serviceClock(now).iso;
    const iso = dateParam(req.query.get("date"), today);
    const day = await advent.day(iso, now);
    if (!day) throw new HttpError(503, "a vonal még nem töltődött be");
    const settled = day.closed && iso < today;
    sendJson(req, res, 200, { at: now, day: publicDay(day), cards: dayCards(advent.season(iso), day, dayNo(iso)) }, { "cache-control": settled ? "public, max-age=600" : "public, max-age=10" });
  });

  /** a nap nyers GPS-pontjai: [ts, lat, lon, sebesség m/s] (visszanézéshez, exporthoz) */
  r.get("/engine/advent/track", async (req, res) => {
    const today = serviceClock().iso;
    const iso = dateParam(req.query.get("date"), today);
    const rows = await advent.track(iso);
    const points = rows.filter((p) => !p.glitch).map((p) => [Math.round(p.t), p.lat, p.lon, p.speed == null ? null : Math.round(p.speed * 10) / 10]);
    sendJson(req, res, 200, { date: iso, vehicles: [...new Set(rows.map((p) => p.v))], points }, { "cache-control": iso < today ? "public, max-age=600" : "public, max-age=10" });
  });

  /** az évad: naptár, összesen, rekordok, megállók, indulások, Wrapped-lapok */
  r.get("/engine/advent/season", async (req, res) => {
    const now = nowUnix();
    const today = serviceClock(now).iso;
    const year = Number(req.query.get("year") ?? advent.season(today).year);
    if (!seasonOf(year)) throw new HttpError(404, "nincs ilyen évad");
    const body = await cached(`advent:season:${year}:${Math.floor(now / 30)}`, 30, async () => {
      const got = await advent.seasonDays(year, now);
      if (!got) throw new HttpError(404, "nincs ilyen évad");
      const summary = seasonSummary(got.season, got.days);
      return { at: now, summary, cards: seasonCards(got.season, summary) };
    });
    sendJson(req, res, 200, body, { "cache-control": "public, max-age=30" });
  });
}
