import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isGone, normalizeP8, providerToken } from "../src/apns.ts";
import { activityState, type ActivityInput } from "../src/liveActivity.ts";

describe("APNs szolgáltatói token", () => {
  it("ES256 JWT: kid a fejlécben, iss + iat a törzsben, az aláírás ellenőrizhető", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwt = providerToken(privateKey, "KEY123", "894MKLY88M", 1_700_000_000);
    const [head, body, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY123" });
    expect(JSON.parse(Buffer.from(body, "base64url").toString())).toEqual({ iss: "894MKLY88M", iat: 1_700_000_000 });
    // JOSE: r||s, 64 bájt (nem DER)
    expect(Buffer.from(sig, "base64url")).toHaveLength(64);
    expect(verify("sha256", Buffer.from(`${head}.${body}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"))).toBe(true);
  });

  it("a .p8 a környezeti változóban \\n-nel is jöhet", () => {
    expect(normalizeP8("-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\n")).toBe("-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----");
  });

  it("végleg érvénytelen token: 410 vagy BadDeviceToken / Unregistered", () => {
    expect(isGone({ status: 410, reason: "Unregistered", id: null })).toBe(true);
    expect(isGone({ status: 400, reason: "BadDeviceToken", id: null })).toBe(true);
    expect(isGone({ status: 400, reason: "DeviceTokenNotForTopic", id: null })).toBe(true);
    expect(isGone({ status: 429, reason: "TooManyRequests", id: null })).toBe(false);
    expect(isGone({ status: 500, reason: null, id: null })).toBe(false);
  });
});

describe("élő tevékenység állapota", () => {
  const MIDNIGHT = 1_800_000_000;
  const stops = [
    { id: "A", name: "Tiszai pu.", lat: null, lon: null, dep: 8 * 3600 },
    { id: "B", name: "Búza tér", lat: null, lon: null, dep: 8 * 3600 + 600 },
    { id: "C", name: "Újgyőri főtér", lat: null, lon: null, dep: 8 * 3600 + 1500 },
  ];
  const base: ActivityInput = {
    tripId: "t1",
    stops,
    vehicle: { id: "1644", speed: 10 },
    progress: { segmentIndex: 0, progress: 0.25, scheduleDeviationSec: 90 },
    measuredDelaySec: 120,
    complete: false,
    midnightUnix: MIDNIGHT,
    now: MIDNIGHT + 8 * 3600 + 400,
    stopId: "C",
    vehicleId: null,
  };

  it("menet közben: következő megálló, várható idő a mért késéssel, hátralévő megállók", () => {
    expect(activityState(base)).toEqual({
      tripId: "t1",
      vehicleId: "1644",
      live: true,
      progress: 0.25,
      delaySec: 120,
      nextStopId: "B",
      nextStopName: "Búza tér",
      nextStopEtaUnix: MIDNIGHT + 8 * 3600 + 600 + 120,
      stopsLeft: 2,
      stopEtaUnix: MIDNIGHT + 8 * 3600 + 1500 + 120,
      speedKmh: 36,
      ended: false,
      updatedAt: base.now,
    });
  });

  it("mért késés nélkül a menetrendtől való eltérés", () => {
    expect(activityState({ ...base, measuredDelaySec: null }).delaySec).toBe(90);
  });

  it("indulás előtt (nincs jármű): az első megálló a következő, élő jel nélkül", () => {
    const s = activityState({ ...base, vehicle: null, progress: null, measuredDelaySec: null, vehicleId: "1700", now: MIDNIGHT + 7 * 3600 });
    expect(s).toMatchObject({ live: false, progress: null, nextStopId: "A", nextStopEtaUnix: MIDNIGHT + 8 * 3600, vehicleId: "1700", ended: false, stopsLeft: 3 });
  });

  it("beért, vagy jármű nélkül már régen lejárt: vége", () => {
    expect(activityState({ ...base, complete: true })).toMatchObject({ ended: true, progress: 1, nextStopId: null, stopsLeft: 0 });
    expect(activityState({ ...base, vehicle: null, progress: null, now: MIDNIGHT + 8 * 3600 + 1500 + 16 * 60 }).ended).toBe(true);
  });
});
