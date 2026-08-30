#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# refresh_token.sh — friss token utántöltése az iPadről USB-n át.
# A genuine app az iPaden magától megújítja a tokent (App Attest), mi csak
# kiolvassuk egy inkrementális backupból és betöltjük a gateway-be. Nincs TCC-
# huzavona (a backup egy általunk megadott mappába megy), nincs szerver-bypass.
#
# Feltétel:
#   - iPad USB-n, "Trust" megadva
#   - libimobiledevice:  brew install libimobiledevice
#   - az iPaden legyen NYITVA egyszer az MVK app (hogy frissítse a tokent)
#
# Használat:
#   ./backend/tools/refresh_token.sh                 # egyszeri utántöltés
#   GW=http://192.168.0.50:8088 ./backend/tools/refresh_token.sh   # távoli gateway
#   watch -n 3600 ./backend/tools/refresh_token.sh   # óránként (ha bedugva marad)
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
DIR="$(cd "$(dirname "$0")/../.." && pwd)"     # a files/ gyökér
GW="${GW:-http://localhost:8088}"
BK="$DIR/backend/tools/_ipadbackup"

command -v idevicebackup2 >/dev/null 2>&1 || { echo "❌ Kell: brew install libimobiledevice"; exit 1; }
if ! idevice_id -l 2>/dev/null | grep -q .; then
  echo "❌ Nincs csatlakoztatott iPhone/iPad. Dugd be USB-vel + Trust."; exit 1
fi

echo "[*] Inkrementális iPad backup a $BK mappába… (első alkalommal lassabb)"
mkdir -p "$BK"
idevicebackup2 backup "$BK" 2>&1 | tail -4

UDID="$(ls -1 "$BK" 2>/dev/null | grep -E '^[0-9A-Fa-f-]{20,}$' | head -1)"
if [ -z "$UDID" ]; then echo "❌ Nincs backup mappa a $BK-ban (titkosított a backup? kapcsold ki, vagy Finderrel csináld)"; exit 2; fi

echo "[*] Token kiolvasás + betöltés a gateway-be…"
python3 "$DIR/backend/tools/extract_ios_token.py" --backup "$BK/$UDID" --ingest "$GW"
echo "[+] Kész. Ellenőrzés:  curl -s $GW/_health | jq '.jwt'"
