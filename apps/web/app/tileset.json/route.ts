// Melyik csempekészlet él most (a tools/tiles-update.sh írja a current.json-t). A csempék
// címe ettől függ, így azok örökre gyorsítótárazhatók; ez a kis fájl mindig friss.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// fejlesztéskor a repó data/tiles mappája (a cwd az apps/web)
const TILES_DIR = process.env.TILES_DIR ?? path.resolve(process.cwd(), "../../data/tiles");
const NAME = /^[\w.-]+$/;

function isBounds(v: unknown): v is [number, number, number, number] {
  return Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

export async function GET(req: Request) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(TILES_DIR, "current.json"), "utf8"));
  } catch {
    return Response.json({ error: "Nincs térképcsempe (data/tiles/current.json)." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const raw = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const { vector, dem, bounds } = raw;
  if (typeof vector !== "string" || typeof dem !== "string" || !NAME.test(vector) || !NAME.test(dem) || (bounds !== undefined && !isBounds(bounds))) {
    return Response.json({ error: "Hibás current.json." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  const body = JSON.stringify({ vector, dem, ...(bounds ? { bounds } : {}) });
  const etag = `"${createHash("sha1").update(body).digest("base64url").slice(0, 16)}"`;
  const headers = { "Cache-Control": "no-cache", ETag: etag, "Content-Type": "application/json" };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(body, { headers });
}
