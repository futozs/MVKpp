/**
 * A hub háttérmunkái (a szerver indulásakor egyszer, az instrumentation.ts-ből):
 *   - 30 mp-enként válaszidő-mérés
 *   - óránként a régi mérések törlése
 *   - 30 percenként git fetch (a „frissítés elérhető” jelzéshez)
 *   - naponta automatikus adatbázis-mentés (HUB_BACKUP_HOUR, Budapest), a régiek ritkítása
 */
import { createBackup, listBackups, pruneAutoBackups } from "./backup.ts";
import { gitFetch, gitStatus } from "./deploy.ts";
import { dockerAvailable } from "./docker.ts";
import { env } from "./env.ts";
import { cleanupProbes, runProbes } from "./probes.ts";
import { runningExclusive, startTask } from "./tasks.ts";

const HOUR_MS = 3_600_000;
const g = globalThis as { __hubScheduler?: boolean };

function budapestNow(): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Budapest", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

function every(ms: number, fn: () => Promise<unknown>, firstAfterMs = ms): void {
  const tick = () =>
    fn().catch((e) => console.warn("[scheduler]", e instanceof Error ? e.message : e));
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), ms).unref();
  }, firstAfterMs).unref();
}

async function autoBackup(): Promise<void> {
  if (env.backupHour < 0 || !dockerAvailable() || runningExclusive()) return;
  const now = budapestNow();
  if (now.hour !== env.backupHour) return;
  const doneToday = listBackups().some((b) => b.kind === "auto" && b.createdAt.startsWith(now.day.slice(0, 10)));
  if (doneToday) return;
  startTask("backup", "automatikus napi mentés", "ütemező", async (t) => {
    await createBackup(t, "auto");
    const removed = pruneAutoBackups(env.backupKeep);
    if (removed.length) t.log(`régi automatikus mentések törölve: ${removed.join(", ")}`);
  });
}

export function startScheduler(): void {
  if (g.__hubScheduler) return;
  g.__hubScheduler = true;
  every(env.probeEveryMs, runProbes, 5_000);
  every(HOUR_MS, cleanupProbes, 60_000);
  every(30 * 60_000, async () => {
    if ((await gitStatus()).available) await gitFetch();
  }, 90_000);
  every(5 * 60_000, autoBackup, 2 * 60_000);
  console.log(`[scheduler] fut — mérés ${Math.round(env.probeEveryMs / 1000)} mp-enként, napi mentés ${env.backupHour >= 0 ? `${env.backupHour} órakor` : "kikapcsolva"}`);
}
