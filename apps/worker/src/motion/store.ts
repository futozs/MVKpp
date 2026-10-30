/** A tanított mozgás-modellek tárolása (ml_model tábla, „motion” néven). */
import { getPool, sql } from "@mvk/db";
import { isMotionBundle, MOTION_MODEL_NAME, type MotionModelBundle } from "./train.ts";

/** ennyi korábbi modellt tartunk meg (a profil miatt egy-egy pár MB) */
const KEEP = 5;

export async function saveMotionBundle(b: MotionModelBundle): Promise<{ id: number; accepted: boolean }> {
  const { report, ...model } = b;
  const r = await getPool().query<{ id: number }>(
    `INSERT INTO ml_model (name, accepted, report, model) VALUES ($1, $2, $3, $4) RETURNING id`,
    [b.name, report.accepted, JSON.stringify(report), JSON.stringify(model)],
  );
  // A legfrissebb ELFOGADOTT modell sosem törlődik (több elutasított tanítás után is ez él tovább).
  await getPool().query(
    `DELETE FROM ml_model WHERE name = $1
        AND id NOT IN (SELECT id FROM ml_model WHERE name = $1 ORDER BY trained_at DESC LIMIT $2)
        AND id NOT IN (SELECT id FROM ml_model WHERE name = $1 AND accepted ORDER BY trained_at DESC LIMIT 1)`,
    [b.name, KEEP],
  );
  return { id: r.rows[0].id, accepted: report.accepted };
}

/** A legfrissebb elfogadott modell (vagy null, ha nincs / sérült). */
export async function loadMotionBundle(): Promise<MotionModelBundle | null> {
  const rows = await sql<{ report: unknown; model: Record<string, unknown> }>(
    `SELECT report, model FROM ml_model WHERE name = $1 AND accepted ORDER BY trained_at DESC LIMIT 1`,
    [MOTION_MODEL_NAME],
  );
  if (!rows[0]) return null;
  const b = { ...rows[0].model, report: rows[0].report };
  return isMotionBundle(b) ? b : null;
}

/** Az utolsó tanítás jelentése (elfogadott vagy sem) — az állapotlekérdezéshez. */
export async function latestMotionReport(): Promise<{ trainedAt: string; accepted: boolean; report: unknown } | null> {
  const rows = await sql<{ trained_at: Date; accepted: boolean; report: unknown }>(
    `SELECT trained_at, accepted, report FROM ml_model WHERE name = $1 ORDER BY trained_at DESC LIMIT 1`,
    [MOTION_MODEL_NAME],
  );
  return rows[0] ? { trainedAt: rows[0].trained_at.toISOString(), accepted: rows[0].accepted, report: rows[0].report } : null;
}
