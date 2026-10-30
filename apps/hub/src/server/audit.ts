/** Műveleti napló: minden beavatkozás a hubból (ki, mit, honnan, sikerült-e). */
import { sql } from "@mvk/db";

export type AuditRow = { id: number; at: string; action: string; target: string | null; ok: boolean; detail: unknown; ip: string | null };

export async function audit(action: string, target: string | null, ok: boolean, detail: unknown, ip: string | null): Promise<void> {
  try {
    await sql(`INSERT INTO hub_audit (action, target, ok, detail, ip) VALUES ($1, $2, $3, $4, $5)`, [
      action,
      target,
      ok,
      detail == null ? null : JSON.stringify(detail),
      ip,
    ]);
  } catch (e) {
    // A napló hibája ne akassza meg a műveletet (pl. visszaállítás közben nincs adatbázis).
    console.warn("[hub] audit nem írható:", e instanceof Error ? e.message : e);
  }
}

export async function recentAudit(limit = 100): Promise<AuditRow[]> {
  return sql<AuditRow>(`SELECT id, at, action, target, ok, detail, ip FROM hub_audit ORDER BY at DESC LIMIT $1`, [limit]);
}
