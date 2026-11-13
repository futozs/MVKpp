import { afterAll, describe, expect, it } from "vitest";
import { decodeValue, encodeValue, TieredCache } from "../src/index.ts";

describe("kódolás", () => {
  it("kis értéket nyersen, nagyot tömörítve tárol, és visszaadja", () => {
    const small = { a: 1, b: "kicsi" };
    const big = { rows: Array.from({ length: 2000 }, (_, i) => [i, 48.1 + i / 1e5, 20.7, "Tiszai pu."]) };
    const s = encodeValue(small)!;
    const b = encodeValue(big)!;
    expect(s[0]).toBe(0);
    expect(b[0]).toBe(1);
    expect(b.length).toBeLessThan(Buffer.byteLength(JSON.stringify(big)) / 3);
    expect(decodeValue(s)).toEqual(small);
    expect(decodeValue(b)).toEqual(big);
  });

  it("a nem tárolható értékre null", () => {
    expect(encodeValue(undefined)).toBeNull();
  });
});

describe("memóriás gyorsítótár (Redis nélkül)", () => {
  it("egyidejű kérések egyetlen számítást várnak meg", async () => {
    const c = new TieredCache(null);
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return calls;
    };
    const [a, b] = await Promise.all([c.cached("k", 60, fn), c.cached("k", 60, fn)]);
    expect([a, b, calls]).toEqual([1, 1, 1]);
    expect(await c.cached("k", 60, fn)).toBe(1);
    expect(c.status()).toMatchObject({ backend: "memory", misses: 1, hits: 2 });
  });

  it("a hibát nem teszi el  a következő kérés újraszámol", async () => {
    const c = new TieredCache(null);
    await expect(c.cached("x", 60, async () => Promise.reject(new Error("db le")))).rejects.toThrow("db le");
    await new Promise((r) => setTimeout(r, 0));
    expect(await c.cached("x", 60, async () => "ok")).toBe("ok");
  });

  it("lejárat után újraszámol", async () => {
    const c = new TieredCache(null);
    let n = 0;
    await c.cached("t", 0.01, async () => ++n);
    await new Promise((r) => setTimeout(r, 30));
    expect(await c.cached("t", 0.01, async () => ++n)).toBe(2);
  });
});

// Valódi Redis ellen csak akkor fut, ha meg van adva (pl. TEST_REDIS_URL=redis://127.0.0.1:6380).
const url = process.env.TEST_REDIS_URL;
describe.skipIf(!url)("Redis-szint", () => {
  const a = new TieredCache(url ?? null);
  const b = new TieredCache(url ?? null);
  afterAll(async () => {
    await a.close();
    await b.close();
  });

  it("egy másik folyamat (példány) a Redisből kapja meg az értéket", async () => {
    await new Promise((r) => setTimeout(r, 300));
    const key = `test:${Date.now()}`;
    const big = { rows: Array.from({ length: 3000 }, (_, i) => i) };
    expect(await a.cached(key, 30, async () => big)).toEqual(big);
    await new Promise((r) => setTimeout(r, 50));
    let computed = false;
    const got = await b.cached(key, 30, async () => {
      computed = true;
      return null;
    });
    expect(computed).toBe(false);
    expect(got).toEqual(big);
    expect(b.status().redisHits).toBe(1);
  });
});
