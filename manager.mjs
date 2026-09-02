#!/usr/bin/env node

/**
 * MVK MobilON+ — Unified Instance Manager & SaaS Process Hub
 * Orchestrates:
 *   1. Backend API Gateway (Hono + TypeScript on :8088)
 *   2. Main Frontend Dashboard (Vite on :5173, or static from :5173 in prod)
 *   3. Dedicated System Hub (Vite on :5174, or static from :5174 in prod)
 *   4. Token Worker (Background daemon for Mac MVK App Attest token refresh)
 *
 * Az újratelepítés (lásd performRedeploy) ennek a folyamatnak a BELSEJÉBEN fut
 * le — a manager maga sosem lép ki közben. Így a terminál, amiben elindult,
 * a teljes idő alatt élve és láthatóan marad; egy újratelepítés csak a
 * gyerek folyamatokat (backend, frontend/hub, worker) állítja le és indítja
 * újra, a manager process.exit()-je egyszer sem hívódik meg eközben.
 */

import { spawn, execSync, fork } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { createReadStream } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BACKEND_DIR = join(__dirname, 'backend')
const FRONTEND_DIR = join(__dirname, 'frontend')
const HUB_DIR = join(__dirname, 'hub')
const WORKER_SCRIPT = join(BACKEND_DIR, 'tools', 'token_worker.sh')
const LOGS_DIR = join(__dirname, 'logs')
const STATE_DIR = join(BACKEND_DIR, 'state')
const PID_FILE = join(STATE_DIR, 'manager.pid')
const STATUS_FILE = join(STATE_DIR, 'deploy-status.json')
const DEPLOY_STATUS_PORT = 8089
const GATEWAY_PORT = 8088
const GATEWAY_PATHS = [
  '/api', '/live', '/gtfs', '/stats', '/system', '/push',
  '/_health', '/_jwt', '/_export', '/_ingest', '/_renew', '/weather',
]

// Check if --prod flag is passed
const PROD_MODE = process.argv.includes('--prod')

mkdirSync(LOGS_DIR, { recursive: true })
mkdirSync(STATE_DIR, { recursive: true })

// A hub innen olvassa a naplokat, es az ujratelepito innen tudja, kit kell
// leallitania. A pid-fajlt kilepeskor takaritjuk.
writeFileSync(PID_FILE, String(process.pid))

/** Naplofajl felso merethatara; efolott a regi felet eldobjuk. */
const MAX_LOG_BYTES = 5 * 1024 * 1024

function appendLog(name, text) {
  const file = join(LOGS_DIR, `${name}.log`)
  try {
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
      writeFileSync(file, readFileSync(file, 'utf8').slice(-Math.floor(MAX_LOG_BYTES / 2)))
    }
    appendFileSync(file, text)
  } catch {
    // A naplozas hibaja soha nem allithatja meg a folyamatkezelest.
  }
}

// ANSI Color Helpers
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  yellow: '\x1b[38;2;253;204;0m',
  green: '\x1b[38;2;61;220;132m',
  cyan: '\x1b[38;2;90;200;250m',
  magenta: '\x1b[38;2;218;112;214m',
  red: '\x1b[38;2;255;107;107m',
  gray: '\x1b[90m',
  white: '\x1b[97m',
}

console.clear()
console.log(`
${C.yellow}${C.bold}╔════════════════════════════════════════════════════════════════════╗
║                  MVK MobilON+ — SAAS CONTROL HUB                   ║
║         Valos Ideju Tranzit Rendszer & Folyamatkezelo             ║
${PROD_MODE ? `║                        🔴 PRODUCTION MODE 🔴                          ║` : '║                         (dev mode)                                   ║'}
╚════════════════════════════════════════════════════════════════════╝${C.reset}
`)

// Kill any stale processes on ports 8088, 5173, and 5174
try {
  execSync('lsof -ti:8088,5173,5174 2>/dev/null | xargs kill -9 2>/dev/null || true')
} catch {
  // ignore
}

// 1. Try starting native Mac app if on macOS
try {
  execSync('open -b com.hclinear.metaccazeMiskolc 2>/dev/null || open -a "MVK MobilON+" 2>/dev/null || true')
} catch {
  // ignore
}

const processes = []

function logLine(prefix, color, text) {
  const time = new Date().toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const clean = text.toString().trim()
  if (!clean) return
  const lines = clean.split(/\r?\n/)
  lines.forEach((line) => {
    console.log(`${C.gray}[${time}]${C.reset} ${color}${C.bold}[${prefix}]${C.reset} ${line}`)
  })
  // Ugyanaz szinkodok nelkul a fajlba, hogy a hub olvashassa.
  appendLog(prefix.toLowerCase(), lines.map((l) => `[${time}] ${l}
`).join(''))
}

let shuttingDown = false
let redeploying = false
let backendEntry = null
let frontendHandle = null
let hubHandle = null

// ── Backend (fork(), hogy legyen IPC — erre épül az újratelepítés) ─────────
function startBackend(reason) {
  if (reason) logLine('MANAGER', C.green, `Backend ujrainditasa (${reason})...`)

  // Prod módban: dist/index.js | Dev módban: src/index.ts
  const script = PROD_MODE ? 'dist/index.js' : 'src/index.ts'
  const distExists = existsSync(join(BACKEND_DIR, 'dist', 'index.js'))

  if (PROD_MODE && !distExists) {
    const msg = `backend dist nem található (${join(BACKEND_DIR, 'dist', 'index.js')}) — futtasd: npm run build`
    logLine('BACKEND', C.red, `HIBA: ${msg}`)
    // FONTOS: itt NEM process.exit() — ha ez újratelepítés közben derül ki,
    // a manager saját magát ölné meg. A hívó (startAll → performRedeploy vagy
    // a fájl végi induló hívás) dönt arról, mit kezd a hibával.
    throw new Error(msg)
  }

  // fork(), nem spawn(): így a backend egy IPC-csatornán tud üzenni a
  // managernek (proc.send / process.send) — erre épül az újratelepítés
  // (handleBackendMessage → performRedeploy), ami a manager saját
  // folyamatán BELÜL fut le, anélkül hogy a manager (és vele a terminál,
  // amiben elindult) valaha is kilépne.
  const proc = fork(join(BACKEND_DIR, script), [], {
    cwd: BACKEND_DIR,
    // MVK_MANAGED: a backend ebbol tudja, hogy kilepes utan van, aki visszahozza.
    env: {
      ...process.env,
      PORT: '8088',
      AUTO_RENEW: '0',
      MVK_MANAGED: '1',
      NODE_ENV: PROD_MODE ? 'production' : 'development'
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })

  proc.stdout.on('data', (d) => logLine('BACKEND', C.green, d))
  proc.stderr.on('data', (d) => logLine('BACKEND', C.red, d))
  proc.on('message', (msg) => handleBackendMessage(msg))

  proc.on('exit', (code) => {
    if (shuttingDown || redeploying) return
    logLine('BACKEND', C.yellow, `Kilepett (kod: ${code}). Ujrainditas 800 ms mulva.`)
    setTimeout(() => {
      const next = startBackend(`elozo kod: ${code}`)
      // A processzlistaban a friss peldany szerepeljen, hogy Ctrl+C leallitsa.
      if (backendEntry) backendEntry.proc = next
    }, 800)
  })

  return proc
}

// ── Static file server for prod mode ────────────────────────────────────────
function startStaticServer(distDir, port, name, basePath = '') {
  const server = createServer((req, res) => {
    const urlPath = req.url.split('?')[0] // remove query string

    // A Cloudflare Tunnel normally points to the frontend port. Forward API
    // requests here so the public HTTPS URL still reaches the gateway.
    if (PROD_MODE && GATEWAY_PATHS.some((path) => urlPath === path || urlPath.startsWith(`${path}/`))) {
      const gatewayReq = httpRequest({
        hostname: '127.0.0.1',
        port: GATEWAY_PORT,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${GATEWAY_PORT}` },
      }, (gatewayRes) => {
        res.writeHead(gatewayRes.statusCode || 502, gatewayRes.headers)
        gatewayRes.pipe(res)
      })

      gatewayReq.on('error', (error) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: `Gateway unavailable: ${error.message}` }))
        }
      })
      req.pipe(gatewayReq)
      return
    }

    // A hub `/hub/` base-szel epul, mert a gateway ott szolgalja ki — a sajat
    // portjan viszont a gyokeren fut. A prefixet itt vagjuk le, kulonben a
    // /hub/assets/*.js keresek nem talalnanak fajlt, az SPA-fallback az
    // index.html-t adna vissza, es a bongeszo "Failed to load module script:
    // ... MIME type text/html" hibaval eldobna a modult.
    let assetPath = urlPath
    if (basePath && (assetPath === basePath || assetPath.startsWith(`${basePath}/`))) {
      assetPath = assetPath.slice(basePath.length) || '/'
    }

    let filePath = join(distDir, assetPath === '/' ? 'index.html' : assetPath)

    // Security: no path traversal
    if (!filePath.startsWith(distDir)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('400 Bad Request')
      return
    }

    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript',
      '.mjs': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
    }

    // If file exists, serve it
    if (existsSync(filePath) && !filePath.endsWith('/')) {
      const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase()
      const contentType = mimeTypes[ext] || 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' })
      createReadStream(filePath).pipe(res)
      return
    }

    // NEVER fallback /assets/ to index.html — return 404
    if (assetPath.startsWith('/assets/') || assetPath.startsWith('/public/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('404 Not Found')
      return
    }

    // SPA routing: all other routes fallback to index.html
    const indexPath = join(distDir, 'index.html')
    if (!existsSync(indexPath)) {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('500 index.html not found')
      return
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
    createReadStream(indexPath).pipe(res)
  })

  server.listen(port, '0.0.0.0', () => {
    logLine(name, C.cyan, `statikus szerver: :${port}`)
  })
  server.on('error', (e) => logLine(name, C.red, `szerver hiba: ${e.message}`))
  return server
}

// ── Frontend ─────────────────────────────────────────────────────────────
function startFrontend() {
  console.log(`${C.cyan}*${C.reset} ${C.bold}Fő Frontend Dashboard inditasa (:5173)...${C.reset}`)

  if (PROD_MODE) {
    const frontendDist = join(FRONTEND_DIR, 'dist')
    if (!existsSync(frontendDist)) {
      logLine('FRONTEND', C.red, `HIBA: frontend dist nem található (${frontendDist}) — futtasd: npm run build`)
      return null
    }
    return { kind: 'server', ref: startStaticServer(frontendDist, 5173, 'FRONTEND') }
  }

  const frontendProc = spawn('npx', ['vite', '--host', '0.0.0.0', '--port', '5173'], {
    cwd: FRONTEND_DIR,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  processes.push({ name: 'frontend', proc: frontendProc })

  frontendProc.stdout.on('data', (d) => {
    const str = d.toString()
    if (str.includes('ready in') || str.includes('Local:')) {
      logLine('FRONTEND', C.cyan, str)
    }
  })
  frontendProc.stderr.on('data', (d) => logLine('FRONTEND', C.red, d))
  return { kind: 'proc', ref: frontendProc }
}

// ── Hub ──────────────────────────────────────────────────────────────────
function startHub() {
  if (!existsSync(HUB_DIR)) return null
  console.log(`${C.magenta}*${C.reset} ${C.bold}Dedikalt Rendszer Hub inditasa (:5174)...${C.reset}`)

  if (PROD_MODE) {
    const hubDist = join(HUB_DIR, 'dist')
    if (!existsSync(hubDist)) {
      logLine('HUB', C.red, `HIBA: hub dist nem található (${hubDist}) — futtasd: npm run build`)
      return null
    }
    return { kind: 'server', ref: startStaticServer(hubDist, 5174, 'HUB', '/hub') }
  }

  const hubProc = spawn('npx', ['vite', '--host', '0.0.0.0', '--port', '5174'], {
    cwd: HUB_DIR,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  processes.push({ name: 'hub', proc: hubProc })

  hubProc.stdout.on('data', (d) => {
    const str = d.toString()
    if (str.includes('ready in') || str.includes('Local:')) {
      logLine('HUB', C.magenta, str)
    }
  })
  hubProc.stderr.on('data', (d) => logLine('HUB', C.red, d))
  return { kind: 'proc', ref: hubProc }
}

// ── Statisztikai worker ──────────────────────────────────────────────────
//
// Kulon folyamat, nem a backend resze: igy egy ejszakai aggregalas soha nem
// lassitja a valos ideju vegpontokat. Ha nincs eleheto MySQL, a worker kilep,
// es a rendszer tobbi resze valtozatlanul mukodik tovabb.
function startStatsWorker() {
  console.log(`${C.cyan}*${C.reset} ${C.bold}Statisztikai Worker inditasa (MySQL adatraktar)...${C.reset}`)
  const statsProc = spawn('node', ['src/worker/main.ts'], {
    cwd: BACKEND_DIR,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  processes.push({ name: 'stats', proc: statsProc })
  statsProc.stdout.on('data', (d) => logLine('STATS', C.cyan, d))
  statsProc.stderr.on('data', (d) => logLine('STATS', C.red, d))
  statsProc.on('exit', (code) => {
    if (!shuttingDown && !redeploying && code !== 0) {
      logLine('STATS', C.yellow, `Kilepett (kod: ${code}) - fut a MySQL? Probald: cd backend && npm run db:migrate`)
    }
  })
}

// ── Háttér token worker ──────────────────────────────────────────────────
function startTokenWorker() {
  if (!existsSync(WORKER_SCRIPT)) return
  console.log(`${C.yellow}*${C.reset} ${C.bold}Token Worker inditasa (Mac MVK hitelesites)...${C.reset}`)
  const workerProc = spawn('bash', [WORKER_SCRIPT], {
    cwd: BACKEND_DIR,
    env: { ...process.env, GW: 'http://localhost:8088', INTERVAL: '60' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  processes.push({ name: 'worker', proc: workerProc })
  workerProc.stdout.on('data', (d) => logLine('WORKER', C.yellow, d))
  workerProc.stderr.on('data', (d) => logLine('WORKER', C.red, d))
}

/**
 * Elindítja (induláskor), vagy újratelepítés után újraindítja a teljes
 * rendszert. Ugyanaz a függvény fut le mindkét esetben, hogy a két út ne
 * tudjon szétcsúszni egymástól.
 */
function startAll(reason) {
  const proc = startBackend(reason)
  backendEntry = { name: 'backend', proc }
  processes.push(backendEntry)

  frontendHandle = startFrontend()
  hubHandle = startHub()
  startStatsWorker()
  startTokenWorker()

  console.log(`
${C.bold}${C.white}>> Rendszer elindult! Elerhetosegek:${C.reset}
   ${C.cyan}>> Fo Tranzit Dashboard:${C.reset}  ${C.bold}http://localhost:5173${C.reset}
   ${C.magenta}>> SaaS Rendszer Hub:${C.reset}     ${C.bold}http://localhost:5174${C.reset}
   ${C.green}>> Backend API Gateway:${C.reset}   ${C.bold}http://localhost:8088${C.reset}
   ${C.cyan}>> Statisztikai API:${C.reset}      ${C.bold}http://localhost:8088/stats/health${C.reset}

${C.dim}Kilepeshez es az osszes folyamat leallitasahoz nyomj Ctrl+C billentyut.${C.reset}
`)
}

// ── Deploy-status állapotfájl + kis állapotszerver ──────────────────────
//
// A hub innen olvassa a haladást akkor is, ha a gateway épp újratelepítés
// miatt nem elérhető. Mivel a manager most már sosem lép ki újratelepítés
// közben, ez a szerver is folyamatosan él — nincs szükség rá, hogy egy
// külön (telepítés végeztével megszűnő) folyamat indítsa.
function readDeployStatus() {
  try {
    return JSON.parse(readFileSync(STATUS_FILE, 'utf8'))
  } catch {
    return { running: false, ok: null, steps: [], error: null, startedAt: null, finishedAt: null, currentStep: null }
  }
}

function writeDeployStatus(status) {
  try {
    writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2))
  } catch {
    /* az állapotfájl hibája nem állíthatja meg az újratelepítést */
  }
}

const deployStatusServer = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(readDeployStatus()))
})
deployStatusServer.on('error', (e) => logLine('MANAGER', C.red, `állapotszerver hiba (:${DEPLOY_STATUS_PORT}): ${e.message}`))
deployStatusServer.listen(DEPLOY_STATUS_PORT, '0.0.0.0', () => {
  logLine('MANAGER', C.gray, `állapotszerver: :${DEPLOY_STATUS_PORT}`)
})

// ── Parancsfuttatás újratelepítés közben — a kimenet a terminálban is látszik ─
function runStep(cmd, args, cwd) {
  return new Promise((resolve) => {
    logLine('REDEPLOY', C.cyan, `$ ${cmd} ${args.join(' ')}`)
    const p = spawn(cmd, args, { cwd, env: { ...process.env, CI: '1' } })
    let out = ''
    const onData = (d) => {
      const s = d.toString()
      out += s
      for (const line of s.split(/\r?\n/)) if (line.trim()) logLine('REDEPLOY', C.dim, line)
    }
    p.stdout.on('data', onData)
    p.stderr.on('data', onData)
    p.on('error', (e) => {
      logLine('REDEPLOY', C.red, `nem indítható: ${e.message}`)
      resolve({ code: 127, out })
    })
    p.on('close', (code) => resolve({ code: code ?? 1, out }))
  })
}

/** Egy folyamatot SIGTERM-mel, majd (ha kell) SIGKILL-lel állít le. */
function killWithTimeout(proc, ms = 2000) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (!done) {
        done = true
        resolve()
      }
    }
    proc.once('exit', finish)
    try {
      proc.kill('SIGTERM')
    } catch {
      return finish()
    }
    setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* mar nincs ott */
      }
      finish()
    }, ms)
  })
}

/** Egy in-process HTTP szervert zár le, időkorláttal (ha a close() beragadna). */
function closeServer(server, ms = 3000) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (!done) {
        done = true
        resolve()
      }
    }
    try {
      server.close(finish)
    } catch {
      return finish()
    }
    setTimeout(finish, ms)
  })
}

/** Leállítja a jelenleg futó gyerekeket, hogy az új build elfoglalhassa a portokat. */
async function stopForRedeploy() {
  logLine('REDEPLOY', C.yellow, 'jelenlegi folyamatok leállítása...')
  await Promise.all(processes.map(({ proc }) => killWithTimeout(proc)))
  processes.length = 0
  backendEntry = null

  if (frontendHandle?.kind === 'server') await closeServer(frontendHandle.ref)
  frontendHandle = null

  if (hubHandle?.kind === 'server') await closeServer(hubHandle.ref)
  hubHandle = null
}

/**
 * Az újratelepítés — leállítás, (opcionális) git pull, függőségek,
 * migráció, build, majd újraindítás — MIND a manager saját folyamatán belül
 * fut le. A manager process.exit()-je egyszer sem hívódik meg eközben, így
 * a terminál, amiben a `bun run start` fut, a teljes idő alatt élve és
 * láthatóan marad — nincs háttérfolyamat, nincs "megszakadt" terminál.
 */
async function performRedeploy(skipPull) {
  if (redeploying) {
    logLine('REDEPLOY', C.yellow, 'Már fut egy újratelepítés — ez a kérés kimarad.')
    return
  }
  redeploying = true

  const steps = [
    { id: 'stop', label: 'Folyamatok leállítása' },
    ...(skipPull ? [] : [{ id: 'pull', label: 'Frissítés gitből' }]),
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
    steps: steps.map((s) => ({ ...s, state: 'pending', ms: null, note: null })),
  }
  writeDeployStatus(status)

  const setStep = (id, state, note) => {
    const s = status.steps.find((x) => x.id === id)
    if (s) {
      s.state = state
      if (note !== undefined) s.note = note
    }
    status.currentStep = state === 'running' ? id : status.currentStep
    writeDeployStatus(status)
  }

  logLine('REDEPLOY', C.magenta, '════════ ÚJRATELEPÍTÉS INDUL ════════')

  const runners = {
    stop: async () => {
      await stopForRedeploy()
      return null
    },
    pull: async () => {
      const dirty = await runStep('git', ['status', '--porcelain'], __dirname)
      if (dirty.out.trim()) {
        // Nem írunk felül helyi módosítást: az adatvesztés lenne.
        throw new Error(
          'A munkakönyvtárban helyi módosítások vannak, ezért a git pull kimarad. ' +
            'Kommitold vagy dobd el őket a szerveren, majd próbáld újra.'
        )
      }
      const before = await runStep('git', ['rev-parse', '--short', 'HEAD'], __dirname)
      const pull = await runStep('git', ['pull', '--ff-only'], __dirname)
      if (pull.code !== 0) throw new Error('A git pull nem sikerült — a részletek a naplóban.')
      const after = await runStep('git', ['rev-parse', '--short', 'HEAD'], __dirname)
      const from = before.out.trim()
      const to = after.out.trim()
      return from === to ? `Már naprakész (${to})` : `${from} → ${to}`
    },
    install: async () => {
      const dirs = ['.', 'backend', 'frontend', 'hub'].filter((d) => existsSync(join(__dirname, d, 'package.json')))
      for (const d of dirs) {
        const r = await runStep('bun', ['install'], join(__dirname, d))
        if (r.code !== 0) throw new Error(`bun install hiba: ${d}`)
      }
      return `${dirs.length} csomag könyvtár`
    },
    migrate: async () => {
      const r = await runStep('bun', ['run', 'migrate'], __dirname)
      if (r.code !== 0) throw new Error('A db migráció nem sikerült — a részletek a naplóban.')
      return 'backend/src/db/migrate.ts lefutott'
    },
    build: async () => {
      const r = await runStep('bun', ['run', 'build'], __dirname)
      if (r.code !== 0) throw new Error('A build megbukott — a fordítási hibák a naplóban.')
      return 'backend + frontend + hub'
    },
    start: async () => {
      startAll('újratelepítés')
      // Megvárjuk, amíg a gateway tényleg válaszol — a „elindítottam" önmagában
      // nem bizonyíték arra, hogy fel is jött.
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500))
        try {
          const res = await fetch('http://127.0.0.1:8088/_health', { signal: AbortSignal.timeout(3000) })
          if (res.ok) return 'A gateway válaszol'
        } catch {
          /* meg nem jott fel */
        }
      }
      throw new Error('A rendszer elindult, de a gateway 90 mp alatt nem válaszolt.')
    },
  }

  try {
    for (const step of steps) {
      const t0 = Date.now()
      setStep(step.id, 'running')
      const note = await runners[step.id]()
      const s = status.steps.find((x) => x.id === step.id)
      s.ms = Date.now() - t0
      setStep(step.id, 'done', note ?? null)
      logLine('REDEPLOY', C.green, `✓ ${step.label}${note ? ` — ${note}` : ''} (${(s.ms / 1000).toFixed(1)} mp)`)
    }
    status.ok = true
    logLine('REDEPLOY', C.magenta, '════════ KÉSZ ════════')
  } catch (e) {
    status.ok = false
    status.error = e.message
    const cur = status.steps.find((x) => x.state === 'running')
    if (cur) cur.state = 'failed'
    logLine('REDEPLOY', C.red, `✗ HIBA: ${e.message}`)
    logLine('REDEPLOY', C.red, '════════ MEGSZAKADT ════════')

    // Bukott lépés után a rendszer le van állítva. Megpróbáljuk a MEGLÉVŐ
    // (régi) kóddal visszahozni, hogy ne maradjon halott a szerver.
    if (['install', 'migrate', 'build'].includes(status.currentStep)) {
      logLine('REDEPLOY', C.yellow, 'helyreállítási kísérlet: indítás a jelenlegi kóddal…')
      try {
        startAll('helyreállítás az előző kóddal')
        status.error += ' A rendszer a korábbi kóddal visszaindult.'
        logLine('REDEPLOY', C.green, '✓ helyreállítva')
      } catch (e2) {
        status.error += ` A rendszert kézzel kell elindítani: ${e2.message}`
        logLine('REDEPLOY', C.red, `✗ a helyreállítás sem sikerült: ${e2.message}`)
      }
    }
  } finally {
    status.running = false
    status.currentStep = null
    status.finishedAt = new Date().toISOString()
    writeDeployStatus(status)
    redeploying = false
  }
}

/** A backend IPC-üzeneteinek kezelője — jelenleg csak az újratelepítés-kérést ismeri. */
function handleBackendMessage(msg) {
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'redeploy') {
    performRedeploy(msg.skipPull === true).catch((e) => {
      logLine('REDEPLOY', C.red, `váratlan hiba: ${e.message}`)
    })
  }
}

// Graceful shutdown
let isShuttingDown = false
function shutdown() {
  if (isShuttingDown) return
  isShuttingDown = true
  // Leallas kozben a backend kilepese nem hiba: ne inditsuk ujra.
  shuttingDown = true
  console.log(`\n${C.yellow}[Manager] Leallitas folyamatban...${C.reset}`)
  try { rmSync(PID_FILE, { force: true }) } catch { /* mar nincs ott */ }

  processes.forEach(({ name, proc }) => {
    try {
      proc.kill('SIGTERM')
    } catch {
      // ignore
    }
  })

  setTimeout(() => {
    processes.forEach(({ proc }) => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // ignore
      }
    })
    console.log(`${C.green}[Manager] Minden folyamat leallt.${C.reset}`)
    process.exit(0)
  }, 600)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('exit', shutdown)

try {
  startAll()
} catch (e) {
  console.error(`${C.red}${C.bold}[Manager] Indítás sikertelen: ${e.message}${C.reset}`)
  process.exit(1)
}
