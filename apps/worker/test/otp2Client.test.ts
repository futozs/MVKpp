import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Otp2Client, Otp2Error } from "../src/otp2/client.ts";

type Reply = { status?: number; body: string };
const ok = (data: unknown): Reply => ({ body: JSON.stringify({ data }) });

/** Hamis hálózat: a kérések sorrendje és ideje, a válaszok sorban. */
function fakeFetch(replies: Reply[]) {
  const calls: { at: number; op: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const { variables } = JSON.parse(init.body) as { variables: { op: string } };
      calls.push({ at: Date.now(), op: variables.op });
      const r = replies.shift() ?? ok({ op: variables.op });
      return new Response(r.body, { status: r.status ?? 200 });
    }),
  );
  return calls;
}

describe("MÁV+ OTP2-kliens", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("egy soron, legalább 500 ms közzel kérdez", async () => {
    const calls = fakeFetch([]);
    const c = new Otp2Client();
    const all = Promise.all(["a", "b", "c"].map((op) => c.query(op, "q", { op })));
    await vi.advanceTimersByTimeAsync(5_000);
    await all;
    expect(calls.map((x) => x.op)).toEqual(["a", "b", "c"]);
    for (let i = 1; i < calls.length; i++) expect(calls[i].at - calls[i - 1].at).toBeGreaterThanOrEqual(500);
  });

  it("az élő (high) kérés a menetrend-építés (low) elé kerül", async () => {
    const calls = fakeFetch([]);
    const c = new Otp2Client();
    const jobs = [c.query("l1", "q", { op: "l1" }, { priority: "low" }), c.query("l2", "q", { op: "l2" }, { priority: "low" }), c.query("h", "q", { op: "h" })];
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all(jobs);
    // az első alacsony már elindult, a magas a második alacsony elé ugrik
    expect(calls.map((x) => x.op)).toEqual(["l1", "h", "l2"]);
  });

  it("„host limit” után az egész sor 15 mp-et vár, és a kérés újra próbálkozik", async () => {
    const calls = fakeFetch([{ status: 403, body: "host limit achived" }]);
    const c = new Otp2Client();
    const p = c.query("v", "q", { op: "v" });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(p).resolves.toEqual({ op: "v" });
    expect(calls).toHaveLength(2);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(15_000);
    expect(c.stats.limited).toBe(1);
    expect(c.stats.ok).toBe(1);
  });

  it("a GraphQL-hiba (HTTP 200 + errors) elutasít, de nem ritkít", async () => {
    const calls = fakeFetch([{ body: JSON.stringify({ errors: [{ message: "Field 'x' undefined" }] }) }]);
    const c = new Otp2Client();
    const bad = c.query("bad", "q", { op: "bad" });
    const next = c.query("next", "q", { op: "next" });
    const caught = bad.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    const err = await caught;
    expect(err).toBeInstanceOf(Otp2Error);
    expect((err as Otp2Error).message).toContain("Field 'x' undefined");
    await expect(next).resolves.toEqual({ op: "next" });
    expect(calls[1].at - calls[0].at).toBeLessThan(1_000);
    expect(c.backingOff()).toBe(false);
  });

  it("200-as HTML-válasz (karbantartás) is ritkítást vált ki", async () => {
    fakeFetch([{ body: "<html>Karbantartás</html>" }]);
    const c = new Otp2Client();
    const p = c.query("x", "q", { op: "x" }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    const err = await p;
    expect(err).toBeInstanceOf(Otp2Error);
    expect((err as Otp2Error).status).toBe(502);
    expect(c.backingOff()).toBe(true);
  });

  it("szerverhiba (5xx) után fokozatosan ritkít", async () => {
    fakeFetch([{ status: 502, body: "Bad Gateway" }]);
    const c = new Otp2Client();
    const p = c.query("x", "q", { op: "x" }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(await p).toBeInstanceOf(Otp2Error);
    expect(c.backingOff()).toBe(true);
    expect(c.stats.fail).toBe(1);
  });
});
