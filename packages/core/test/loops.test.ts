import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { endsAtLoop, feedFromZip, loopTermini, terminusKind, turnDecision, TURN } from "../src/index.ts";

const ZIP = join(import.meta.dirname, "../../../data/gtfs-cache/latest.zip");
const feed = existsSync(ZIP) ? feedFromZip(new Uint8Array(readFileSync(ZIP))) : null;

describe.skipIf(!feed)("körbeutazás (valós GTFS)", () => {
  const loops = feed ? loopTermini(feed) : new Map();
  const routesAt = (name: string) => [...loops.values()].filter((t) => t.name === name).flatMap((t) => t.routes);

  it("a fordulóhurkos végállomásokat megtalálja", () => {
    expect(routesAt("Hejőpark")).toContain("14");
    expect(routesAt("Bodótető")).toContain("34");
    expect(routesAt("Centrum")).toContain("35");
    expect(routesAt("Görömböly")).toContain("4");
  });

  it("ahol a busz átáll egy másik kocsiállásra, ott nem fordulóhurok", () => {
    expect(routesAt("Tiszai pályaudvar")).not.toContain("1V");
    expect(routesAt("Miskolctapolca")).not.toContain("20");
  });

  it("a körjárat (a menet maga ér vissza) nem forduló", () => {
    // 43/44: Búza tér → … → Búza tér egyetlen menetként
    expect([...loops.values()].some((t) => t.routes.includes("43") && t.name === "Búza tér")).toBe(false);
  });

  it("a végállomás fajtája: ugyanaz a megálló, szomszédos kocsiállás, vagy más hely", () => {
    expect(terminusKind(feed!, "SP414", "SP414")).toBe("loop");
    // Miskolctapolca: érkező SP370 → induló SP371, ~27 m
    expect(terminusKind(feed!, "SP370", "SP371")).toBe("nearby");
    expect(terminusKind(feed!, "SP414", "SP371")).toBeNull();
  });

  it("egy 14-es Hejőpark felé tartó menet fordulóhurkon ér véget", () => {
    const trip = [...feed!.trips.values()].find((t) => {
      const st = feed!.tripStops.get(t.id);
      return feed!.routes.get(t.routeId)?.short === "14" && st?.[st.length - 1].stopId === "SP414";
    });
    expect(trip).toBeDefined();
    expect(endsAtLoop(feed!, trip!.id)).toBe(true);
  });
});

describe("körbeutazás döntés a végállomáson", () => {
  const T0 = 1_800_000_000;
  const turn = { arrivedAt: T0, stay: null };
  const loopNext = (departed: boolean) => ({ loop: true, next: { kind: "loop" as const, cancelled: false, departed } });

  it("amíg nem tudjuk, hogyan folytatja, várunk", () => {
    expect(turnDecision(turn, null, T0 + 30, null)).toBe("wait");
  });

  it("fordulóhurkon a busz indulásakor magától folytatja", () => {
    expect(turnDecision(turn, loopNext(false), T0 + 120, null)).toBe("wait");
    expect(turnDecision(turn, loopNext(true), T0 + 240, null)).toBe("continue");
  });

  it("ha azt mondta, leszállt, nem folytatjuk", () => {
    expect(turnDecision({ ...turn, stay: false }, loopNext(true), T0 + 240, true)).toBe("alight");
  });

  it("fordulóhurkon még várunk a kiosztásra, de nem örökké", () => {
    const none = { loop: true, next: null };
    expect(turnDecision(turn, none, T0 + 5 * 60, null)).toBe("wait");
    expect(turnDecision(turn, none, T0 + TURN.FIND_S + 1, null)).toBe("alight");
  });

  it("nem fordulóhurok, és nincs folytatás: a végállomáson leszállt", () => {
    expect(turnDecision(turn, { loop: false, next: null }, T0 + 10, null)).toBe("alight");
    expect(turnDecision(turn, { loop: false, next: { kind: null, cancelled: false, departed: false } }, T0 + 10, null)).toBe("alight");
  });

  it("szomszédos kocsiállásnál csak akkor folytatja, ha marad vagy a busszal van", () => {
    const nearby = { loop: false, next: { kind: "nearby" as const, cancelled: false, departed: true } };
    expect(turnDecision(turn, nearby, T0 + 600, false)).toBe("alight");
    expect(turnDecision(turn, nearby, T0 + 600, null)).toBe("alight");
    expect(turnDecision(turn, nearby, T0 + 600, true)).toBe("continue");
    expect(turnDecision({ ...turn, stay: true }, nearby, T0 + 600, null)).toBe("continue");
  });

  it("a törölt következő menettel nem utazik tovább", () => {
    expect(turnDecision(turn, { loop: true, next: { kind: "loop", cancelled: true, departed: false } }, T0 + 60, null)).toBe("alight");
  });

  it("ha a busz nagyon sokáig nem indul el, a végállomáson leszállt", () => {
    expect(turnDecision(turn, loopNext(false), T0 + TURN.DEPART_S + 1, null)).toBe("alight");
  });
});
