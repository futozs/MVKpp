import { describe, expect, it } from "vitest";
import { deployScript } from "../src/server/deploy.ts";
import { parseDockerLine } from "../src/server/logs.ts";

describe("deployScript", () => {
  const base = { composeFile: "infra/docker-compose.yml", envFile: "infra/.env", project: "mvk" };

  it("pulls, builds, swaps worker+web with a health wait, and replaces the hub last", () => {
    const s = deployScript({ ...base, pull: true, services: ["worker", "web", "hub"] });
    const order = ["git pull --ff-only", "build worker web hub", "up -d --no-deps worker web", "Health.Status", "up -d --no-deps hub"].map((x) => s.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(s.startsWith("set -eu")).toBe(true);
  });

  it("skips git and the hub when not asked", () => {
    const s = deployScript({ ...base, pull: false, services: ["web"] });
    expect(s).not.toContain("git pull");
    expect(s).not.toContain("--no-deps hub");
    expect(s).toContain("up -d --no-deps web");
  });

  it("quotes compose arguments so a path with spaces stays one argument", () => {
    const s = deployScript({ ...base, composeFile: "my dir/compose.yml", pull: false, services: ["worker"] });
    expect(s).toContain("-f 'my dir/compose.yml'");
  });
});

describe("parseDockerLine", () => {
  it("reads the worker's own format behind the Docker timestamp", () => {
    const l = parseDockerLine("2026-10-30T10:00:00.123456789Z 10:00:00 ! [poll] hiba: HTTP 503", "out", 1, "docker:mvk-worker-1");
    expect(l).toMatchObject({ level: "warn", tag: "poll", msg: "hiba: HTTP 503", ts: Date.parse("2026-10-30T10:00:00.123Z") });
  });

  it("guesses the level of foreign lines", () => {
    expect(parseDockerLine("2026-10-30T10:00:00Z ERROR: relation does not exist", "err", 2, "docker:mvk-db-1").level).toBe("error");
    expect(parseDockerLine("2026-10-30T10:00:00Z checkpoint starting", "out", 3, "docker:mvk-db-1").level).toBe("info");
    expect(parseDockerLine("2026-10-30T10:00:00Z something on stderr", "err", 4, "docker:mvk-caddy-1").level).toBe("warn");
  });
});
