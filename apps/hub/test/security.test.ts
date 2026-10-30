import { describe, expect, it } from "vitest";
import { ipAllowed, ipInCidr, normalizeIp } from "../src/server/netguard.ts";
import { clearLoginFailures, issueSession, loginBlocked, noteLoginFailure, passwordMatches, verifySession } from "../src/server/session.ts";

const PW = "correct horse battery";
const SECRET = "0123456789abcdef0123456789abcdef";

describe("session cookie", () => {
  it("verifies its own session and rejects tampering, expiry and a changed password", () => {
    const s = issueSession(PW, SECRET, 60_000, 1_000);
    expect(verifySession(s.value, PW, SECRET, 2_000)).toBe(true);
    expect(verifySession(s.value, PW, SECRET, 70_000)).toBe(false);
    expect(verifySession(s.value, "other password!", SECRET, 2_000)).toBe(false);
    const parts = s.value.split(".");
    expect(verifySession([parts[0], String(Number(parts[1]) + 999_999), parts[2], parts[3]].join("."), PW, SECRET, 2_000)).toBe(false);
    expect(verifySession(undefined, PW, SECRET)).toBe(false);
    expect(verifySession("v1.x.y", PW, SECRET)).toBe(false);
  });

  it("refuses everything when the hub has no password configured", () => {
    const s = issueSession(PW, SECRET, 60_000);
    expect(verifySession(s.value, "", SECRET)).toBe(false);
    expect(passwordMatches("", "")).toBe(false);
  });

  it("compares passwords exactly", () => {
    expect(passwordMatches(PW, PW)).toBe(true);
    expect(passwordMatches(`${PW} `, PW)).toBe(false);
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
