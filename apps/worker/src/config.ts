/** A worker beállításai — minden környezeti változóból, értelmes alapértékkel. */
const num = (v: string | undefined, d: number) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

export const config = {
  port: num(process.env.WORKER_PORT, 8090),
  host: process.env.WORKER_HOST ?? "0.0.0.0",
  mvkApi: process.env.MVK_API ?? "https://mccaze.mvkzrt.hu:8443",
  gtfsUrl: process.env.MVK_GTFS_URL ?? "http://84.206.68.21:8080/MVK_mobilapp/GTFS/MVK_GTFS.zip",
  /** pozíció + előrejelzés lekérdezése (ms) — a járművek ~15 mp-enként adnak új fixet */
  pollMs: num(process.env.POLL_MS, 2500),
  cancelledMs: num(process.env.CANCELLED_MS, 30_000),
  gtfsCheckMs: num(process.env.GTFS_CHECK_MS, 30 * 60_000),
  weatherMs: num(process.env.WEATHER_MS, 10 * 60_000),
  /** a token ennyivel a lejárat előtt megújítandó (mp) */
  renewMarginSec: num(process.env.RENEW_MARGIN_SEC, 20 * 60),
  adminKey: process.env.ADMIN_KEY ?? "",
  agentSecret: process.env.AGENT_SECRET ?? "",
  /** fejlesztéshez: GTFS induló feed, ha az adatbázis még üres */
  bootstrapGtfs: process.env.BOOTSTRAP_GTFS ?? "",
  /** ha "0", nem pollozza az MVK-t (pl. replay vagy teszt közben) */
  ingest: process.env.INGEST !== "0",
  vapid: {
    publicKey: (process.env.VAPID_PUBLIC_KEY ?? "").trim(),
    privateKey: (process.env.VAPID_PRIVATE_KEY ?? "").trim(),
    subject: (process.env.VAPID_SUBJECT ?? "").trim(),
  },
  weather: { lat: 48.104, lon: 20.79 },
  /** MÁV+ OTP2: a Volán és a vasút, és az MVK tartaléka (docs/MAVPLUSZ_OTP2.md) */
  otp2: {
    enabled: process.env.OTP2_ENABLED !== "0",
    url: process.env.OTP2_URL ?? "https://mavplusz.hu/otp2-backend/otp/routers/default/index/graphql",
    userAgent: process.env.OTP2_USER_AGENT ?? "mvk-zsombi-modra/3 (+https://mvk.futozs.hu)",
    /** a regionális járművek lekérdezése (ms) — az OTP2 adata maga is 20–60 mp-enként frissül */
    pollMs: num(process.env.OTP2_POLL_MS, 15_000),
    /** tartalék üzemben az MVK-járművek miatt sűrűbben */
    fallbackPollMs: num(process.env.OTP2_FALLBACK_POLL_MS, 10_000),
    alertsMs: num(process.env.OTP2_ALERTS_MS, 120_000),
    /** a figyelt állomások táblája (vágány, késés még el nem indult vonatra) */
    boardsMs: num(process.env.OTP2_BOARDS_MS, 60_000),
    /** a Volán és a vasút (a menetrend és a valós idő); "0" = csak az MVK-tartalék */
    regional: process.env.REGIONAL !== "0",
    /** ennyi napra előre épül a regionális menetrend */
    daysAhead: num(process.env.REGIONAL_DAYS_AHEAD, 2),
  },
  /** az MVK → MÁV+ átállás: tokenhiba (401/403) azonnal, kiesés ennyi idő után; vissza ennyi jó poll után */
  fallback: {
    outageMs: num(process.env.FALLBACK_OUTAGE_MS, 60_000),
    recoverPolls: num(process.env.FALLBACK_RECOVER_POLLS, 5),
  },
} as const;
