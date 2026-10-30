/**
 * Mentés feltöltése (PUT, nyers törzs, akár több GB). Ez az útvonal kimarad a
 * proxy.ts alól — a proxy a kérés törzsét pufferelné és levágná —, ezért a
 * belső háló, a munkamenet és az eredet ellenőrzése itt történik.
 */
import { audit } from "@/server/audit";
import { saveUpload } from "@/server/backup";
import { env } from "@/server/env";
import { clientIp, HubError, json } from "@/server/http";
import { ipAllowed } from "@/server/netguard";
import { SESSION_COOKIE, verifySession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sessionCookie(req: Request): string | undefined {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return v.join("=");
  }
  return undefined;
}

export async function PUT(req: Request) {
  const ip = clientIp(req);
  try {
    if (!ipAllowed(ip, env.allowedCidrs)) throw new HubError(403, "csak belső hálóról");
    if (!verifySession(sessionCookie(req), env.password, env.appSecret)) throw new HubError(401, "Be kell jelentkezni.");
    const origin = req.headers.get("origin");
    if (!origin || new URL(origin).host !== req.headers.get("host")) throw new HubError(403, "idegen oldalról érkező kérés");
    if (!req.body) throw new HubError(400, "üres feltöltés");
    const name = new URL(req.url).searchParams.get("name") ?? "feltoltott.dump";
    const meta = await saveUpload(req.body, name);
    await audit("backup:upload", meta.name, true, { bytes: meta.bytes }, ip);
    return json(meta);
  } catch (e) {
    if (e instanceof HubError) return json({ error: e.message }, e.status);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
