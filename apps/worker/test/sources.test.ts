import { describe, expect, it } from "vitest";
import { SourceManager } from "../src/sources.ts";

describe("MVK → MÁV+ tartalék", () => {
  it("401/403-ra azonnal átáll", () => {
    const s = new SourceManager();
    s.onMvk({ ok: false, status: 403, reason: "HTTP 403" });
    expect(s.state).toBe("otp2");
  });

  it("időtúllépésre csak 60 mp folyamatos kiesés után", () => {
    const s = new SourceManager();
    const t0 = 1_000_000;
    s.onMvk({ ok: false, status: null, reason: "timeout" }, t0);
    s.onMvk({ ok: false, status: 503, reason: "HTTP 503" }, t0 + 30_000);
    expect(s.state).toBe("mvk");
    s.onMvk({ ok: false, status: null, reason: "timeout" }, t0 + 61_000);
    expect(s.state).toBe("otp2");
  });

  it("egy közbülső sikeres poll a kiesés-órát nullázza", () => {
    const s = new SourceManager();
    const t0 = 1_000_000;
    s.onMvk({ ok: false, status: 500, reason: "HTTP 500" }, t0);
    s.onMvk({ ok: true }, t0 + 40_000);
    s.onMvk({ ok: false, status: 500, reason: "HTTP 500" }, t0 + 50_000);
    s.onMvk({ ok: false, status: 500, reason: "HTTP 500" }, t0 + 100_000);
    expect(s.state).toBe("mvk");
  });

  it("5 egymás utáni jó poll után vissza az MVK-ra", () => {
    const s = new SourceManager();
    s.tokenUnusable("nincs MVK token");
    expect(s.state).toBe("otp2");
    for (let i = 0; i < 4; i++) s.onMvk({ ok: true });
    expect(s.state).toBe("otp2");
    s.onMvk({ ok: true });
    expect(s.state).toBe("mvk");
  });

  it("tartalékban az MVK-t csak 10 mp-enként próbálja, és token nélkül sosem", () => {
    const s = new SourceManager();
    s.tokenUnusable("lejárt");
    expect(s.shouldPollMvk(false, 0)).toBe(false);
    expect(s.shouldPollMvk(true, 100_000)).toBe(true);
    expect(s.shouldPollMvk(true, 105_000)).toBe(false);
    expect(s.shouldPollMvk(true, 111_000)).toBe(true);
  });

  it("napközbeni újraindításkor a mai tartalék-idő folytatódik, éjfélkor nullázódik", () => {
    const s = new SourceManager();
    s.restoreToday(1500);
    expect(s.fallbackSecToday()).toBe(1500);
    s.tokenUnusable("nincs MVK token");
    // a futó tartalék-szakasz is hozzáadódik
    expect(s.fallbackSecToday()).toBeGreaterThanOrEqual(1500);
    s.rollDay();
    expect(s.fallbackSecToday()).toBeLessThan(5);
    expect(s.state).toBe("otp2");
  });

  it("MÁV+ nélkül nem áll át (nincs hova), de az okot megjegyzi", () => {
    const s = new SourceManager();
    s.canFallback = false;
    s.onMvk({ ok: false, status: 401, reason: "HTTP 401" });
    s.tokenUnusable("nincs MVK token");
    expect(s.state).toBe("mvk");
    expect(s.reason).toBe("nincs MVK token");
    expect(s.fallbackSecToday()).toBe(0);
  });
});
