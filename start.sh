#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# start.sh — MVK MobilON+ SaaS Launcher & Instance Manager
# Elindítja:
#   1) az MVK natív appot (ha Mac-en fut)
#   2) a Token Workert a háttérben
#   3) a Backend API Gateway-t (http://localhost:8088)
#   4) a modern React + Vite Frontendet (http://localhost:5173)
# Ctrl+C = leállít mindent tisztán.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

cd "$DIR"
node manager.mjs
