/**
 * APNs-kliens: token-alapú hitelesítés (ES256 JWT), HTTP/2 az Apple-kiszolgálóhoz.
 *
 * Új függőség nélkül: a Node beépített `http2` és `crypto` modulja elég. A JWT-t
 * ~50 percig újrahasználjuk (az Apple 20–60 perc közöttit vár; sűrűbb cserénél
 * TooManyProviderTokenUpdates-szel utasít el), a kapcsolatot kiszolgálónként
 * nyitva tartjuk, és hiba / GOAWAY után újranyitjuk.
 */
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import http2 from "node:http2";
import { apnsHost, type ApnsEnv } from "@mvk/core";
import { config } from "./config.ts";

const JWT_TTL_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type ApnsPushType = "alert" | "liveactivity";

export type ApnsRequest = {
  env: ApnsEnv;
  token: string;
  pushType: ApnsPushType;
  payload: Record<string, unknown>;
  /** unix mp; 0 = csak most kézbesíthető */
  expiration?: number;
  collapseId?: string;
  /** 10 = azonnal, 5 = energiatakarékosan */
  priority?: 5 | 10;
};

export type ApnsResult = { status: number; reason: string | null; id: string | null };

/** Ezeknél a token végleg érvénytelen: a feliratkozás törölhető (a Web Push 404/410-e). */
const GONE_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic", "ExpiredToken"]);
export const isGone = (r: ApnsResult) => r.status === 410 || (r.reason != null && GONE_REASONS.has(r.reason));

/** A .p8 tartalma; a környezeti változóban a sortörés `\n`-ként is jöhet. */
export function normalizeP8(raw: string): string {
  return raw.replace(/\\n/g, "\n").trim();
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Az Apple szolgáltatói tokenje: ES256, fejlécben a kulcs-azonosító, törzsben a csapat és a kiadás ideje. */
export function providerToken(key: KeyObject, keyId: string, teamId: string, iat: number): string {
  const head = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const body = b64url(JSON.stringify({ iss: teamId, iat }));
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64url(sig)}`;
}

export class ApnsClient {
  private key: KeyObject | null = null;
  private jwt: { value: string; at: number } | null = null;
  private sessions = new Map<string, http2.ClientHttp2Session>();
  readonly configured: boolean;

  constructor(private readonly cfg = config.apns) {
    this.configured = Boolean(cfg.keyId && cfg.teamId && cfg.key && cfg.topic);
  }

  get topic(): string {
    return this.cfg.topic;
  }

  private token(): string {
    const now = Date.now();
    if (this.jwt && now - this.jwt.at < JWT_TTL_MS) return this.jwt.value;
    this.key ??= createPrivateKey(normalizeP8(this.cfg.key));
    const value = providerToken(this.key, this.cfg.keyId, this.cfg.teamId, Math.floor(now / 1000));
    this.jwt = { value, at: now };
    return value;
  }

  private session(env: ApnsEnv): http2.ClientHttp2Session {
    const host = apnsHost(env);
    const cur = this.sessions.get(host);
    if (cur && !cur.closed && !cur.destroyed) return cur;
    const s = http2.connect(`https://${host}:443`);
    const drop = () => {
      if (this.sessions.get(host) === s) this.sessions.delete(host);
    };
    s.on("error", drop);
    s.on("goaway", drop);
    s.on("close", drop);
    // tétlen kapcsolat ne tartsa életben a folyamatot
    s.unref();
    this.sessions.set(host, s);
    return s;
  }

  send(req: ApnsRequest): Promise<ApnsResult> {
    if (!this.configured) return Promise.reject(new Error("APNs nincs beállítva"));
    const topic = req.pushType === "liveactivity" ? `${this.cfg.topic}.push-type.liveactivity` : this.cfg.topic;
    const headers: http2.OutgoingHttpHeaders = {
      ":method": "POST",
      ":path": `/3/device/${req.token}`,
      authorization: `bearer ${this.token()}`,
      "apns-topic": topic,
      "apns-push-type": req.pushType,
      "apns-priority": String(req.priority ?? 10),
      "apns-expiration": String(req.expiration ?? 0),
      "content-type": "application/json",
    };
    if (req.collapseId) headers["apns-collapse-id"] = req.collapseId;
    const body = JSON.stringify(req.payload);

    return new Promise<ApnsResult>((resolve, reject) => {
      let stream: http2.ClientHttp2Stream;
      try {
        stream = this.session(req.env).request(headers);
      } catch (e) {
        reject(e);
        return;
      }
      let status = 0;
      let id: string | null = null;
      let data = "";
      stream.setTimeout(REQUEST_TIMEOUT_MS, () => stream.close(http2.constants.NGHTTP2_CANCEL));
      stream.on("response", (h) => {
        status = Number(h[":status"] ?? 0);
        id = (h["apns-id"] as string | undefined) ?? null;
      });
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => (data += chunk));
      stream.on("end", () => {
        if (!status) {
          reject(new Error("APNs: nem jött válasz"));
          return;
        }
        let reason: string | null = null;
        if (data) {
          try {
            reason = (JSON.parse(data) as { reason?: string }).reason ?? null;
          } catch {
            reason = data.slice(0, 120);
          }
        }
        resolve({ status, reason, id });
      });
      stream.on("error", reject);
      stream.end(body);
    });
  }

  close(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}
