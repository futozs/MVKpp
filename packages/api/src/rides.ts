/**
 * /v3/rides — az utazási napló a felhőben.
 *
 * Utazásonként egy sor (azonosító: a kliensen generált UUID), így több eszköz
 * egyszerre is rögzíthet, nem írják felül egymást. A kliens bejelentkezéskor
 * feltölti a telefonon gyűlt utazásokat, és letölti a többi eszközén rögzítetteket.
 */
import { getPool, sql } from "@mvk/db";
import { requireUser } from "./account.ts";
import { ApiError, body, dispatch, json, route, type Route } from "./http.ts";

const MAX_BATCH = 200;
const MAX_RIDE_BYTES = 4096;
const MAX_LIST = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RideIn = { id: string; boardedAt: number } & Record<string, unknown>;

function isRide(x: unknown, now: number): x is RideIn {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  if (typeof r.id !== "string" || !UUID_RE.test(r.id)) return false;
  if (typeof r.boardedAt !== "number" || !Number.isFinite(r.boardedAt)) return false;
  // 2020 utáni, és legfeljebb egy nappal a jövőben (eltérő kliens-óra).
  if (r.boardedAt < 1_577_836_800 || r.boardedAt > now + 86_400) return false;
  return JSON.stringify(r).length <= MAX_RIDE_BYTES;
}

const routes: Route[] = [
  route("GET", "/v3/rides", async (req) => {
    const u = await requireUser(req);
    const rows = await sql<{ data: unknown }>(`SELECT data FROM ride WHERE user_id = $1 ORDER BY boarded_at DESC LIMIT $2`, [u.id, MAX_LIST]);
    return json({ rides: rows.map((r) => r.data) });
  }),

  route("POST", "/v3/rides", async (req) => {
    const u = await requireUser(req);
    const b = await body<{ rides?: unknown[] }>(req);
    if (!b || !Array.isArray(b.rides)) throw new ApiError(400, "hiányzó rides[]");
    if (b.rides.length > MAX_BATCH) throw new ApiError(413, `egyszerre legfeljebb ${MAX_BATCH} utazás küldhető`);
    const now = Date.now() / 1000;
    const ok = b.rides.filter((r): r is RideIn => isRide(r, now));
    for (const r of ok) {
      await getPool().query(
        `INSERT INTO ride (user_id, ride_id, boarded_at, data) VALUES ($1, $2, to_timestamp($3), $4)
         ON CONFLICT (user_id, ride_id) DO UPDATE SET data = EXCLUDED.data, boarded_at = EXCLUDED.boarded_at, updated_at = now()`,
        [u.id, r.id, r.boardedAt, JSON.stringify(r)],
      );
    }
    return json({ saved: ok.map((r) => r.id), rejected: b.rides.length - ok.length });
  }),

  route("DELETE", "/v3/rides/:id", async (req, p) => {
    const u = await requireUser(req);
    if (!UUID_RE.test(p.id)) throw new ApiError(400, "érvénytelen azonosító");
    await getPool().query(`DELETE FROM ride WHERE user_id = $1 AND ride_id = $2`, [u.id, p.id]);
    return json({ ok: true });
  }),
];

export const handleRides = (req: Request) => dispatch(routes, req);
