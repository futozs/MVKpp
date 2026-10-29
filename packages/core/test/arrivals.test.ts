import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { arrivalsForStop, feedFromZip, localMidnightUnix, resolveServiceDay, type RealtimeSnapshot } from "../src/index.ts";

const ZIP = join(import.meta.dirname, "../../../data/gtfs-cache/latest.zip");
const feed = existsSync(ZIP) ? feedFromZip(new Uint8Array(readFileSync(ZIP))) : null;

const EMPTY: RealtimeSnapshot = {
  fetchedAt: 0,
  header: { version: "", timestamp: 0 },
  decoded: [],
  vehicles: [],
  predByStop: new Map(),
  updatesHeaderTs: 0,
  updatesCount: 0,
  rtError: null,
};

describe.skipIf(!feed)("megállótábla éjfél körül", () => {
  // Csütörtök → péntek: a két nap menetei ugyanazokkal az azonosítókkal közlekednek.
  const today = "2026-10-29";
  const tomorrow = "2026-10-30";
  const days = [
    { day: resolveServiceDay([feed!], today)!, midnightUnix: localMidnightUnix(today) },
    { day: resolveServiceDay([feed!], tomorrow)!, midnightUnix: localMidnightUnix(tomorrow) },
  ];

  it("késő este a holnapi hajnali indulások is látszanak", () => {
    const at = localMidnightUnix(today) + 23 * 3600 + 30 * 60;
    const board = arrivalsForStop("SP283", 12, EMPTY, days, at);
    expect(board.arrivals.length).toBe(12);
    expect(board.arrivals.some((a) => /^0[3-6]:/.test(a.time))).toBe(true);
  });

  it("a holnapi példányra nem kerül rá a mai élő adat (törlés)", () => {
    const at = localMidnightUnix(today) + 23 * 3600 + 30 * 60;
    const all = arrivalsForStop("SP283", 40, EMPTY, days, at);
    const morning = all.arrivals.filter((a) => /^0[3-6]:/.test(a.time));
    const cancelled = new Set(morning.map((a) => a.tripId));
    const board = arrivalsForStop("SP283", 40, EMPTY, days, at, { cancelled });
    expect(board.arrivals.filter((a) => /^0[3-6]:/.test(a.time)).every((a) => !a.cancelled)).toBe(true);
  });
});
