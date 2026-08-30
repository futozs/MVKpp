#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# token_worker.sh — 0–24 friss token a Mac-natív MVK appból.
#   - Kiolvassa a tokent a plistből, betölti a gateway-be.
#   - Ha a token ≤MARGIN mp múlva lejár (vagy hiányzik): kilövi az appot,
#     újraindítja, vár, és kiolvassa a friss tokent (App Attest újra-attesztál).
# Semmit nem tör fel — a saját app saját tokenjét használjuk.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
GW="${GW:-http://localhost:8088}"
INTERVAL="${INTERVAL:-60}"
MARGIN="${MARGIN:-300}"                       # ennyi mp alatt → app újraindítás
RESTART_COOLDOWN="${RESTART_COOLDOWN:-180}"   # két újraindítás közti minimum (mp)
BUNDLE="com.hclinear.metaccazeMiskolc"
APPNAME="MVK MobilON+"
PLIST="$HOME/Library/Containers/$BUNDLE/Data/Library/Preferences/$BUNDLE.plist"

read_token() { python3 -c '
import plistlib,sys
try:
  pl=plistlib.load(open(sys.argv[1],"rb"))
  for k,v in pl.items():
    if isinstance(v,str) and v.startswith("eyJ") and v.count(".")==2: print(v); break
except Exception: pass
' "$PLIST"; }

jwt_exp() { python3 -c '
import sys,base64,json
try:
  t=sys.argv[1].split(".")[1]; t+="="*(-len(t)%4)
  print(int(json.loads(base64.urlsafe_b64decode(t)).get("exp",0)))
except Exception: print(0)
' "$1"; }

restart_app() {
  echo "[worker] $(date +%H:%M:%S) 🔄 app újraindítás (token lejárt/mindjárt lejár)…"
  osascript -e "quit app id \"$BUNDLE\"" 2>/dev/null || killall "$APPNAME" 2>/dev/null || pkill -f metaccaze 2>/dev/null || true
  sleep 4
  open -b "$BUNDLE" 2>/dev/null || open -a "$APPNAME" 2>/dev/null || echo "[worker] (!) app indítás sikertelen — indítsd kézzel"
  echo "[worker] várok 60 mp-et a friss tokenre…"
  sleep 60
}

LAST=""; CONFIRMED=0; LAST_RESTART=0
echo "[worker] figyelem: $PLIST"
echo "[worker] gw=$GW  intervallum=${INTERVAL}s  margin=$((MARGIN/60))perc"
while true; do
  JWT="$(read_token | tr -d '[:space:]')"
  NOW=$(date +%s); RESTART=0; MIN="?"
  if [ -z "$JWT" ]; then
    echo "[worker] ⚠️ nincs token a plistben"; RESTART=1
  else
    EXP="$(jwt_exp "$JWT")"; LEFT=$((EXP - NOW)); MIN=$((LEFT / 60))
    if [ "$LEFT" -lt "$MARGIN" ]; then echo "[worker] ⏳ token lejár ${MIN} perc múlva"; RESTART=1; fi
  fi

  # FALLBACK: a backend jelezte, hogy a szerver elutasította az érvényes tokent (403)?
  if curl -s -m 3 "$GW/_health" 2>/dev/null | grep -q '"tokenRejected":true'; then
    echo "[worker] 🚫 a szerver elutasította a tokent → app-refresh"; RESTART=1
  fi

  if [ "$RESTART" = "1" ] && [ $((NOW - LAST_RESTART)) -gt "$RESTART_COOLDOWN" ]; then
    LAST_RESTART=$NOW; restart_app; continue
  fi

  # Csak akkor logolunk, ha változott az állapot, vagy hiba van, vagy közeleg a lejárat
  if [ -n "$JWT" ]; then
    if [ "$JWT" != "$LAST" ] || [ "$CONFIRMED" != "1" ]; then
      R="$(curl -s -m 5 -X POST "$GW/_ingest" -H 'Content-Type: application/json' -d "{\"jwt\":\"$JWT\"}" 2>/dev/null || true)"
      if echo "$R" | grep -q '"ok":true'; then
        echo "[worker] $(date +%H:%M:%S) ✅ Új token betöltve a gateway-be (${MIN} perc érvényes)"
        LAST="$JWT"; CONFIRMED=1
      else
        CONFIRMED=0; echo "[worker] $(date +%H:%M:%S) ⚠️ Backend nem elérhető ($GW/_ingest) — újrapróbálom…"
      fi
    else
      # Érvényes token, nem változott: csak 30 percenként vagy 15 perc alatti lejárati figyelmeztetésnél szólunk
      if [ $((NOW % 1800)) -lt "$INTERVAL" ] || [ "$LEFT" -lt 900 ]; then
        if [ "$LEFT" -lt 900 ]; then
          echo "[worker] $(date +%H:%M:%S) ⏳ Figyelem: token hamarosan lejár (${MIN} perc van hátra)"
        fi
      fi
    fi
  fi
  sleep "$INTERVAL"
done
