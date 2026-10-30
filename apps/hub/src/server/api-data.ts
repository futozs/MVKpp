/**
 * A hub API-jának adat-része: felhasználók, használat és kedvencek,
 * adatbázis, mentések, push, műveleti napló.
 */
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { audit, recentAudit } from "./audit.ts";
import { backupPath, createBackup, deleteBackup, diskUsage, listBackups, pruneAutoBackups, restoreBackup, safeName } from "./backup.ts";
import { activeQueries, cancelQuery, dailyGrowth, dbOverview } from "./dbstats.ts";
import { dockerAvailable, volumeUsage } from "./docker.ts";
import { env } from "./env.ts";
import { HubError, json, readJson, route, settle } from "./http.ts";
import { pushOverview } from "./ops.ts";
import { workerJson } from "./services.ts";
import { runningExclusive, startTask } from "./tasks.ts";
import { activitySeries, deviceDetail, favoriteLeaderboard, usageSummary } from "./usage.ts";
import { deletePasskey, deleteUser, exportUser, listUsers, revokeSessions, userDetail } from "./users.ts";

const int = (v: string | null, d: number, min: number, max: number) => {
  const n = v == null || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : d;
};

export const RESTORE_CONFIRM = "VISSZAÁLLÍT";

const userRoutes = [
  route("GET", "/api/users", async ({ url }) => json(await listUsers((url.searchParams.get("q") ?? "").trim().slice(0, 80), int(url.searchParams.get("limit"), 200, 1, 1000)))),
  route("GET", "/api/users/:id", async ({ params }) => json(await userDetail(params.id))),
  route("GET", "/api/users/:id/export", async ({ params, ip }) => {
    const data = await exportUser(params.id);
    await audit("user:export", params.id, true, null, ip);
    return new Response(JSON.stringify(data, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="mvk-felhasznalo-${params.id.slice(0, 8)}.json"`, "cache-control": "no-store" },
    });
  }),
  route("POST", "/api/users/:id/revoke-sessions", async ({ params, ip }) => {
    const n = await revokeSessions(params.id);
    await audit("user:revoke-sessions", params.id, true, { removed: n }, ip);
    return json({ removed: n });
  }),
  route("POST", "/api/users/:id/passkeys/:cred/delete", async ({ params, ip }) => {
    const n = await deletePasskey(params.id, params.cred);
    await audit("user:delete-passkey", params.id, n > 0, { cred: params.cred }, ip);
    return json({ removed: n });
  }),
  route("POST", "/api/users/:id/delete", async ({ params, req, ip }) => {
    const b = await readJson<{ confirm: string }>(req);
    const d = await userDetail(params.id);
    if (String(b.confirm ?? "").trim().toLowerCase() !== d.user.email.toLowerCase()) throw new HubError(400, "a megerősítéshez a felhasználó e-mail-címét kell beírni");
    const ok = await deleteUser(params.id);
    await audit("user:delete", d.user.email, ok, null, ip);
    return json({ ok });
  }),
];

const usageRoutes = [
  route("GET", "/api/usage", async ({ url }) => {
    const days = int(url.searchParams.get("days"), 30, 7, 365);
    const favDays = int(url.searchParams.get("favDays"), 60, 1, 365);
    const [summary, series, favorites, live] = await Promise.all([usageSummary(), activitySeries(days), settle(favoriteLeaderboard(favDays)), settle(workerJson("/system/live"))]);
    return json({ days, favDays, summary, series, favorites, live });
  }),
  route("GET", "/api/usage/devices/:id", async ({ params }) => {
    const d = await deviceDetail(params.id);
    if (!d) throw new HubError(404, "nincs ilyen eszköz");
    return json(d);
  }),
];

const dbRoutes = [
  route("GET", "/api/db", async () => {
    const [overview, growth, volumes] = await Promise.all([dbOverview(), dailyGrowth(), dockerAvailable() ? settle(volumeUsage()) : Promise.resolve(null)]);
    return json({ ...overview, growth, volumes, disk: diskUsage() });
  }),
  route("GET", "/api/db/queries", async () => json({ queries: await activeQueries() })),
  route("POST", "/api/db/queries/:pid/cancel", async ({ params, req, ip }) => {
    const b = await readJson<{ terminate: boolean }>(req);
    const ok = await cancelQuery(int(params.pid, 0, 1, 2 ** 31), b.terminate === true);
    await audit(b.terminate ? "db:terminate" : "db:cancel", params.pid, ok, null, ip);
    return json({ ok });
  }),
];

const backupRoutes = [
  route("GET", "/api/backups", () =>
    json({ backups: listBackups(), disk: diskUsage(), running: runningExclusive(), schedule: { hour: env.backupHour, keep: env.backupKeep }, dockerAvailable: dockerAvailable(), dir: env.backupDir }),
  ),
  route("POST", "/api/backups", async ({ req, ip }) => {
    const b = await readJson<{ note: string }>(req);
    const note = typeof b.note === "string" ? b.note.slice(0, 200) : undefined;
    const task = startTask("backup", `kézi mentés${note ? `: ${note}` : ""}`, ip, async (t) => {
      await createBackup(t, "manual", note);
    });
    return json({ taskId: task.id });
  }),
  route("POST", "/api/backups/prune", async ({ ip }) => {
    const removed = pruneAutoBackups(env.backupKeep);
    await audit("backup:prune", null, true, { removed }, ip);
    return json({ removed });
  }),
  route("GET", "/api/backups/:name/download", async ({ params, ip }) => {
    const p = backupPath(params.name);
    await audit("backup:download", params.name, true, null, ip);
    const body = Readable.toWeb(createReadStream(p)) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: { "content-type": "application/octet-stream", "content-length": String(statSync(p).size), "content-disposition": `attachment; filename="${safeName(params.name)}"`, "cache-control": "no-store" },
    });
  }),
  route("POST", "/api/backups/:name/delete", async ({ params, ip }) => {
    deleteBackup(params.name);
    await audit("backup:delete", params.name, true, null, ip);
    return json({ ok: true });
  }),
  route("POST", "/api/backups/:name/restore", async ({ params, req, ip }) => {
    const b = await readJson<{ confirm: string; safetyBackup: boolean; keepOld: boolean }>(req);
    if (String(b.confirm ?? "").trim() !== RESTORE_CONFIRM) throw new HubError(400, `a visszaállításhoz írd be: ${RESTORE_CONFIRM}`);
    const name = safeName(params.name);
    backupPath(name);
    const task = startTask("restore", `visszaállítás: ${name}`, ip, (t) => restoreBackup(t, name, { safetyBackup: b.safetyBackup !== false, keepOld: b.keepOld === true }));
    return json({ taskId: task.id });
  }),
];

const miscRoutes = [
  route("GET", "/api/push", async () => json(await pushOverview())),
  route("GET", "/api/audit", async ({ url }) => json({ rows: await recentAudit(int(url.searchParams.get("limit"), 100, 1, 500)) })),
];

export const dataRoutes = [...userRoutes, ...usageRoutes, ...dbRoutes, ...backupRoutes, ...miscRoutes];
