import { Hono } from "hono";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = join(HERE, "..", "..");
const PROJECT_ROOT = join(BACKEND_ROOT, "..");
const STATE_DIR = join(BACKEND_ROOT, "state");
const LOGS_DIR = join(PROJECT_ROOT, "logs");
const STATUS_FILE = join(STATE_DIR, "deploy-status.json");

const LOG_SOURCES = [
  "backend",
  "frontend",
  "hub",
  "stats",
  "worker",
  "manager",
  "redeploy",
] as const;
type LogSource = (typeof LOG_SOURCES)[number];

const LOG_LABELS: Record<LogSource, string> = {
  backend: "Gateway",
  frontend: "Dashboard",
  hub: "Hub",
  stats: "Statisztikai worker",
  worker: "Token worker",
  manager: "Folyamatkezelő",
  redeploy: "Újratelepítés",
};

// A rendszerhub kizárólag helyi hálózaton fut, nincs internetre kitéve —
// ezért az üzemeltetési végpontok (naplók, újratelepítés) nem kérnek admin
// tokent. Ha valaha internetre kerülne, ezt előbb pótolni kell.
export const ops = new Hono();

ops.get("/auth-status", (c) => c.json({ required: false }));

ops.get("/deploy-status", (c) => {
  try {
    const raw = readFileSync(STATUS_FILE, "utf8");
    return c.json(JSON.parse(raw));
  } catch {
    return c.json({
      running: false,
      ok: null,
      steps: [],
      error: null,
      startedAt: null,
    });
  }
});

ops.get("/logs", (c) => {
  const list = LOG_SOURCES.map((name) => {
    const file = join(LOGS_DIR, `${name}.log`);
    let size = 0;
    let mtime: string | null = null;
    try {
      const st = statSync(file);
      size = st.size;
      mtime = st.mtime.toISOString();
    } catch {}
    return { name, label: LOG_LABELS[name], size, mtime, exists: size > 0 };
  });
  return c.json({ sources: list, dir: LOGS_DIR });
});

ops.get("/logs/:source", (c) => {
  const source = c.req.param("source");
  if (!LOG_SOURCES.includes(source as LogSource)) {
    return c.json({ error: "ismeretlen naplóforrás" }, 400);
  }
  const lines = Math.min(
    2000,
    Math.max(10, Number(c.req.query("lines") ?? 300)),
  );
  const file = join(LOGS_DIR, `${source}.log`);

  if (!existsSync(file)) {
    return c.json({
      source,
      size: 0,
      lines: [],
      note: "Ehhez a forráshoz még nincs napló.",
    });
  }
  try {
    const size = statSync(file).size;
    const TAIL_BYTES = 512 * 1024;
    const fd = openSync(file, "r");
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);

    const text = buf.toString("utf8");
    const all = text.split(/\r?\n/);
    if (start > 0 && all.length) all.shift();
    const tail = all.filter((l) => l.length).slice(-lines);
    return c.json({
      source,
      label: LOG_LABELS[source as LogSource],
      size,
      lines: tail,
    });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

ops.post("/redeploy", async (c) => {
  // A backendet a manager.mjs fork()-olja, ezért van IPC-csatornája
  // (process.send) a szülő felé. Az újratelepítés a manager saját
  // folyamatán BELÜL fut le (lásd manager.mjs performRedeploy) — a manager
  // sosem lép ki eközben, így az a terminál, amiben a rendszer fut, nem
  // szakad meg. Ha valaki a backendet a manageren kívül futtatja (pl. `cd
  // backend && bun run dev`), nincs ilyen csatorna — akkor ezt jelezzük.
  if (typeof process.send !== "function") {
    return c.json(
      {
        error:
          "Az újratelepítés csak a manager.mjs (bun run start / bun run dev) alatt futó backendből érhető el.",
      },
      500,
    );
  }

  let skipPull = false;
  try {
    const body = (await c.req.json()) as { skipPull?: boolean };
    skipPull = body?.skipPull === true;
  } catch {}

  try {
    writeFileSync(
      STATUS_FILE,
      JSON.stringify({
        running: true,
        ok: null,
        startedAt: new Date().toISOString(),
        steps: [],
        currentStep: "stop",
        error: null,
      }),
    );
  } catch {}

  process.send({ type: "redeploy", skipPull });
  console.log(`[ops] ⟳ újratelepítés kérve a managertől (skipPull=${skipPull})`);

  return c.json({
    ok: true,
    skipPull,
    message:
      "Az újratelepítés elindult a manager folyamatában — a terminál, amiben a rendszer fut, folyamatosan mutatja a haladást.",
  });
});
