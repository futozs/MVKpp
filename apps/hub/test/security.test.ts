import { describe, expect, it } from "vitest";
import { hostAllowed, ipAllowed, ipInCidr, normalizeIp } from "../src/server/netguard.ts";
import { clearLoginFailures, issueSession, loginBlocked, noteLoginFailure, passwordMatches, revokeAllSessions, revokeSession, verifySession } from "../src/server/session.ts";

const PW = "correct horse battery";

describe("session cookie", () => {
  it("verifies its own live session and rejects tampering and expiry", () => {
    const s = issueSession(60_000, 1_000);
    expect(verifySession(s.value, 2_000)).toBe(true);
    expect(verifySession(s.value, 70_000)).toBe(false);
    const parts = s.value.split(".");
    expect(verifySession([parts[0], String(Number(parts[1]) + 999_999), parts[2], parts[3]].join("."), 2_000)).toBe(false);
    expect(verifySession(`${parts.slice(0, 3).join(".")}.AAAA`, 2_000)).toBe(false);
    expect(verifySession(undefined)).toBe(false);
    expect(verifySession("v1.x.y")).toBe(false);
  });

  it("logout really kills the cookie, and logout-all kills every session", () => {
    const now = Date.now();
    const a = issueSession(60_000, now);
    const b = issueSession(60_000, now);
    revokeSession(a.value);
    expect(verifySession(a.value, now + 1)).toBe(false);
    expect(verifySession(b.value, now + 1)).toBe(true);
    revokeAllSessions();
    expect(verifySession(b.value, now + 1)).toBe(false);
  });

  it("compares passwords exactly and refuses an unset password", () => {
    expect(passwordMatches(PW, PW)).toBe(true);
    expect(passwordMatches(`${PW} `, PW)).toBe(false);
    expect(passwordMatches("", "")).toBe(false);
  });

  it("locks an address out after repeated failures, and lets it back after success", () => {
    const ip = "10.9.9.9";
    for (let i = 0; i < 8; i++) noteLoginFailure(ip, 1_000);
    expect(loginBlocked(ip, 2_000)).toBeGreaterThan(0);
    expect(loginBlocked(ip, 1_000 + 16 * 60_000)).toBe(0);
    clearLoginFailures(ip);
    expect(loginBlocked(ip, 2_000)).toBe(0);
  });
});

describe("host header guard (DNS rebinding)", () => {
  it("accepts IP literals, localhost and configured names only", () => {
    expect(hostAllowed("192.168.1.11:8099", [])).toBe(true);
    expect(hostAllowed("[fd00::1]:8099", [])).toBe(true);
    expect(hostAllowed("localhost:3010", [])).toBe(true);
    expect(hostAllowed("hub.lan:8099", ["hub.lan"])).toBe(true);
    expect(hostAllowed("evil.example.com:8099", ["hub.lan"])).toBe(false);
    expect(hostAllowed("evil.com", [])).toBe(false);
    expect(hostAllowed("a:b", [])).toBe(false);
    expect(hostAllowed("[not-ip]", [])).toBe(false);
    expect(hostAllowed(null, [])).toBe(false);
  });
});

describe("internal network guard", () => {
  it("matches IPv4 and IPv6 CIDRs", () => {
    expect(ipInCidr("192.168.1.37", "192.168.0.0/16")).toBe(true);
    expect(ipInCidr("192.169.1.1", "192.168.0.0/16")).toBe(false);
    expect(ipInCidr("172.31.255.1", "172.16.0.0/12")).toBe(true);
    expect(ipInCidr("172.32.0.1", "172.16.0.0/12")).toBe(false);
    expect(ipInCidr("fd12:3456::1", "fc00::/7")).toBe(true);
    expect(ipInCidr("2001:db8::1", "fc00::/7")).toBe(false);
    expect(ipInCidr("::1", "::1/128")).toBe(true);
  });

  it("unwraps IPv4-mapped IPv6 and zone ids", () => {
    expect(normalizeIp("::ffff:10.5.5.2")).toBe("10.5.5.2");
    expect(normalizeIp("fe80::1%en0")).toBe("fe80::1");
  });

  it("allows LAN, loopback and VPN ranges by default, nothing public", () => {
    for (const ip of ["192.168.1.11", "10.5.5.2", "127.0.0.1", "::1", "::ffff:192.168.1.5", "100.100.1.1"]) expect(ipAllowed(ip, [])).toBe(true);
    for (const ip of ["8.8.8.8", "84.206.68.21", "2a00:1450::1", "", "not-an-ip"]) expect(ipAllowed(ip, [])).toBe(false);
  });

  it("uses only the configured list when given", () => {
    expect(ipAllowed("192.168.1.11", ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
  });
});
