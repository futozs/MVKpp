#!/usr/bin/env node

/**
 * MVK MobilON+ — Unified Instance Manager & SaaS Process Hub
 * Orchestrates:
 *   1. Backend API Gateway (Hono + TypeScript on :8088)
 *   2. Main Frontend Dashboard (Vite on :5173)
 *   3. Dedicated System Hub (Vite on :5174)
 *   4. Token Worker (Background daemon for Mac MVK App Attest token refresh)
 */

import { spawn, execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BACKEND_DIR = join(__dirname, 'backend')
const FRONTEND_DIR = join(__dirname, 'frontend')
const HUB_DIR = join(__dirname, 'hub')
const WORKER_SCRIPT = join(BACKEND_DIR, 'tools', 'token_worker.sh')

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
  clean.split(/\r?\n/).forEach((line) => {
    console.log(`${C.gray}[${time}]${C.reset} ${color}${C.bold}[${prefix}]${C.reset} ${line}`)
  })
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

  const proc = spawn('node', ['src/index.ts'], {
    cwd: BACKEND_DIR,
    // MVK_MANAGED: a backend ebbol tudja, hogy kilepes utan van, aki visszahozza.
    env: { ...process.env, PORT: '8088', AUTO_RENEW: '0', MVK_MANAGED: '1' },
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

// 2. Start Main Frontend Server
console.log(`${C.cyan}*${C.reset} ${C.bold}Fő Frontend Dashboard inditasa (:5173)...${C.reset}`)
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

// 3. Start Dedicated System Hub
if (existsSync(HUB_DIR)) {
  console.log(`${C.magenta}*${C.reset} ${C.bold}Dedikalt Rendszer Hub inditasa (:5174)...${C.reset}`)
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

// 4. Start Background Token Worker
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
