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
} as const;
