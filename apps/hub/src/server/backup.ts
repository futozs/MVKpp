/**
 * Adatbázis-mentés és -visszaállítás (pg_dump custom formátum).
 *
 * A pg_dump / pg_restore az adatbázis SAJÁT konténerében fut (docker exec),
 * így a verzió mindig egyezik a szerverével — a TimescaleDB ezt megköveteli.
 * A mentések a hub /backups kötetén vannak (a gépen: data/backups), mellettük
 * egy .json leírással.
 *
 * Visszaállítás, a lehető legkisebb kockázattal:
 *   1. friss biztonsági mentés a mostani állapotról
 *   2. a worker és a web leáll (ne írjon senki)
 *   3. a mostani adatbázis ÁTNEVEZŐDIK (nem törlődik) → mvk_pre_restore_<idő>
 *   4. új, üres adatbázis + timescaledb_pre_restore() → pg_restore → post_restore()
 *   5. ellenőrzés; ha bármi elromlik, az új törlődik és a régi visszakapja a nevét
 *   6. a worker és a web újraindul
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { closeDb, databaseUrl } from "@mvk/db";
import { containerAction, dockerAvailable, listContainers } from "./docker.ts";
import { env } from "./env.ts";
import { HubError } from "./http.ts";
import { childEnv, run, type Task } from "./tasks.ts";

export type BackupKind = "auto" | "manual" | "pre-restore" | "upload";
export type BackupMeta = { name: string; bytes: number; createdAt: string; kind: BackupKind; note?: string; durationMs?: number; dbBytes?: number | null; serverVersion?: string | null };

const NAME_RE = /^mvk-[\w.-]{1,80}\.dump$/;
const PG_MAGIC = "PGDMP";

function dir(): string {
  if (!existsSync(env.backupDir)) mkdirSync(env.backupDir, { recursive: true });
  return env.backupDir;
}

export function safeName(name: string): string {
  if (!NAME_RE.test(name) || name.includes("..")) throw new HubError(400, "érvénytelen mentésnév");
  return name;
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

export function listBackups(): BackupMeta[] {
  if (!existsSync(env.backupDir)) return [];
  return readdirSync(env.backupDir)
    .filter((f) => NAME_RE.test(f))
    .map((f) => {
      const st = statSync(join(env.backupDir, f));
      let meta: Partial<BackupMeta> = {};
      try {
        meta = JSON.parse(readFileSync(join(env.backupDir, `${f}.json`), "utf8"));
      } catch {
        /* leírás nélküli (pl. kézzel bemásolt) mentés */
      }
      return { kind: "manual" as BackupKind, ...meta, name: f, bytes: st.size, createdAt: meta.createdAt ?? st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function backupPath(name: string): string {
  const p = join(dir(), safeName(name));
  if (!existsSync(p)) throw new HubError(404, "nincs ilyen mentés");
  return p;
}

export function deleteBackup(name: string): void {
  const p = backupPath(name);
  rmSync(p);
  rmSync(`${p}.json`, { force: true });
}

export function diskUsage(): { totalGb: number; freeGb: number; usedPct: number; path: string } | null {
  try {
    const s = statfsSync(dir());
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { totalGb: Math.round((total / 1073741824) * 10) / 10, freeGb: Math.round((free / 1073741824) * 10) / 10, usedPct: total ? Math.round(((total - free) / total) * 1000) / 10 : 0, path: env.backupDir };
  } catch {
    return null;
  }
}

// ── a pg-eszközök futtatása az adatbázis konténerében ──────────────────

type Db = { user: string; password: string; name: string };

function dbParams(): Db {
  const u = new URL(databaseUrl());
  return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), name: u.pathname.replace(/^\//, "") || "postgres" };
}

async function dbContainer(): Promise<string> {
  if (env.dbContainer) return env.dbContainer;
  if (!dockerAvailable()) throw new HubError(503, "a mentéshez a Docker socket kell (vagy HUB_DB_CONTAINER)");
  const db = (await listContainers()).find((c) => c.service === "db" && c.state === "running");
  if (!db) throw new HubError(503, "az adatbázis-konténer nem fut");
  return db.name;
}

/** docker exec <db> <parancs>; a jelszót a docker CLI a saját környezetéből adja át (nem látszik a parancssorban). */
function execArgs(container: string, cmd: string[], interactive = false): string[] {
  return ["exec", ...(interactive ? ["-i"] : []), "-e", "PGPASSWORD", container, ...cmd];
}
const pgEnv = (db: Db) => childEnv({ PGPASSWORD: db.password });

const psqlCmd = (db: Db, database: string, sqlText: string) => ["psql", "-h", "127.0.0.1", "-U", db.user, "-d", database, "-v", "ON_ERROR_STOP=1", "-At", "-c", sqlText];
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function psql(task: Task, container: string, db: Db, database: string, sqlText: string, quiet = false): Promise<string> {
  return run(task, "docker", execArgs(container, psqlCmd(db, database, sqlText)), { quiet, env: pgEnv(db) });
}

// ── mentés ─────────────────────────────────────────────────────────────

export async function createBackup(task: Task, kind: BackupKind, note?: string): Promise<BackupMeta> {
  const db = dbParams();
  const container = await dbContainer();
  const name = `mvk-${stamp()}-${kind}.dump`;
  const file = join(dir(), name);
  const t0 = Date.now();
  task.step(`mentés: ${name} (konténer: ${container})`);
  const dbBytes = Number(await psql(task, container, db, db.name, "SELECT pg_database_size(current_database())", true).catch(() => "0")) || null;
  const serverVersion = (await psql(task, container, db, db.name, "SHOW server_version", true).catch(() => "")).trim() || null;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", execArgs(container, ["pg_dump", "-h", "127.0.0.1", "-U", db.user, "-d", db.name, "-Fc", "-Z", "6"]), { stdio: ["ignore", "pipe", "pipe"], env: pgEnv(db) });
      const out = createWriteStream(file);
      child.stdout.pipe(out);
      child.stderr.on("data", (c: Buffer) => task.log(c.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) => out.end(() => (code === 0 ? resolve() : reject(new Error(`pg_dump kilépési kód: ${code}`)))));
    });
  } catch (e) {
    rmSync(file, { force: true });
    throw e;
  }
  const meta: BackupMeta = { name, bytes: statSync(file).size, createdAt: new Date().toISOString(), kind, note, durationMs: Date.now() - t0, dbBytes, serverVersion };
  writeFileSync(`${file}.json`, JSON.stringify(meta, null, 2));
  task.log(`kész: ${(meta.bytes / 1048576).toFixed(1)} MB, ${Math.round((meta.durationMs ?? 0) / 1000)} mp`);
  return meta;
}

/** A régebbi automatikus mentések törlése (a kézi és a visszaállítás előtti megmarad). */
export function pruneAutoBackups(keep: number): string[] {
  const autos = listBackups().filter((b) => b.kind === "auto");
  const removed = autos.slice(Math.max(0, keep)).map((b) => b.name);
  for (const n of removed) deleteBackup(n);
  return removed;
}

// ── feltöltés ──────────────────────────────────────────────────────────

/** A feltöltés ennél több szabad helyet hagyjon a lemezen (az adatbázis is itt nő). */
const UPLOAD_HEADROOM_BYTES = 2 * 1024 ** 3;

/** Elfér-e egy `bytes` méretű feltöltés úgy, hogy marad tartalék? */
export function assertUploadFits(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) throw new HubError(411, "a feltöltéshez Content-Length kell");
  const s = statfsSync(dir());
  const free = s.bavail * s.bsize;
  if (bytes > free - UPLOAD_HEADROOM_BYTES) throw new HubError(507, `nincs elég hely: ${(bytes / 1073741824).toFixed(1)} GB kellene, ${(free / 1073741824).toFixed(1)} GB szabad (2 GB tartalékkal)`);
}

export async function saveUpload(body: ReadableStream<Uint8Array>, rawName: string): Promise<BackupMeta> {
  const base = rawName.replace(/\.dump$/i, "").replace(/[^\w.-]/g, "_").slice(0, 60) || "feltoltott";
  const name = safeName(`mvk-${stamp()}-upload-${base}.dump`);
  const file = join(dir(), name);
  await pipeline(Readable.fromWeb(body as import("node:stream/web").ReadableStream), createWriteStream(file));
  const head = Buffer.alloc(5);
  const fd = await import("node:fs/promises").then((m) => m.open(file, "r"));
  await fd.read(head, 0, 5, 0);
  await fd.close();
  if (head.toString("latin1") !== PG_MAGIC) {
    rmSync(file, { force: true });
    throw new HubError(400, "ez nem pg_dump custom formátumú mentés (PGDMP fejléc hiányzik)");
  }
  const meta: BackupMeta = { name, bytes: statSync(file).size, createdAt: new Date().toISOString(), kind: "upload", note: rawName.slice(0, 120) };
  writeFileSync(`${file}.json`, JSON.stringify(meta, null, 2));
  return meta;
}

// ── visszaállítás ──────────────────────────────────────────────────────

async function appContainers(): Promise<string[]> {
  return (await listContainers()).filter((c) => (c.service === "worker" || c.service === "web") && c.state === "running").map((c) => c.name);
}

async function restoreInto(task: Task, container: string, db: Db, file: string): Promise<void> {
  task.step("üres adatbázis + timescaledb_pre_restore()");
  await psql(task, container, db, "postgres", `CREATE DATABASE ${ident(db.name)}`);
  await psql(task, container, db, db.name, "CREATE EXTENSION IF NOT EXISTS timescaledb");
  await psql(task, container, db, db.name, "SELECT timescaledb_pre_restore()");
  task.step("pg_restore (ez a mentés méretétől függően percekig tarthat)");
  // A TimescaleDB belső objektumai miatt a pg_restore néhány „már létezik” hibát jelezhet — ezek
  // ártalmatlanok, ezért a kilépési kód helyett a végén a tényleges tartalmat ellenőrizzük.
  await run(task, "docker", execArgs(container, ["pg_restore", "-h", "127.0.0.1", "-U", db.user, "-d", db.name, "--no-owner"], true), { input: createReadStream(file), env: pgEnv(db) }).catch((e) =>
    task.log(`pg_restore figyelmeztetéssel zárult: ${e instanceof Error ? e.message : e}`, "error"),
  );
  task.step("timescaledb_post_restore() + ANALYZE");
  await psql(task, container, db, db.name, "SELECT timescaledb_post_restore()");
  await psql(task, container, db, db.name, "ANALYZE");
  const migrations = Number(await psql(task, container, db, db.name, "SELECT count(*) FROM _migration", true));
  if (!Number.isFinite(migrations) || migrations < 1) throw new Error("a visszaállított adatbázisban nincs _migration tábla — a mentés hiányos");
  task.log(`ellenőrzés rendben (${migrations} migráció)`);
}

export async function restoreBackup(task: Task, name: string, opts: { safetyBackup: boolean; keepOld: boolean }): Promise<void> {
  const file = backupPath(name);
  const db = dbParams();
  const container = await dbContainer();
  if (opts.safetyBackup) await createBackup(task, "pre-restore", `${name} visszaállítása előtt`);

  const stopped = dockerAvailable() ? await appContainers() : [];
  task.step(`a worker és a web leállítása: ${stopped.join(", ") || "(nem futnak)"}`);
  for (const c of stopped) await containerAction(c, "stop");
  await closeDb();

  const old = `${db.name}_pre_restore_${stamp().replace("-", "_")}`;
  let renamed = false;
  try {
    task.step(`a mostani adatbázis félreállítása: ${old}`);
    await psql(task, container, db, "postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${lit(db.name)} AND pid <> pg_backend_pid()`, true);
    await psql(task, container, db, "postgres", `ALTER DATABASE ${ident(db.name)} RENAME TO ${ident(old)}`);
    renamed = true;
    await restoreInto(task, container, db, file);
    if (!opts.keepOld) {
      task.step(`a félreállított adatbázis törlése: ${old}`);
      await psql(task, container, db, "postgres", `DROP DATABASE ${ident(old)}`);
    } else task.log(`a régi adatbázis megmaradt: ${old} (kézzel törölhető)`);
  } catch (e) {
    task.log(`HIBA: ${e instanceof Error ? e.message : e}`, "error");
    if (renamed) {
      task.step("visszagörgetés: a régi adatbázis visszakapja a nevét");
      await psql(task, container, db, "postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${lit(db.name)} AND pid <> pg_backend_pid()`, true).catch(() => "");
      await psql(task, container, db, "postgres", `DROP DATABASE IF EXISTS ${ident(db.name)}`).catch(() => "");
      await psql(task, container, db, "postgres", `ALTER DATABASE ${ident(old)} RENAME TO ${ident(db.name)}`);
      task.log("a régi adatbázis visszaállt, adat nem veszett el");
    }
    throw e;
  } finally {
    task.step(`a worker és a web indítása: ${stopped.join(", ") || "-"}`);
    for (const c of stopped) await containerAction(c, "start").catch((err) => task.log(`${c} nem indult: ${err instanceof Error ? err.message : err}`, "error"));
  }
}
