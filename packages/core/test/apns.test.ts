import { describe, expect, it } from "vitest";
import {
  apnsAlertPayload,
  apnsHost,
  collapseId,
  liveActivityPayload,
  parseApnsEndpoint,
  sameActivityState,
  validActivityToken,
  type LiveActivityState,
} from "../src/apns.ts";

const TOKEN = "a".repeat(64);

describe("APNs-végpont", () => {
  it("környezet és hex-token: a token kisbetűre igazítva", () => {
    expect(parseApnsEndpoint(`apns:sandbox:${"AB".repeat(32)}`)).toEqual({ env: "sandbox", token: "ab".repeat(32) });
    expect(parseApnsEndpoint(`apns:production:${TOKEN}`)).toEqual({ env: "production", token: TOKEN });
  });

  it("minden mást elutasít (a kiszolgáló csak a két Apple-cím lehet)", () => {
    for (const bad of [
      `apns:dev:${TOKEN}`,
      `apns:production:${"a".repeat(63)}`,
      `apns:production:${"a".repeat(201)}`,
      `apns:production:${"g".repeat(64)}`,
      `apns:production:${TOKEN}/x`,
      `https://example.com/${TOKEN}`,
      `apns:production:${TOKEN}@evil.example`,
    ]) {
      expect(parseApnsEndpoint(bad)).toBeNull();
    }
  });

  it("a kiszolgáló a környezetből", () => {
    expect(apnsHost("sandbox")).toBe("api.sandbox.push.apple.com");
    expect(apnsHost("production")).toBe("api.push.apple.com");
  });

  it("az ActivityKit-token hosszabb is lehet, de csak hex", () => {
    expect(validActivityToken("ab".repeat(80))).toBe(true);
    expect(validActivityToken("ab".repeat(201))).toBe(false);
    expect(validActivityToken("xyz")).toBe(false);
    expect(validActivityToken(null)).toBe(false);
  });
});

describe("értesítés-payload", () => {
  it("ugyanaz a cím, szöveg és hivatkozás, mint a Web Pushnál, időérzékenyen", () => {
    const p = apnsAlertPayload({ title: "21-es busz → Tiszai pu.", body: "kb. 4 perc múlva ér ide", tag: "mvk-SP12-t1-arrival", url: "/?stop=SP12#multistop" });
    expect(p).toEqual({
      aps: { alert: { title: "21-es busz → Tiszai pu.", body: "kb. 4 perc múlva ér ide" }, sound: "default", "interruption-level": "time-sensitive", "thread-id": "mvk-SP12-t1-arrival" },
      url: "/?stop=SP12#multistop",
      stopId: "SP12",
    });
  });

  it("a regionális megálló azonosítója dekódolva", () => {
    expect(apnsAlertPayload({ title: "", body: "", tag: "x", url: `/?stop=${encodeURIComponent("1:005510009")}#multistop` }).stopId).toBe("1:005510009");
  });

  it("a collapse-id legfeljebb 64 bájt, ékezetnél sem vág félbe karaktert", () => {
    expect(collapseId("x".repeat(80))).toHaveLength(64);
    const c = collapseId("é".repeat(40));
    expect(Buffer.byteLength(c, "utf8")).toBeLessThanOrEqual(64);
    expect(c).toBe("é".repeat(32));
  });
});

describe("élő tevékenység", () => {
  const state: LiveActivityState = {
    tripId: "t1",
    vehicleId: "1644",
    live: true,
    progress: 0.4,
    delaySec: 120,
    nextStopId: "SP12",
    nextStopName: "Újgyőri főtér",
    nextStopEtaUnix: 1_000_100,
    stopsLeft: 7,
    stopEtaUnix: null,
    destName: null,
    speedKmh: 31,
    ended: false,
    updatedAt: 1_000_000,
  };

  it("frissítés: időbélyeg, állapot és elavulási idő", () => {
    expect(liveActivityPayload("update", state, 1_000_000)).toEqual({
      aps: { timestamp: 1_000_000, event: "update", "content-state": state, "stale-date": 1_000_120 },
    });
  });

  it("vége: elavulás nélkül, a levétel idejével", () => {
    const p = liveActivityPayload("end", { ...state, ended: true }, 1_000_000, { dismissalUnix: 1_000_300 }) as { aps: Record<string, unknown> };
    expect(p.aps["stale-date"]).toBeUndefined();
    expect(p.aps["dismissal-date"]).toBe(1_000_300);
    expect(p.aps.event).toBe("end");
  });

  it("csak a tartalom számít a változásnál, az időbélyeg nem", () => {
    expect(sameActivityState(state, { ...state, updatedAt: 2_000_000 })).toBe(true);
    expect(sameActivityState(state, { ...state, delaySec: 180 })).toBe(false);
    expect(sameActivityState(null, state)).toBe(false);
  });
});
