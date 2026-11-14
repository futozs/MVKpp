/**
 * Natív iOS-értesítés (APNs)  a tiszta, hálózat nélküli rész: a végpont
 * értelmezése és a küldendő JSON-ok. A küldést a worker végzi (HTTP/2, JWT).
 *
 * Egy iPhone a push-feliratkozások között ugyanolyan sor, mint egy böngésző:
 * a végpontja `apns:<sandbox|production>:<hex eszköztoken>`, kulcsok nélkül.
 * Így a figyelések, a „Ne zavarj” és a kézbesítési napló változatlanul működik.
 */

export type ApnsEnv = "sandbox" | "production";
export type ApnsTarget = { env: ApnsEnv; token: string };

/** Az eszköztoken ma 32 bájt (64 hex), de az Apple hosszabbat is ígér  felső korláttal. */
const ENDPOINT_RE = /^apns:(sandbox|production):([0-9a-fA-F]{64,200})$/;
/** Az ActivityKit push-tokenje hosszabb (jellemzően 80+ bájt). */
const ACTIVITY_TOKEN_RE = /^[0-9a-fA-F]{64,400}$/;

export function parseApnsEndpoint(endpoint: string): ApnsTarget | null {
  const m = ENDPOINT_RE.exec(endpoint);
  return m ? { env: m[1] as ApnsEnv, token: m[2].toLowerCase() } : null;
}

export const isApnsEndpoint = (endpoint: string) => parseApnsEndpoint(endpoint) != null;

export const validActivityToken = (token: unknown): token is string => typeof token === "string" && ACTIVITY_TOKEN_RE.test(token);

export function apnsEnvOf(raw: unknown): ApnsEnv | null {
  return raw === "sandbox" || raw === "production" ? raw : null;
}

/** A kiszolgáló a végpont környezetéből: a fejlesztői build a sandboxba, a TestFlight / App Store az élesbe. */
export const apnsHost = (env: ApnsEnv) => (env === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com");

/** Ugyanaz az értesítés, ami Web Pushként megy (cím, szöveg, címke, hivatkozás). */
export type PushMessage = { title: string; body: string; tag: string; url: string };

/** Az `apns-collapse-id` legfeljebb 64 bájt: a webes címke (a Web Push `topic`-ja helyett). */
export function collapseId(tag: string): string {
  let out = "";
  for (const ch of tag) {
    if (Buffer.byteLength(out + ch, "utf8") > 64) break;
    out += ch;
  }
  return out;
}

/** A hivatkozásból a megálló (`/?stop=SP12#multistop` → `SP12`)  az app ezzel nyitja a Figyelőt. */
export function stopOfUrl(url: string): string | null {
  const m = /[?&]stop=([^&#]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Értesítés-payload: időérzékeny (a „Fókusz” is átengedi), a megállónként egy szál,
 * és a hivatkozás  ugyanoda visz, ahová a webes értesítésre koppintás.
 */
export function apnsAlertPayload(msg: PushMessage): Record<string, unknown> {
  return {
    aps: {
      alert: { title: msg.title, body: msg.body },
      sound: "default",
      "interruption-level": "time-sensitive",
      "thread-id": msg.tag,
    },
    url: msg.url,
    stopId: stopOfUrl(msg.url),
  };
}

/**
 * Az élő tevékenység (Live Activity) állapota  az iOS-app `ContentState`-je
 * pontosan ezeket a mezőket olvassa. Idők unix másodpercben, késés másodpercben
 * (pozitív = késik), a haladás 0..1 a menet megállói mentén.
 */
export type LiveActivityState = {
  tripId: string;
  /** a menetet vivő jármű (MVK: pályaszám), ha ismert */
  vehicleId: string | null;
  /** most látjuk-e élőben a járművet */
  live: boolean;
  /** 0..1 a menet első és utolsó megállója között; null, ha nincs élő jel */
  progress: number | null;
  /** mért késés most (mp); null, ha nem tudjuk */
  delaySec: number | null;
  nextStopId: string | null;
  nextStopName: string | null;
  /** a következő megálló várható ideje (menetrend + késés), unix mp */
  nextStopEtaUnix: number | null;
  /** hátralévő megállók száma (a következővel együtt) */
  stopsLeft: number | null;
  /** a feliratkozáskor megadott megálló (felszállás / leszállás) várható ideje, unix mp */
  stopEtaUnix: number | null;
  /** a feliratkozáskor megadott megálló neve (az iOS-utazásnál a leszállóhely) */
  destName: string | null;
  speedKmh: number | null;
  /** a menet véget ért (beért, vagy már nem fut) */
  ended: boolean;
  /** a szerver ekkor számolta, unix mp */
  updatedAt: number;
};

/** Két állapot ugyanazt mutatja-e (az időbélyeg nélkül)  csak változáskor küldünk. */
export function sameActivityState(a: LiveActivityState | null, b: LiveActivityState): boolean {
  if (!a) return false;
  const { updatedAt: _a, ...ra } = a;
  const { updatedAt: _b, ...rb } = b;
  return JSON.stringify(ra) === JSON.stringify(rb);
}

export function liveActivityPayload(
  event: "update" | "end",
  state: LiveActivityState,
  now: number,
  opts: { staleAfterS?: number; dismissalUnix?: number } = {},
): Record<string, unknown> {
  return {
    aps: {
      timestamp: now,
      event,
      "content-state": state,
      ...(event === "update" ? { "stale-date": now + (opts.staleAfterS ?? 120) } : {}),
      ...(opts.dismissalUnix != null ? { "dismissal-date": opts.dismissalUnix } : {}),
    },
  };
}
