import { afterEach, describe, expect, it } from "vitest";
import { apnsConfigured, validPushEndpoint } from "../src/push.ts";

const TOKEN = "0123456789abcdef".repeat(4);

describe("push-végpontok (SSRF-védelem)", () => {
  it("a böngészők push-szolgáltatásai és az iPhone APNs-végpontja", () => {
    expect(validPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(validPushEndpoint("https://web.push.apple.com/QGx")).toBe(true);
    expect(validPushEndpoint(`apns:production:${TOKEN}`)).toBe(true);
    expect(validPushEndpoint(`apns:sandbox:${TOKEN}`)).toBe(true);
  });

  it("tetszőleges cím vagy hibás APNs-végpont nem", () => {
    expect(validPushEndpoint("https://example.com/push")).toBe(false);
    expect(validPushEndpoint("http://fcm.googleapis.com/x")).toBe(false);
    expect(validPushEndpoint(`apns:staging:${TOKEN}`)).toBe(false);
    expect(validPushEndpoint("apns:production:not-hex")).toBe(false);
    expect(validPushEndpoint(`apns:production:${TOKEN}.evil.example`)).toBe(false);
  });
});

describe("APNs beállítva", () => {
  const keys = ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_KEY", "APNS_TOPIC"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] == null) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("csak ha mind a négy változó megvan", () => {
    process.env.APNS_KEY_ID = "ABC123";
    process.env.APNS_TEAM_ID = "894MKLY88M";
    process.env.APNS_KEY = "-----BEGIN PRIVATE KEY-----";
    process.env.APNS_TOPIC = "hu.futozs.mvk";
    expect(apnsConfigured()).toBe(true);
    process.env.APNS_KEY = " ";
    expect(apnsConfigured()).toBe(false);
  });
});
