/**
 * /push/* (v2-kompatibilis) és /v3/push/* — feliratkozás, figyelések,
 * kézbesítési napló. A tényleges küldést a worker végzi (sorral,
 * újrapróbálással); a web csak tárol és Postgres NOTIFY-jal szól.
 */
import { getPool, sql, sqlOne } from "@mvk/db";
import { ApiError, body, dispatch, json, route, type Route } from "./http.ts";
import { sessionUser } from "./account.ts";

type Sub = { endpoint?: string; keys?: { p256dh?: string; auth?: string } };

const publicKey = () => (process.env.VAPID_PUBLIC_KEY ?? "").trim();
const configured = () => Boolean(publicKey() && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
const notifyWatches = () => getPool().query(`SELECT pg_notify('mvk_events', '{"type":"push_watch"}')`);

async function upsertSub(req: Request, s: Sub | undefined, extra: { dndStart?: number | null; dndEnd?: number | null; enabled?: boolean } = {}): Promise<number> {
  const endpoint = s?.endpoint;
  const p256dh = s?.keys?.p256dh;
  const auth = s?.keys?.auth;
  if (!endpoint || !p256dh || !auth) throw new ApiError(400, "Hiányzó mező");
  if (endpoint.length > 1000 || !validPushEndpoint(endpoint)) throw new ApiError(400, "Érvénytelen push végpont");
  if (p256dh.length > 200 || auth.length > 100) throw new ApiError(400, "Érvénytelen push kulcs");
  const user = await sessionUser(req).catch(() => null);
  const r = await sqlOne<{ id: number }>(
    `INSERT INTO push_subscription (endpoint, p256dh, auth, user_id, user_agent) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_id = coalesce(EXCLUDED.user_id, push_subscription.user_id)
     RETURNING id`,
    [endpoint, p256dh, auth, user?.id ?? null, (req.headers.get("user-agent") ?? "").slice(0, 200)],
  );
  const id = r!.id;
  if ("dndStart" in extra) await getPool().query(`UPDATE push_subscription SET dnd_start_min = $2, dnd_end_min = $3 WHERE id = $1`, [id, extra.dndStart, extra.dndEnd]);
  if (extra.enabled !== undefined) await getPool().query(`UPDATE push_subscription SET enabled = $2 WHERE id = $1`, [id, extra.enabled]);
  return id;
}

const validMin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n < 1440;

/**
 * Csak a böngészők valódi push-szolgáltatásaira küldünk (Chrome/Edge/Samsung/Opera: FCM,
 * Firefox: Mozilla, régi Edge: WNS, Safari/iOS: Apple). Egy tetszőleges https-cím
 * különben a worker nevében hívatna meg belső címeket (SSRF).
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];
function validPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}
const STOP_ID_RE = /^[\w:.-]{1,32}$/;
const TRIP_ID_RE = /^[\w:.-]{1,80}$/;
const MAX_WATCHES_PER_SUB = 60;
const KINDS = new Set(["arrival", "leave", "traffic", "transfer"]);

type WatchParams = {
  date?: string;
  walkS?: number;
  days?: string | number[];
  fromTrip?: string;
  alightStopId?: string;
  fromRoute?: string;
  toRoute?: string;
  boardStopName?: string;
  /** a figyelés módjai („tram,bus,coach,rail” részhalmaza); hiányában MVK-megállónál csak MVK */
  modes?: string;
};

/** „rail,tram” → rendezett, ismert módok vesszővel; ismeretlen / üres → nincs megadva */
function cleanModes(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const known = ["tram", "bus", "coach", "rail"];
  const list = [...new Set(raw.split(",").map((x) => x.trim().toLowerCase()))].filter((x) => known.includes(x));
  return list.length ? known.filter((x) => list.includes(x)).join(",") : undefined;
}

/** A fajtához tartozó paraméterek ellenőrzése (csak az ismert mezők, korlátozva). */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanParams(kind: string, p: WatchParams | undefined): WatchParams | null {
  // egyszeri menet-figyelés: csak erre a szolgáltatási napra (a menetazonosítók naponta ismétlődnek)
  const modes = cleanModes(p?.modes);
  if (kind === "arrival") {
    const out: WatchParams = {};
    if (typeof p?.date === "string" && DATE_RE.test(p.date)) out.date = p.date;
    if (modes) out.modes = modes;
    return Object.keys(out).length ? out : null;
  }
  const out: WatchParams = modes ? { modes } : {};
  if (p?.walkS != null) {
    const w = Number(p.walkS);
    if (!Number.isFinite(w) || w < 0 || w > 3600) throw new ApiError(400, "Érvénytelen sétaidő");
    out.walkS = Math.round(w);
  }
  if (p?.days != null) {
    // munkanap / hétvége / mind, vagy a hét napjai (ISO: 1 = hétfő … 7 = vasárnap)
    if (Array.isArray(p.days)) {
      const dows = [...new Set(p.days.map(Number))].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort((a, b) => a - b);
      if (!dows.length || dows.length !== p.days.length) throw new ApiError(400, "Érvénytelen napok");
      out.days = dows;
    } else if (typeof p.days === "string" && ["workday", "weekend", "all"].includes(p.days)) out.days = p.days;
    else throw new ApiError(400, "Érvénytelen napok");
  }
  if (kind === "transfer") {
    if (!p?.fromTrip || !TRIP_ID_RE.test(p.fromTrip) || !p.alightStopId || !STOP_ID_RE.test(p.alightStopId)) throw new ApiError(400, "Hiányos átszállás");
    out.fromTrip = p.fromTrip;
    out.alightStopId = p.alightStopId;
  }
  for (const k of ["fromRoute", "toRoute"] as const) if (typeof p?.[k] === "string") out[k] = p[k]!.slice(0, 8);
  if (typeof p?.boardStopName === "string") out.boardStopName = p.boardStopName.slice(0, 128);
  return out;
}

const routes: Route[] = [
  route("GET", "/push/vapid-public-key", () => json({ publicKey: configured() ? publicKey() : null })),

  route("POST", "/push/watch", async (req) => {
    if (!configured()) throw new ApiError(503, "A push-értesítés nincs beállítva a szerveren");
    const b = await body<{
      subscription?: Sub;
      stopId?: string;
      stopName?: string;
      thresholdMin?: number;
      routeShorts?: string[];
      tripId?: string;
      isDeparture?: boolean;
      schedMin?: number;
      slot?: string;
      kind?: string;
      params?: WatchParams;
    }>(req);
    if (!b?.stopId || !b.stopName) throw new ApiError(400, "Hiányzó mező");
    if (!STOP_ID_RE.test(b.stopId) || (b.tripId != null && (typeof b.tripId !== "string" || !TRIP_ID_RE.test(b.tripId)))) throw new ApiError(400, "Érvénytelen megálló vagy menet");
    const kind = b.kind ?? "arrival";
    if (!KINDS.has(kind)) throw new ApiError(400, "Ismeretlen értesítés-fajta");
    if (kind === "transfer" && !b.tripId) throw new ApiError(400, "Az átszálláshoz menet kell");
    const params = cleanParams(kind, b.params);
    const subId = await upsertSub(req, b.subscription);
    const count = await sqlOne<{ n: number; same: boolean }>(
      `SELECT count(*)::int AS n, bool_or(stop_id = $2 AND slot = $3) AS same FROM push_watch WHERE subscription_id = $1`,
      [subId, b.stopId, (b.slot ?? "default").slice(0, 64)],
    );
    // Meglévő figyelés módosítása mindig mehet; újat csak a korlátig.
    if ((count?.n ?? 0) >= MAX_WATCHES_PER_SUB && !count?.same) throw new ApiError(429, `Egy eszközön legfeljebb ${MAX_WATCHES_PER_SUB} figyelés lehet`);
    const threshold = Math.max(1, Math.min(60, Number(b.thresholdMin) || 5));
    const routes = Array.isArray(b.routeShorts) && b.routeShorts.length ? b.routeShorts.map((r) => String(r).slice(0, 8)).slice(0, 30) : null;
    const schedMin = validMin(b.schedMin) ? Math.round(b.schedMin) : null;
    const tripId = schedMin == null ? (b.tripId ?? null) : null;
    const slot = (b.slot ?? "default").slice(0, 64);
    await getPool().query(
      `INSERT INTO push_watch (subscription_id, slot, stop_id, stop_name, threshold_min, route_shorts, trip_id, sched_min, is_departure, kind, params)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (subscription_id, stop_id, slot) DO UPDATE SET stop_name = EXCLUDED.stop_name, threshold_min = EXCLUDED.threshold_min,
         route_shorts = EXCLUDED.route_shorts, trip_id = EXCLUDED.trip_id, sched_min = EXCLUDED.sched_min, is_departure = EXCLUDED.is_departure,
         kind = EXCLUDED.kind, params = EXCLUDED.params, updated_at = now()`,
      [subId, slot, b.stopId, b.stopName.slice(0, 128), threshold, routes, tripId, schedMin, Boolean(b.isDeparture), kind, params ? JSON.stringify(params) : null],
    );
    await notifyWatches();
    return json({ ok: true });
  }),

  route("POST", "/push/dnd", async (req) => {
    const b = await body<{ subscription?: Sub; dndEnabled?: boolean; dndStartMin?: number; dndEndMin?: number }>(req);
    const on = b?.dndEnabled === true;
    const start = on && validMin(b?.dndStartMin) ? Math.round(b!.dndStartMin!) : null;
    const end = on && validMin(b?.dndEndMin) ? Math.round(b!.dndEndMin!) : null;
    await upsertSub(req, b?.subscription, { dndStart: start, dndEnd: end });
    await notifyWatches();
    return json({ ok: true, dnd: start != null && end != null ? { startMin: start, endMin: end } : null });
  }),

  route("POST", "/push/enabled", async (req) => {
    const b = await body<{ subscription?: Sub; enabled?: boolean }>(req);
    const enabled = b?.enabled !== false;
    await upsertSub(req, b?.subscription, { enabled });
    await notifyWatches();
    return json({ ok: true, enabled });
  }),

  route("DELETE", "/push/watch", async (req) => {
    const b = await body<{ endpoint?: string; stopId?: string; slot?: string }>(req);
    if (!b?.endpoint || !b.stopId) throw new ApiError(400, "Hiányzó mező");
    await getPool().query(
      `DELETE FROM push_watch w USING push_subscription s WHERE s.id = w.subscription_id AND s.endpoint = $1 AND w.stop_id = $2 AND ($3::text IS NULL OR w.slot = $3)`,
      [b.endpoint, b.stopId, b.slot ?? null],
    );
    await notifyWatches();
    return json({ ok: true });
  }),

  // ── v3 ────────────────────────────────────────────────────────────────
  route("POST", "/v3/push/state", async (req) => {
    // Az eszköz figyelései + az utolsó 30 kézbesítés (mi ment ki, mi nem és miért).
    const b = await body<{ endpoint?: string }>(req);
    if (!b?.endpoint) throw new ApiError(400, "hiányzó endpoint");
    const sub = await sqlOne<{ id: number; enabled: boolean; dnd_start_min: number | null; dnd_end_min: number | null; last_success_at: Date | null; fail_count: number }>(
      `SELECT id, enabled, dnd_start_min, dnd_end_min, last_success_at, fail_count FROM push_subscription WHERE endpoint = $1`,
      [b.endpoint],
    );
    if (!sub) return json({ known: false, configured: configured(), watches: [], deliveries: [] });
    const watches = await sql(
      `SELECT id, slot, kind, params, stop_id, stop_name, threshold_min, route_shorts, trip_id, sched_min, is_departure, updated_at FROM push_watch WHERE subscription_id = $1 ORDER BY stop_name`,
      [sub.id],
    );
    const deliveries = await sql(
      `SELECT d.id, d.kind, d.status, d.attempts, d.last_error, d.payload->>'title' AS title, d.payload->>'body' AS body, d.created_at, d.sent_at, w.stop_name
         FROM push_delivery d JOIN push_watch w ON w.id = d.watch_id WHERE w.subscription_id = $1 ORDER BY d.created_at DESC LIMIT 30`,
      [sub.id],
    );
    return json({ known: true, configured: configured(), subscription: sub, watches, deliveries });
  }),

  route("DELETE", "/v3/push/watch", async (req) => {
    const b = await body<{ endpoint?: string; id?: number }>(req);
    if (!b?.endpoint || !b.id) throw new ApiError(400, "Hiányzó mező");
    await getPool().query(`DELETE FROM push_watch w USING push_subscription s WHERE s.id = w.subscription_id AND s.endpoint = $1 AND w.id = $2`, [b.endpoint, b.id]);
    await notifyWatches();
    return json({ ok: true });
  }),
];

export const handlePush = (req: Request) => dispatch(routes, req);
