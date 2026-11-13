import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { endsAtLoop, feedFromZip, loopTermini, terminusKind, plannedTurnDecision, TURN } from "../src/index.ts";

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

describe("előre bejelentett körbeutazás a végállomáson", () => {
  const T0 = 1_800_000_000;
  const next = (departed: boolean, kind: "loop" | "nearby" | null = "loop", cancelled = false) => ({ loop: true, next: { kind, cancelled, departed } });

  it("amíg nincs adat a folytatásról, vár", () => {
    expect(plannedTurnDecision(T0, null, T0 + 30)).toBe("wait");
    expect(plannedTurnDecision(T0, null, T0 + 5 * 3600)).toBe("wait");
  });

  it("a busz indulásakor folytatja  a telefon helyétől függetlenül", () => {
    expect(plannedTurnDecision(T0, next(false), T0 + 120)).toBe("wait");
    expect(plannedTurnDecision(T0, next(true), T0 + 240)).toBe("continue");
    expect(plannedTurnDecision(T0, next(true, "nearby"), T0 + 600)).toBe("continue");
  });

  it("órákkal később megnyitott app: az elindult folytatással megy tovább, nem zárja le", () => {
    expect(plannedTurnDecision(T0, next(true), T0 + 3 * 3600)).toBe("continue");
  });

  it("törölt vagy máshonnan induló menet, illetve hiányzó folytatás: türelmi idő után a végállomáson ért véget", () => {
    expect(plannedTurnDecision(T0, next(false, "loop", true), T0 + 60)).toBe("wait");
    expect(plannedTurnDecision(T0, next(false, "loop", true), T0 + TURN.FIND_S + 1)).toBe("alight");
    expect(plannedTurnDecision(T0, { loop: true, next: null }, T0 + TURN.FIND_S + 1)).toBe("alight");
    expect(plannedTurnDecision(T0, next(true, null), T0 + TURN.FIND_S + 1)).toBe("alight");
  });

  it("ha a következő menet nagyon sokáig nem indul el, a végállomáson ért véget", () => {
    expect(plannedTurnDecision(T0, next(false), T0 + TURN.DEPART_S + 1)).toBe("alight");
  });
});
