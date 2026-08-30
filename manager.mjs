#!/usr/bin/env node

/**
 * MVK MobilON+ — Unified Instance Manager & SaaS Process Hub
 * Orchestrates:
 *   1. Backend API Gateway (Hono + TypeScript on :8088)
 *   2. Main Frontend Dashboard (Vite on :5173, or static from :5173 in prod)
 *   3. Dedicated System Hub (Vite on :5174, or static from :5174 in prod)
 *   4. Token Worker (Background daemon for Mac MVK App Attest token refresh)
 */

import { spawn, execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BACKEND_DIR = join(__dirname, 'backend')
const FRONTEND_DIR = join(__dirname, 'frontend')
const HUB_DIR = join(__dirname, 'hub')
const WORKER_SCRIPT = join(BACKEND_DIR, 'tools', 'token_worker.sh')
const LOGS_DIR = join(__dirname, 'logs')
const STATE_DIR = join(BACKEND_DIR, 'state')
const PID_FILE = join(STATE_DIR, 'manager.pid')

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

// 1. Start Backend Process
//
// A backend magától is kiléphet (a hub „Újraindítás" gombja ezt használja),
// ezért felügyeljük: ha nem leállás közben esik ki, újraindítjuk.
let shuttingDown = false
let backendEntry = null

console.log(`${C.green}*${C.reset} ${C.bold}Backend API Gateway inditasa (:8088)...${C.reset}`)

function startBackend(reason) {
  if (reason) logLine('MANAGER', C.green, `Backend ujrainditasa (${reason})...`)

  // Prod módban: dist/index.js | Dev módban: src/index.ts
  const script = PROD_MODE ? 'dist/index.js' : 'src/index.ts'
  const distExists = existsSync(join(BACKEND_DIR, 'dist', 'index.js'))
  
  if (PROD_MODE && !distExists) {
    logLine('BACKEND', C.red, `HIBA: backend dist nem található (${join(BACKEND_DIR, 'dist', 'index.js')}) — futtasd: npm run build`)
    process.exit(1)
  }

  const proc = spawn('node', [script], {
    cwd: BACKEND_DIR,
    // MVK_MANAGED: a backend ebbol tudja, hogy kilepes utan van, aki visszahozza.
    env: { 
      ...process.env, 
      PORT: '8088', 
      AUTO_RENEW: '0', 
      MVK_MANAGED: '1',
      NODE_ENV: PROD_MODE ? 'production' : 'development'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  proc.stdout.on('data', (d) => logLine('BACKEND', C.green, d))
  proc.stderr.on('data', (d) => logLine('BACKEND', C.red, d))

  proc.on('exit', (code) => {
    if (shuttingDown) return
    logLine('BACKEND', C.yellow, `Kilepett (kod: ${code}). Ujrainditas 800 ms mulva.`)
    setTimeout(() => {
      const next = startBackend(`elozo kod: ${code}`)
      // A processzlistaban a friss peldany szerepeljen, hogy Ctrl+C leallitsa.
      if (backendEntry) backendEntry.proc = next
    }, 800)
  })

  return proc
}

const backendProc = startBackend()
backendEntry = { name: 'backend', proc: backendProc }
processes.push(backendEntry)

// ── Static file server for prod mode ────────────────────────────────────────
function startStaticServer(distDir, port, name) {
  const server = createServer((req, res) => {
    const urlPath = req.url.split('?')[0] // remove query string
    let filePath = join(distDir, urlPath === '/' ? 'index.html' : urlPath)
    
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
    if (urlPath.startsWith('/assets/') || urlPath.startsWith('/public/')) {
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

// 2. Start Main Frontend Server
console.log(`${C.cyan}*${C.reset} ${C.bold}Fő Frontend Dashboard inditasa (:5173)...${C.reset}`)

if (PROD_MODE) {
  const frontendDist = join(FRONTEND_DIR, 'dist')
  if (!existsSync(frontendDist)) {
    logLine('FRONTEND', C.red, `HIBA: frontend dist nem található (${frontendDist}) — futtasd: npm run build`)
  } else {
    startStaticServer(frontendDist, 5173, 'FRONTEND')
  }
} else {
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
}

// 3. Start Dedicated System Hub
if (existsSync(HUB_DIR)) {
  console.log(`${C.magenta}*${C.reset} ${C.bold}Dedikalt Rendszer Hub inditasa (:5174)...${C.reset}`)
  
  if (PROD_MODE) {
    const hubDist = join(HUB_DIR, 'dist')
    if (!existsSync(hubDist)) {
      logLine('HUB', C.red, `HIBA: hub dist nem található (${hubDist}) — futtasd: npm run build`)
    } else {
      startStaticServer(hubDist, 5174, 'HUB')
    }
  } else {
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
  }
}

// 4. Start Statistics Worker (MySQL adatraktar: gyujtes -> tenyek -> aggregatumok)
//
// Kulon folyamat, nem a backend resze: igy egy ejszakai aggregalas soha nem
// lassitja a valos ideju vegpontokat. Ha nincs eleheto MySQL, a worker kilep,
// es a rendszer tobbi resze valtozatlanul mukodik tovabb.
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
  if (!shuttingDown && code !== 0) {
    logLine('STATS', C.yellow, `Kilepett (kod: ${code}) - fut a MySQL? Probald: cd backend && npm run db:migrate`)
  }
})

// 5. Start Background Token Worker
if (existsSync(WORKER_SCRIPT)) {
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

console.log(`
${C.bold}${C.white}>> Rendszer elindult! Elerhetosegek:${C.reset}
   ${C.cyan}>> Fo Tranzit Dashboard:${C.reset}  ${C.bold}http://localhost:5173${C.reset}
   ${C.magenta}>> SaaS Rendszer Hub:${C.reset}     ${C.bold}http://localhost:5174${C.reset}
   ${C.green}>> Backend API Gateway:${C.reset}   ${C.bold}http://localhost:8088${C.reset}
   ${C.cyan}>> Statisztikai API:${C.reset}      ${C.bold}http://localhost:8088/stats/health${C.reset}

${C.dim}Kilepeshez es az osszes folyamat leallitasahoz nyomj Ctrl+C billentyut.${C.reset}
`)

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
