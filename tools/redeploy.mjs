#!/usr/bin/env node

/**
 * Újratelepítő futtató — leállít mindent, frissít gitből, buildel, újraindít.
 *
 * FONTOS: ez a szkript LEÁLLÍTJA azt a folyamatot, ami elindította (a gateway a
 * manageren keresztül). Ezért a backend `detached: true` + `unref()` módon
 * indítja, saját folyamatcsoportban — így túléli a saját szülője halálát, és a
 * kikapcsolás–indítás teljes ciklusát végig tudja vinni.
 *
 * Minden lépés a `logs/redeploy.log`-ba ír, az állapot pedig a
 * `state/deploy-status.json`-ba kerül, hogy a hub élőben követhesse.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOGS = join(ROOT, 'logs')
const STATE = join(ROOT, 'backend', 'state')
const LOG_FILE = join(LOGS, 'redeploy.log')
const STATUS_FILE = join(STATE, 'deploy-status.json')
const LOCK_FILE = join(STATE, 'deploy.lock')
const MANAGER_PID = join(STATE, 'manager.pid')

mkdirSync(LOGS, { recursive: true })
mkdirSync(STATE, { recursive: true })

/** Csak a `--no-pull` kapcsoló van: build+újraindítás git frissítés nélkül. */
const SKIP_PULL = process.argv.includes('--no-pull')

const STEPS = [
  { id: 'stop', label: 'Folyamatok leállítása' },
  ...(SKIP_PULL ? [] : [{ id: 'pull', label: 'Frissítés gitből' }]),
  { id: 'install', label: 'Függőségek telepítése' },
  { id: 'migrate', label: 'Adatbázis migráció' },
  { id: 'build', label: 'Build (backend, frontend, hub)' },
  { id: 'start', label: 'Rendszer indítása' },
]

const status = {
  running: true,
  ok: null,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  currentStep: null,
  error: null,
  steps: STEPS.map((s) => ({ ...s, state: 'pending', ms: null, note: null })),
}

function writeStatus() {
  try {
    writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2))
  } catch {
    /* az állapotfájl hibája nem állíthatja meg a telepítést */
  }
}

function log(line) {
  const stamp = new Date().toLocaleTimeString('hu-HU')
  const text = `[${stamp}] ${line}\n`
  recentLog.push(`[${stamp}] ${line}`)
  if (recentLog.length > 400) recentLog = recentLog.slice(-200)
  try {
    appendFileSync(LOG_FILE, text)
  } catch {
    /* ha nem tudunk logolni, attól még dolgozunk tovább */
  }
}

function setStep(id, state, note) {
  const s = status.steps.find((x) => x.id === id)
  if (s) {
    s.state = state
    if (note !== undefined) s.note = note
  }
  status.currentStep = state === 'running' ? id : status.currentStep
  writeStatus()
}

/** Parancsfuttatás a kimenet naplózásával. Nem dob — a kilépési kódot adja vissza. */
function run(cmd, args, cwd = ROOT, timeoutMs = 600_000) {
  return new Promise((resolve) => {
    log(`$ ${cmd} ${args.join(' ')}${cwd !== ROOT ? `   (${cwd.replace(ROOT, '.')})` : ''}`)
    const p = spawn(cmd, args, { cwd, env: { ...process.env, CI: '1' } })
    let out = ''
    const onData = (d) => {
      const s = d.toString()
      out += s
      for (const line of s.split(/\r?\n/)) if (line.trim()) log(`   ${line}`)
    }
    p.stdout.on('data', onData)
    p.stderr.on('data', onData)

    const timer = setTimeout(() => {
      log(`   ! időtúllépés (${timeoutMs / 1000} mp), a parancs leállítva`)
      p.kill('SIGKILL')
    }, timeoutMs)

    p.on('error', (e) => {
      clearTimeout(timer)
      log(`   ! nem indítható: ${e.message}`)
      resolve({ code: 127, out })
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, out })
    })
  })
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ── állapotszerver ──────────────────────────────────────────────────────
/**
 * Saját mini HTTP-szerver a telepítés idejére.
 *
 * Erre azért van szükség, mert az újratelepítés alatt a gateway (:8088) ÉS a
 * hub Vite-szervere (:5174) is le van állítva — a böngészőben már betöltött
 * hub tehát a szokásos proxyn keresztül semmit nem érne el. Ez a szerver egy
 * külön porton él, a hub közvetlenül hívja, és így a haladás végig látszik.
 */
const STATUS_PORT = Number(process.env.DEPLOY_STATUS_PORT ?? 8089)
/** A befejezés után ennyi ideig még válaszolunk, hogy a hub lássa az eredményt. */
const LINGER_MS = 120_000

let recentLog = []

function startStatusServer() {
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ...status, log: recentLog.slice(-200) }))
  })
  server.on('error', (e) => log(`! az állapotszerver nem indult (${e.message}) — a telepítés fut tovább`))
  server.listen(STATUS_PORT, '0.0.0.0', () => log(`állapotszerver: :${STATUS_PORT}`))
  return server
}

// ── 1. leállítás ────────────────────────────────────────────────────────
async function stopEverything() {
  // A managert kell először: ő indítaná újra a gatewayt, ha csak azt ölnénk meg.
  if (existsSync(MANAGER_PID)) {
    const pid = Number(readFileSync(MANAGER_PID, 'utf8').trim())
    if (pid > 0) {
      log(`manager leállítása (pid ${pid})`)
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        log('   a manager már nem futott')
      }
      await wait(1500)
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* már elment — ez a jó eset */
      }
    }
  } else {
    log('nincs manager.pid — a manager talán nem futott')
  }

  // Árva manager: olyan példány, ami nem a pid-fájlból való (régebbi indítás,
  // vagy kézzel indított második manager). Ha életben marad, versenyezne az
  // újjal a portokért és visszahozná a régi kódot futtató gyerekeit.
  // A `-f` mintából a saját folyamatunkat kizárjuk.
  await run('bash', [
    '-lc',
    `pgrep -f "node .*manager\\.mjs" 2>/dev/null | grep -v "^${process.pid}$" | xargs kill -9 2>/dev/null || true`,
  ])

  // Biztonsági háló: bármi, ami még a portokon ül.
  await run('bash', ['-lc', 'lsof -ti:8088,5173,5174 2>/dev/null | xargs kill -9 2>/dev/null || true'])
  // A statisztikai worker nem portra köt, ezért név szerint.
  await run('bash', ['-lc', 'pkill -f "worker/main.ts" 2>/dev/null || true'])
  await wait(500)
}

// ── 2. git ──────────────────────────────────────────────────────────────
async function gitPull() {
  const dirty = await run('git', ['status', '--porcelain'])
  if (dirty.out.trim()) {
    // Nem írunk felül helyi módosítást: az adatvesztés lenne. Inkább megállunk.
    throw new Error(
      'A munkakönyvtárban helyi módosítások vannak, ezért a git pull kimarad. ' +
        'Kommitold vagy dobd el őket a szerveren, majd próbáld újra.'
    )
  }
  const before = await run('git', ['rev-parse', '--short', 'HEAD'])
  const pull = await run('git', ['pull', '--ff-only'])
  if (pull.code !== 0) throw new Error('A git pull nem sikerült — a részletek a naplóban.')
  const after = await run('git', ['rev-parse', '--short', 'HEAD'])

  const from = before.out.trim()
  const to = after.out.trim()
  return from === to ? `Már naprakész (${to})` : `${from} → ${to}`
}

// ── 3. függőségek ───────────────────────────────────────────────────────
// A projekt bunra épül (lásd a gyökér package.json "bun run" szkriptjeit),
// ezért itt is bunnal telepítünk — ugyanaz a csomagkezelő, mint a kézi
// `bun run start` esetén, így a lockfile és a node_modules nem csúszik szét.
async function installDeps() {
  const dirs = ['.', 'backend', 'frontend', 'hub'].filter((d) =>
    existsSync(join(ROOT, d, 'package.json'))
  )
  for (const d of dirs) {
    const r = await run('bun', ['install'], join(ROOT, d))
    if (r.code !== 0) throw new Error(`bun install hiba: ${d}`)
  }
  return `${dirs.length} csomag könyvtár`
}

// ── 4. adatbázis migráció ───────────────────────────────────────────────
// Ugyanaz a lépés, amit a gyökér `bun run start` is elvégez (bun run migrate
// → cd backend && bun run db:migrate), hogy az újratelepítés utáni séma
// tényleg naprakész legyen, nem csak a kód.
async function migrateDb() {
  const r = await run('bun', ['run', 'migrate'], ROOT)
  if (r.code !== 0) throw new Error('A db migráció nem sikerült — a részletek a naplóban.')
  return 'backend/src/db/migrate.ts lefutott'
}

// ── 5. build ────────────────────────────────────────────────────────────
async function buildAll() {
  // Egyetlen bun szkript, ugyanaz, amit a gyökér `bun run start` is hív
  // (build:frontend + build:hub + build:backend) — így a build sorrendje és
  // eredménye nem térhet el attól, mintha valaki kézzel futtatná.
  const r = await run('bun', ['run', 'build'], ROOT)
  if (r.code !== 0) {
    // Itt szándékosan megállunk: hibás buildet nem indítunk el. A régi
    // rendszer ilyenkor sajnos már le van állítva, ezért a hibát a hub
    // felületén jól láthatóan meg kell mutatni.
    throw new Error('A build megbukott — a fordítási hibák a naplóban.')
  }
  return 'backend + frontend + hub'
}

// ── 6. indítás ──────────────────────────────────────────────────────────
async function startManager() {
  const { openSync } = await import('node:fs')
  const outFd = openSync(join(LOGS, 'manager.log'), 'a')
  // A "--prod" flag itt nem elhagyható: enélkül a manager dev módra esik
  // vissza, és a már megépített dist helyett újra Vite dev szervereket (npx
  // vite) indítana a háttérben — ez okozta a redeploy utáni "random
  // folyamatot". A gyökér `bun run start` is ugyanígy hívja: node manager.mjs
  // -- --prod.
  const child = spawn('node', ['manager.mjs', '--prod'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', outFd, outFd],
    // MVK_DAEMON=1: mi magunk már detached+unref módon indítjuk, a manager
    // saját magát-háttérbe-tevő logikájára itt nincs szükség (az csak a
    // kézzel, terminálból indított `bun run start` esetén kell).
    env: { ...process.env, MVK_DAEMON: '1' },
  })
  child.unref()
  log(`manager elindítva (pid ${child.pid}, --prod)`)

  // Megvárjuk, amíg a gateway tényleg válaszol — a „elindítottam" önmagában
  // nem bizonyíték arra, hogy fel is jött.
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    await wait(1500)
    try {
      const res = await fetch('http://127.0.0.1:8088/_health', { signal: AbortSignal.timeout(3000) })
      if (res.ok) return `A gateway válaszol (pid ${child.pid})`
    } catch {
      /* még nem jött fel */
    }
  }
  throw new Error('A rendszer elindult, de a gateway 90 mp alatt nem válaszolt.')
}

// ── vezérlés ────────────────────────────────────────────────────────────
async function main() {
  if (existsSync(LOCK_FILE)) {
    const age = Date.now() - Number(readFileSync(LOCK_FILE, 'utf8').trim() || 0)
    // 30 percnél régebbi zár árva: egy megszakadt futás hagyta ott.
    if (age < 30 * 60_000) {
      log('MEGSZAKÍTVA: már fut egy újratelepítés.')
      process.exit(1)
    }
    log('árva zárfájl eltávolítva')
  }
  writeFileSync(LOCK_FILE, String(Date.now()))

  const statusServer = startStatusServer()

  log('')
  log('════════ ÚJRATELEPÍTÉS INDUL ════════')
  writeStatus()

  const runners = {
    stop: stopEverything,
    pull: gitPull,
    install: installDeps,
    migrate: migrateDb,
    build: buildAll,
    start: startManager,
  }

  try {
    for (const step of STEPS) {
      const t0 = Date.now()
      setStep(step.id, 'running')
      log(`▸ ${step.label}`)
      const note = await runners[step.id]()
      const s = status.steps.find((x) => x.id === step.id)
      s.ms = Date.now() - t0
      setStep(step.id, 'done', note ?? null)
      log(`✓ ${step.label}${note ? ` — ${note}` : ''} (${(s.ms / 1000).toFixed(1)} mp)`)
    }
    status.ok = true
    log('════════ KÉSZ ════════')
  } catch (e) {
    status.ok = false
    status.error = e.message
    const cur = status.steps.find((x) => x.state === 'running')
    if (cur) cur.state = 'failed'
    log(`✗ HIBA: ${e.message}`)
    log('════════ MEGSZAKADT ════════')

    // Bukott build után a rendszer le van állítva. Megpróbáljuk a MEGLÉVŐ
    // (régi) kóddal visszahozni, hogy ne maradjon halott a szerver.
    if (['install', 'migrate', 'build'].includes(status.currentStep)) {
      log('helyreállítási kísérlet: indítás a jelenlegi kóddal…')
      try {
        const note = await startManager()
        log(`✓ helyreállítva — ${note}`)
        status.error += ' A rendszer a korábbi kóddal visszaindult.'
      } catch (e2) {
        log(`✗ a helyreállítás sem sikerült: ${e2.message}`)
        status.error += ' A rendszert kézzel kell elindítani: bun run start'
      }
    }
  } finally {
    status.running = false
    status.currentStep = null
    status.finishedAt = new Date().toISOString()
    writeStatus()
    try {
      rmSync(LOCK_FILE, { force: true })
    } catch {
      /* a zár eltávolítása legrosszabb esetben elévül */
    }

    // Még életben tartjuk az állapotszervert, hogy a hub biztosan lássa a
    // végeredményt, aztán magától elengedjük a folyamatot.
    log(`az állapotszerver még ${LINGER_MS / 1000} mp-ig válaszol (:${STATUS_PORT})`)
    setTimeout(() => {
      statusServer.close()
      process.exit(status.ok ? 0 : 1)
    }, LINGER_MS)
  }
}

main()
