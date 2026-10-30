/**
 * Frissítés és újratelepítés a hubból.
 *
 * A git-állapotot a felcsatolt repóból olvassuk (/repo), a repó tulajdonosának
 * nevében (különben root-tulajdonú fájlok kerülnének a .git-be). Maga a
 * telepítés egy külön, leválasztott segédkonténerben fut, amelyben a repó a
 * GAZDAGÉPEN érvényes útvonalán van felcsatolva — így a Compose minden relatív
 * útvonalat (Caddyfile, a hub kötetei) pontosan úgy old fel, mint a gépen
 * kézzel futtatva, és a hub a végén önmagát is lecserélheti: a segéd túléli.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { dockerAvailable, inspectContainer, streamContainerLogs, type ContainerDetail } from "./docker.ts";
import { env } from "./env.ts";
import { HubError } from "./http.ts";
import { childEnv, run, type Task } from "./tasks.ts";

const pExecFile = promisify(execFile);
const DEPLOY_LABEL = "mvk.hub.deploy";
export const DEPLOYABLE = ["worker", "web", "hub"] as const;
export type Deployable = (typeof DEPLOYABLE)[number];

export type Commit = { sha: string; short: string; subject: string; author: string; date: string };
export type GitStatus = {
  available: boolean;
  reason?: string;
  branch?: string;
  head?: Commit;
  dirty?: string[];
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  incoming?: Commit[];
  lastFetchAt?: string | null;
};

function repoOwner(): { uid: number; gid: number } | null {
  try {
    const s = statSync(env.repoDir);
    return { uid: s.uid, gid: s.gid };
  } catch {
    return null;
  }
}

/** Rootként futva a repó tulajdonosaként indítjuk a gitet. */
function asOwner(): { uid?: number; gid?: number } {
  const o = repoOwner();
  if (!o || process.getuid?.() !== 0 || o.uid === 0) return {};
  return { uid: o.uid, gid: o.gid };
}

/** A GitHub-token a git környezetében (GIT_CONFIG_*), nem a parancssorban — így a folyamatlistában sem látszik. */
function authEnv(): Record<string, string> {
  if (!env.gitToken) return {};
  const basic = Buffer.from(`x-access-token:${env.gitToken}`).toString("base64");
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` };
}

async function git(args: string[], timeoutMs = 20_000, withAuth = false): Promise<string> {
  const owner = asOwner();
  try {
    const { stdout } = await pExecFile("git", ["-c", "safe.directory=*", ...args], {
      cwd: env.repoDir,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      // Más felhasználó nevében a root HOME-ja nem olvasható; saját néven (fejlesztés) a saját git-beállítás él.
      env: childEnv({ GIT_TERMINAL_PROMPT: "0", ...(owner.uid != null ? { HOME: "/tmp" } : {}), ...(withAuth ? authEnv() : {}) }),
      ...owner,
    });
    return stdout.trim();
  } catch (e) {
    const msg = (e as { stderr?: string }).stderr || (e instanceof Error ? e.message : String(e));
    if (/could not read Username|Authentication failed|terminal prompts disabled/i.test(msg)) {
      throw new HubError(502, "a git-repó hitelesítést kér (privát repó?) — állítsd be a HUB_GIT_TOKEN-t (GitHub fine-grained token, Contents: read)");
    }
    throw new HubError(502, `git ${args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? ""}: ${msg.trim().split("\n").slice(-2).join(" ")}`);
  }
}

const SEP = "\u001f";
const FORMAT = ["%H", "%h", "%s", "%an", "%cI"].join(SEP);

function parseCommits(out: string): Commit[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, short, subject, author, date] = l.split(SEP);
      return { sha, short, subject, author, date };
    });
}

export async function gitStatus(): Promise<GitStatus> {
  try {
    statSync(join(env.repoDir, ".git"));
  } catch {
    return { available: false, reason: `nincs git-repó itt: ${env.repoDir} (a hub konténerébe a repót /repo-ra kell csatolni)` };
  }
  try {
    const [branch, head, dirty] = await Promise.all([git(["rev-parse", "--abbrev-ref", "HEAD"]), git(["log", "-1", `--format=${FORMAT}`]), git(["status", "--porcelain"])]);
    const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(() => null);
    let ahead = 0;
    let behind = 0;
    let incoming: Commit[] = [];
    if (upstream) {
      const counts = (await git(["rev-list", "--left-right", "--count", `HEAD...${upstream}`])).split(/\s+/).map(Number);
      ahead = counts[0] ?? 0;
      behind = counts[1] ?? 0;
      if (behind) incoming = parseCommits(await git(["log", `--format=${FORMAT}`, "-n", "40", `HEAD..${upstream}`]));
    }
    let lastFetchAt: string | null = null;
    try {
      lastFetchAt = statSync(join(env.repoDir, ".git", "FETCH_HEAD")).mtime.toISOString();
    } catch {
      /* még nem volt fetch */
    }
    return {
      available: true,
      branch,
      head: parseCommits(head)[0],
      dirty: dirty.split("\n").filter(Boolean).slice(0, 50),
      upstream,
      ahead,
      behind,
      incoming,
      lastFetchAt,
    };
  } catch (e) {
    return { available: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function gitFetch(): Promise<string> {
  return git(["fetch", "--prune", "origin"], 60_000, true);
}

export async function recentCommits(n = 15): Promise<Commit[]> {
  return parseCommits(await git(["log", `--format=${FORMAT}`, "-n", String(n)]));
}

// ── telepítés ──────────────────────────────────────────────────────────

type SelfInfo = { image: string; hostRepo: string; sockGid: number; owner: { uid: number; gid: number } };

async function selfInfo(): Promise<SelfInfo> {
  if (!dockerAvailable()) throw new HubError(503, "a telepítéshez a Docker socket kell (a hub konténerében)");
  let me: ContainerDetail;
  try {
    me = await inspectContainer(hostname());
  } catch {
    throw new HubError(503, "a hub nem Docker-konténerben fut — a telepítés csak ott érhető el");
  }
  const repo = me.mounts.find((m) => m.destination === env.repoDir);
  if (!repo) throw new HubError(503, `a repó nincs felcsatolva a hubba (${env.repoDir})`);
  const owner = repoOwner();
  if (!owner) throw new HubError(503, "a repó nem olvasható");
  return { image: me.image, hostRepo: repo.source, sockGid: statSync(env.dockerSock).gid, owner };
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A segédkonténerben futó szkript: git pull → build → worker/web csere → egészség → hub csere. */
export function deployScript(opts: { pull: boolean; services: Deployable[]; composeFile: string; envFile: string; project: string }): string {
  const dc = `docker compose -p ${shq(opts.project)} -f ${shq(opts.composeFile)} --env-file ${shq(opts.envFile)}`;
  const others = opts.services.filter((s) => s !== "hub");
  const lines = [
    "set -eu",
    'echo "▸ telepítés indul: $(date -Iseconds)"',
    "git config --global --add safe.directory '*' 2>/dev/null || true",
  ];
  if (opts.pull) {
    lines.push(
      'echo "▸ git pull"',
      'if [ -n "${GIT_TOKEN:-}" ]; then AUTH="Authorization: Basic $(printf \'x-access-token:%s\' "$GIT_TOKEN" | base64 | tr -d \'\\n\')"; git -c "http.extraHeader=$AUTH" pull --ff-only; else git pull --ff-only; fi',
      'echo "  most: $(git log -1 --format=\'%h %s\')"',
    );
  }
  lines.push(`echo "▸ build: ${opts.services.join(" ")}"`, `${dc} build ${opts.services.join(" ")}`);
  if (others.length) {
    lines.push(
      `echo "▸ csere: ${others.join(" ")}"`,
      `${dc} up -d --no-deps ${others.join(" ")}`,
      'echo "▸ várakozás az egészséges állapotra"',
      `for s in ${others.join(" ")}; do`,
      `  id=$(${dc} ps -q "$s"); n=0`,
      '  while [ "$n" -lt 60 ]; do',
      `    st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo "?")`,
      '    case "$st" in healthy|running) echo "  $s: $st"; break;; unhealthy|exited|dead) echo "  $s: $st — HIBA"; exit 1;; esac',
      "    n=$((n+1)); sleep 3",
      "  done",
      "done",
    );
  }
  if (opts.services.includes("hub")) lines.push('echo "▸ a hub cseréje (a pult pár másodpercre eltűnik)"', `${dc} up -d --no-deps hub`);
  lines.push('echo "▸ kész: $(date -Iseconds)"');
  return lines.join("\n");
}

export async function redeploy(task: Task, opts: { pull: boolean; services: Deployable[] }): Promise<void> {
  const me = await selfInfo();
  const name = `mvk-hub-deploy-${Date.now()}`;
  task.step(`segédkonténer: ${name} (${me.image})`);
  const script = deployScript({ ...opts, composeFile: env.composeFile, envFile: env.composeEnvFile, project: env.composeProject });
  await run(task, "docker", [
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `${DEPLOY_LABEL}=1`,
    "--user",
    `${me.owner.uid}:${me.owner.gid}`,
    "--group-add",
    String(me.sockGid),
    "-e",
    "HOME=/tmp",
    "-e",
    "GIT_TOKEN",
    "-v",
    `${env.dockerSock}:/var/run/docker.sock`,
    "-v",
    `${me.hostRepo}:${me.hostRepo}`,
    "-w",
    me.hostRepo,
    "--entrypoint",
    "sh",
    me.image,
    "-c",
    script,
  ], { quiet: true, env: childEnv({ GIT_TOKEN: env.gitToken }) });
  try {
    await followHelper(task, name);
  } finally {
    await archiveHelper(name).catch((e) => task.log(`a segédkonténer naplója nem menthető: ${e instanceof Error ? e.message : e}`, "error"));
  }
}

async function followHelper(task: Task, name: string): Promise<void> {
  const ctl = new AbortController();
  await streamContainerLogs(name, { tail: 1000, follow: true, signal: ctl.signal }, (_s, line) => task.log(line.replace(/^\S+Z /, "")));
  const end = await inspectContainer(name);
  if (end.exitCode !== 0) throw new Error(`a telepítés hibával állt le (kilépési kód: ${end.exitCode})`);
}

// A lefutott segédkonténer naplója fájlba kerül, maga a konténer törlődik (a környezetében ott a git-token).
const historyDir = () => join(env.backupDir, "deploy-logs");
const HISTORY_KEEP = 20;
type DeployRecord = { name: string; exitCode: number | null; state: string; createdAt: number };

async function archiveHelper(name: string): Promise<void> {
  const d = await inspectContainer(name);
  if (d.state === "running") return;
  const lines: string[] = [];
  await streamContainerLogs(name, { tail: 5000, follow: false, signal: new AbortController().signal }, (_s, l) => lines.push(l.replace(/^\S+Z /, "")));
  if (!existsSync(historyDir())) mkdirSync(historyDir(), { recursive: true });
  const rec: DeployRecord = { name, exitCode: d.exitCode, state: d.state, createdAt: d.createdAt };
  writeFileSync(join(historyDir(), `${name}.json`), JSON.stringify({ ...rec, lines }));
  await pExecFile("docker", ["rm", "-f", name], { timeout: 15_000, env: childEnv() });
}

/**
 * Ütemezett takarítás (nem GET-ből): a befejezett segédkonténerek naplója fájlba,
 * a konténer törlődik; a régi naplófájlok közül az utolsó 20 marad.
 */
export async function sweepDeployHelpers(): Promise<void> {
  if (!dockerAvailable()) return;
  const out = await pExecFile("docker", ["ps", "-a", "--filter", `label=${DEPLOY_LABEL}=1`, "--format", "{{.Names}}"], { timeout: 15_000, env: childEnv() });
  for (const n of out.stdout.split("\n").filter(Boolean)) await archiveHelper(n).catch(() => {});
  if (!existsSync(historyDir())) return;
  const files = readdirSync(historyDir()).filter((f) => /^mvk-hub-deploy-\d+\.json$/.test(f)).sort().reverse();
  for (const f of files.slice(HISTORY_KEEP)) rmSync(join(historyDir(), f), { force: true });
}

/** Az előző telepítések: a még futó segédkonténer(ek) és a mentett naplók. Mellékhatás nélkül. */
export async function previousDeploys(): Promise<DeployRecord[]> {
  const running: DeployRecord[] = [];
  if (dockerAvailable()) {
    const out = await pExecFile("docker", ["ps", "--filter", `label=${DEPLOY_LABEL}=1`, "--format", "{{.Names}}"], { timeout: 15_000, env: childEnv() }).catch(() => ({ stdout: "" }));
    for (const n of out.stdout.split("\n").filter(Boolean)) running.push({ name: n, exitCode: null, state: "running", createdAt: Number(n.split("-").pop()) || Date.now() });
  }
  const saved: DeployRecord[] = [];
  if (existsSync(historyDir())) {
    for (const f of readdirSync(historyDir()).filter((x) => /^mvk-hub-deploy-\d+\.json$/.test(x))) {
      try {
        const r = JSON.parse(readFileSync(join(historyDir(), f), "utf8")) as DeployRecord;
        saved.push({ name: r.name, exitCode: r.exitCode, state: r.state, createdAt: r.createdAt });
      } catch {
        /* sérült naplófájl — kihagyjuk */
      }
    }
  }
  return [...running, ...saved].sort((a, b) => b.createdAt - a.createdAt).slice(0, HISTORY_KEEP);
}

export async function deployLogs(name: string): Promise<string[]> {
  if (!/^mvk-hub-deploy-\d+$/.test(name)) throw new HubError(400, "ismeretlen telepítés");
  const file = join(historyDir(), `${name}.json`);
  if (existsSync(file)) {
    try {
      return (JSON.parse(readFileSync(file, "utf8")) as { lines: string[] }).lines;
    } catch {
      return [];
    }
  }
  const lines: string[] = [];
  await streamContainerLogs(name, { tail: 3000, follow: false, signal: new AbortController().signal }, (_s, l) => lines.push(l.replace(/^\S+Z /, "")));
  return lines;
}
