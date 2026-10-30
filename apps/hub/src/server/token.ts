/**
 * Az MVK-token és a macOS token-agentek: állapot, előzmények, és a
 * beavatkozások (szerveroldali megújítás, kézi betöltés, parancs az agentnek:
 * MVK app újraindítása / token azonnali küldése / az agent újraindítása).
 */
import { sql } from "@mvk/db";
import { HubError } from "./http.ts";
import { callService, postJson, workerJson } from "./services.ts";

export const AGENT_COMMANDS = ["restart-app", "send-token", "restart-agent"] as const;
export type AgentCommand = (typeof AGENT_COMMANDS)[number];

type Health = { jwt: { present: boolean; exp?: number; expiresInSec?: number; expired?: boolean; installationId?: string }; lastRenew: unknown; tokenRejected: boolean };

function claimsOf(jwt: string | null): Record<string, unknown> | null {
  if (!jwt) return null;
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

const mask = (jwt: string | null) => (jwt ? `${jwt.slice(0, 14)}…${jwt.slice(-8)}` : null);

export async function tokenOverview() {
  const [health, exported, history, agents, commands] = await Promise.all([
    workerJson<Health>("/_health"),
    workerJson<{ jwt: string | null; installationId?: string; status: Record<string, unknown> }>("/_export").catch(() => null),
    sql(
      `SELECT id, source, agent_id AS "agentId", installation_id AS "installationId", iat, exp, received_at AS "receivedAt", rejected_at AS "rejectedAt"
         FROM mvk_token ORDER BY received_at DESC LIMIT 40`,
    ),
    sql<{ agentId: string; lastSeenAt: string; info: Record<string, unknown> }>(`SELECT agent_id AS "agentId", last_seen_at AS "lastSeenAt", info FROM agent_heartbeat ORDER BY last_seen_at DESC`),
    sql(
      `SELECT id, agent_id AS "agentId", kind, created_at AS "createdAt", requested_by AS "requestedBy", picked_at AS "pickedAt", picked_by AS "pickedBy", done_at AS "doneAt", ok, note,
              (picked_at IS NULL AND created_at < now() - interval '30 minutes') AS expired,
              -- felvette, de 10 perce nem nyugtázta (az agent leállt; az új agent indulás után pótolja)
              (picked_at IS NOT NULL AND done_at IS NULL AND picked_at < now() - interval '10 minutes') AS stuck
         FROM agent_command ORDER BY id DESC LIMIT 30`,
    ).catch(() => []),
  ]);
  const jwt = exported?.jwt ?? null;
  return {
    health,
    current: { masked: mask(jwt), claims: claimsOf(jwt), status: exported?.status ?? null },
    history,
    agents,
    commands,
  };
}

export async function revealToken(): Promise<string> {
  const res = await callService("worker", "/_jwt");
  if (!res.ok) throw new HubError(502, `worker: HTTP ${res.status}`);
  return (await res.text()).trim();
}

export async function renewToken() {
  const res = await callService("worker", "/_renew", { method: "POST", timeoutMs: 25_000 });
  return { ok: res.ok, ...(await res.json().catch(() => ({}))) };
}

export async function ingestToken(jwt: string, installationId: string | null) {
  const token = jwt.trim();
  if (!/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw new HubError(400, "ez nem JWT (eyJ… három ponttal elválasztott része kell)");
  return workerJson<{ ok: boolean; jwt: unknown }>("/_ingest", postJson({ jwt: token, installationId: installationId || undefined }));
}

export async function queueAgentCommand(kind: string, agentId: string | null, requestedBy: string): Promise<{ id: number }> {
  if (!(AGENT_COMMANDS as readonly string[]).includes(kind)) throw new HubError(400, "ismeretlen agent-parancs");
  if (agentId != null && !/^[\w .:@-]{1,64}$/.test(agentId)) throw new HubError(400, "érvénytelen agent-név");
  const r = await sql<{ id: number }>(`INSERT INTO agent_command (agent_id, kind, requested_by) VALUES ($1, $2, $3) RETURNING id`, [agentId, kind, requestedBy]);
  return r[0];
}

export async function cancelAgentCommand(id: number): Promise<void> {
  await sql(`UPDATE agent_command SET picked_at = now(), picked_by = 'hub', done_at = now(), ok = false, note = 'visszavonva a hubból' WHERE id = $1 AND picked_at IS NULL`, [id]);
}
