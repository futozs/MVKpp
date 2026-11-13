/** A tanított késés-modellek tárolása (ml_model tábla). */
import { getPool, sql } from "@mvk/db";
import { bundleAccepted, DELAY_MODEL_NAME, isDelayBundle, type DelayModelBundle } from "./train.ts";

/** ennyi korábbi modellt tartunk meg (visszakereséshez, összevetéshez) */
const KEEP = 14;

export async function saveBundle(b: DelayModelBundle): Promise<{ id: number; accepted: boolean }> {
  const accepted = bundleAccepted(b);
  const { report, ...model } = b;
  const r = await getPool().query<{ id: number }>(
    `INSERT INTO ml_model (name, accepted, report, model) VALUES ($1, $2, $3, $4) RETURNING id`,
    [b.name, accepted, JSON.stringify(report), JSON.stringify(model)],
  );
  await getPool().query(
    `DELETE FROM ml_model WHERE name = $1 AND id NOT IN (SELECT id FROM ml_model WHERE name = $1 ORDER BY trained_at DESC LIMIT $2)`,
    [b.name, KEEP],
  );
  return { id: r.rows[0].id, accepted };
}

/** A legfrissebb elfogadott modell (vagy null, ha nincs / sérült). */
export async function loadLatestBundle(): Promise<DelayModelBundle | null> {
  const rows = await sql<{ report: unknown; model: Record<string, unknown> }>(
    `SELECT report, model FROM ml_model WHERE name = $1 AND accepted ORDER BY trained_at DESC LIMIT 1`,
    [DELAY_MODEL_NAME],
  );
  if (!rows[0]) return null;
  const b = { ...rows[0].model, report: rows[0].report };
  return isDelayBundle(b) ? b : null;
}

/** Az utolsó tanítás jelentése (elfogadott vagy sem)  az állapotlekérdezéshez. */
export async function latestReport(): Promise<{ trainedAt: string; accepted: boolean; report: unknown } | null> {
  const rows = await sql<{ trained_at: Date; accepted: boolean; report: unknown }>(
    `SELECT trained_at, accepted, report FROM ml_model WHERE name = $1 ORDER BY trained_at DESC LIMIT 1`,
    [DELAY_MODEL_NAME],
  );
  return rows[0] ? { trainedAt: rows[0].trained_at.toISOString(), accepted: rows[0].accepted, report: rows[0].report } : null;
}
