import { describe, expect, it, vi } from "vitest";
import { LogRing, parseLogLine } from "../src/ops/logRing.ts";
import { RouteMetrics } from "../src/ops/metrics.ts";

describe("RouteMetrics", () => {
  it("counts calls and server errors per key, newest window only", () => {
    const m = new RouteMetrics();
    for (let i = 0; i < 90; i++) m.record("GET /a", 20, 200);
    for (let i = 0; i < 10; i++) m.record("GET /a", 800, 503);
    m.record("GET /b", 5, 404);
    const [a, b] = m.snapshot(15);
    expect(a.key).toBe("GET /a");
    expect(a.count).toBe(100);
    expect(a.errors).toBe(10);
    expect(a.codes["2xx"]).toBe(90);
    expect(a.codes["5xx"]).toBe(10);
    // a 404 kliens-hiba, nem szerverhiba
    expect(b.errors).toBe(0);
  });

  it("estimates quantiles inside the histogram buckets", () => {
    const m = new RouteMetrics();
    for (let i = 0; i < 95; i++) m.record("k", 40, 200);
    for (let i = 0; i < 5; i++) m.record("k", 2000, 200);
    const s = m.snapshot(1)[0];
    expect(s.p50Ms).toBeGreaterThan(25);
    expect(s.p50Ms).toBeLessThanOrEqual(50);
    expect(s.p99Ms).toBeGreaterThan(1000);
    expect(s.maxMs).toBe(2000);
    expect(s.avgMs).toBe(Math.round((95 * 40 + 5 * 2000) / 100));
  });

  it("folds keys beyond the cap into one bucket instead of growing forever", () => {
    const m = new RouteMetrics();
    for (let i = 0; i < 400; i++) m.record(`GET /x${i}`, 1, 200);
    const keys = m.snapshot(1).map((s) => s.key);
    expect(keys.length).toBe(301);
    expect(keys).toContain("(egyéb)");
  });

  it("drops minutes older than the window from the snapshot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T10:00:00Z"));
    const m = new RouteMetrics();
    m.record("k", 10, 200);
    vi.setSystemTime(new Date("2026-10-30T10:30:00Z"));
    m.record("k", 10, 200);
    expect(m.snapshot(15)[0].count).toBe(1);
    expect(m.snapshot(60)[0].count).toBe(2);
    vi.useRealTimers();
  });
});

describe("LogRing", () => {
  it("keeps the newest lines up to its capacity, with growing sequence numbers", () => {
    const r = new LogRing(3);
    for (let i = 1; i <= 5; i++) r.push("info", "t", `m${i}`);
    expect(r.since(0).map((l) => l.msg)).toEqual(["m3", "m4", "m5"]);
    expect(r.since(4).map((l) => l.msg)).toEqual(["m5"]);
    expect(r.lastSeq).toBe(5);
  });

  it("notifies subscribers and survives a throwing one", () => {
    const r = new LogRing();
    const seen: string[] = [];
    r.subscribe(() => {
      throw new Error("boom");
    });
    const off = r.subscribe((l) => seen.push(l.msg));
    r.push("warn", "x", "a");
    off();
    r.push("warn", "x", "b");
    expect(seen).toEqual(["a"]);
  });

  it("parses the worker's own log format and falls back for foreign lines", () => {
    expect(parseLogLine("12:00:01 ! [poll] hiba", "info")).toEqual({ level: "warn", tag: "poll", msg: "hiba" });
    expect(parseLogLine("12:00:01 ✖ [http] GET /x", "info")).toEqual({ level: "error", tag: "http", msg: "GET /x" });
    expect(parseLogLine("12:00:01   [worker] fut", "error").level).toBe("info");
    expect(parseLogLine("pg-boss: something", "error")).toEqual({ level: "error", tag: "console", msg: "pg-boss: something" });
  });
});
