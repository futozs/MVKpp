/**
 * Üzemeltetési végpontok: újratelepítés és naplók.
 *
 * BIZTONSÁG — ez a modul távolról hívható kódfuttatási útvonalat nyit: a
 * `/system/redeploy` gitből frissít, buildel és újraindítja a rendszert.
 * Hálózaton elérhető gateway mellett ez adminisztrátori jogosultság, ezért a
 * romboló műveletek admin tokent kérnek. A token a `state/admin_token.txt`
 * fájlban él; ha nincs, indításkor generálódik és a konzolra kerül.
 *
 * Az olvasó végpontok (állapot, napló) token nélkül is elérhetők, hogy a hub
 * a rendszer állapotát mindig meg tudja mutatni.
 */
import { Hono, type MiddlewareHandler } from 'hono'
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BACKEND_ROOT = join(HERE, '..', '..')
const PROJECT_ROOT = join(BACKEND_ROOT, '..')
const STATE_DIR = join(BACKEND_ROOT, 'state')
const LOGS_DIR = join(PROJECT_ROOT, 'logs')
const TOKEN_FILE = join(STATE_DIR, 'admin_token.txt')
const STATUS_FILE = join(STATE_DIR, 'deploy-status.json')
const REDEPLOY_SCRIPT = join(PROJECT_ROOT, 'tools', 'redeploy.mjs')

/**
 * Naplóforrások fehérlistája.
 *
 * A kérésben érkező név SOHA nem kerül közvetlenül útvonalba — csak ez a lista
 * dönt, különben egy `?source=../../etc/passwd` bármit kiolvashatna.
 */
const LOG_SOURCES = ['backend', 'frontend', 'hub', 'stats', 'worker', 'manager', 'redeploy'] as const
type LogSource = (typeof LOG_SOURCES)[number]

const LOG_LABELS: Record<LogSource, string> = {
  backend: 'Gateway',
  frontend: 'Dashboard',
  hub: 'Hub',
  stats: 'Statisztikai worker',
  worker: 'Token worker',
  manager: 'Folyamatkezelő',
  redeploy: 'Újratelepítés',
}

// ── admin token ─────────────────────────────────────────────────────────
let cachedToken = ''

/** Beolvassa, vagy első hívásra legenerálja az admin tokent. */
export function adminToken(): string {
  if (cachedToken) return cachedToken
  mkdirSync(STATE_DIR, { recursive: true })
  try {
    const existing = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (existing.length >= 16) {
      cachedToken = existing
      return cachedToken
    }
  } catch {
    /* még nincs — mindjárt lesz */
  }
  cachedToken = randomBytes(16).toString('hex')
  writeFileSync(TOKEN_FILE, cachedToken, { mode: 0o600 })
  console.log(`[ops] admin token generálva → ${TOKEN_FILE}`)
  console.log(`[ops] ADMIN TOKEN: ${cachedToken}`)
  return cachedToken
}

/** Időzítés-független összehasonlítás, hogy a token ne legyen kitalálható. */
function tokenMatches(given: string): boolean {
  const want = Buffer.from(adminToken())
  const got = Buffer.from(given ?? '')
  return want.length === got.length && timingSafeEqual(want, got)
}

export const ops = new Hono()

/** Romboló műveletek őre. */
const requireAdmin = async (c: { req: { header: (k: string) => string | undefined } }) => {
  const given = c.req.header('x-admin-token') ?? ''
  return tokenMatches(given)
}

// ── állapot ─────────────────────────────────────────────────────────────
/** Megmondja, hogy kell-e token — de magát a tokent SOHA nem adja ki. */
ops.get('/auth-status', (c) =>
  c.json({ required: true, configured: adminToken().length > 0, header: 'X-Admin-Token' })
)

ops.get('/deploy-status', (c) => {
  try {
    const raw = readFileSync(STATUS_FILE, 'utf8')
    const t = adminToken()
    return c.json(JSON.parse(t ? raw.split(t).join('«admin token elrejtve»') : raw))
  } catch {
    return c.json({ running: false, ok: null, steps: [], error: null, startedAt: null })
  }
})

// ── naplók ──────────────────────────────────────────────────────────────
/**
 * A folyamatnaplók admin tokent kérnek.
 *
 * Nem óvatosságból: a gateway a saját naplójába kiírja a JWT állapotát, az
 * installation-id-t és — indításkor — magát az admin tokent is. Ha ezt bárki
 * elolvashatná a hálózaton, azzal pont a token védelme válna értelmetlenné,
 * hiszen a naplóból kiolvasva utána bármit indíthatna.
 */
const logGuard: MiddlewareHandler = async (c, next) => {
  if (!(await requireAdmin(c))) {
    return c.json({ error: 'A naplók megtekintéséhez admin token kell.' }, 401)
  }
  await next()
}
ops.use('/logs', logGuard)
ops.use('/logs/*', logGuard)

/** Az admin token soha nem hagyhatja el a gépet naplósorban. */
function redact(line: string): string {
  const t = adminToken()
  return t ? line.split(t).join('«admin token elrejtve»') : line
}

ops.get('/logs', (c) => {
  const list = LOG_SOURCES.map((name) => {
    const file = join(LOGS_DIR, `${name}.log`)
    let size = 0
    let mtime: string | null = null
    try {
      const st = statSync(file)
      size = st.size
      mtime = st.mtime.toISOString()
    } catch {
      /* még nem keletkezett napló ehhez a forráshoz */
    }
    return { name, label: LOG_LABELS[name], size, mtime, exists: size > 0 }
  })
  return c.json({ sources: list, dir: LOGS_DIR })
})

ops.get('/logs/:source', (c) => {
  const source = c.req.param('source')
  if (!LOG_SOURCES.includes(source as LogSource)) {
    return c.json({ error: 'ismeretlen naplóforrás' }, 400)
  }
  const lines = Math.min(2000, Math.max(10, Number(c.req.query('lines') ?? 300)))
  const file = join(LOGS_DIR, `${source}.log`)

  if (!existsSync(file)) {
    return c.json({ source, size: 0, lines: [], note: 'Ehhez a forráshoz még nincs napló.' })
  }
  try {
    const size = statSync(file).size
    // Csak a fájl végét olvassuk: egy több megabájtos naplót fölösleges lenne
    // teljes egészében memóriába húzni minden lekérdezésnél.
    const TAIL_BYTES = 512 * 1024
    const fd = openSync(file, 'r')
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(Math.min(size, TAIL_BYTES))
    readSync(fd, buf, 0, buf.length, start)
    closeSync(fd)

    const text = buf.toString('utf8')
    const all = text.split(/\r?\n/)
    // Csonka első sor, ha a fájl közepéről kezdtünk olvasni.
    if (start > 0 && all.length) all.shift()
    const tail = all.filter((l) => l.length).slice(-lines).map(redact)
    return c.json({ source, label: LOG_LABELS[source as LogSource], size, lines: tail })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500)
  }
})

// ── újratelepítés ───────────────────────────────────────────────────────
ops.post('/redeploy', async (c) => {
  if (!(await requireAdmin(c))) {
    return c.json({ error: 'Érvénytelen vagy hiányzó admin token.' }, 401)
  }
  if (!existsSync(REDEPLOY_SCRIPT)) {
    return c.json({ error: 'A tools/redeploy.mjs nem található.' }, 500)
  }

  let skipPull = false
  try {
    const body = (await c.req.json()) as { skipPull?: boolean }
    skipPull = body?.skipPull === true
  } catch {
    /* üres törzs is rendben */
  }

  // Friss állapotfájl, hogy a hub azonnal „fut" állapotot lásson, és ne a
  // korábbi futás eredményét mutassa, amíg a szkript fel nem áll.
  try {
    writeFileSync(
      STATUS_FILE,
      JSON.stringify({ running: true, ok: null, startedAt: new Date().toISOString(), steps: [], currentStep: 'stop', error: null })
    )
  } catch {
    /* nem kritikus */
  }

  mkdirSync(LOGS_DIR, { recursive: true })
  const outFd = openSync(join(LOGS_DIR, 'redeploy.log'), 'a')

  // `detached` + `unref`: a szkript első dolga, hogy megölje ezt a folyamatot,
  // ezért saját folyamatcsoportban kell futnia, különben magával rántanánk.
  const child = spawn('node', [REDEPLOY_SCRIPT, ...(skipPull ? ['--no-pull'] : [])], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ['ignore', outFd, outFd],
    env: { ...process.env },
  })
  child.unref()

  console.log(`[ops] ⟳ újratelepítés indítva (pid ${child.pid}, skipPull=${skipPull})`)
  return c.json({
    ok: true,
    pid: child.pid,
    skipPull,
    message: 'Az újratelepítés elindult. A folyamat a naplóban követhető.',
  })
})
