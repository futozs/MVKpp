#!/usr/bin/env bash
# MVK token-agent telepítése egy Macre (bérelt vagy saját, App Store + MVK MobilON+ app).
#
#   ./install.sh https://mvk.pelda.hu  <AGENT_SECRET>  [agent-név]
#
# Lépései: lefordítja a Swift agentet, létrehozza a konfigurációt, beállítja
# launchd alá (bejelentkezéskor indul, leállás után újraindul), és megmutatja,
# melyik binárisnak kell Teljes lemezhozzáférést adni.
set -euo pipefail

SERVER="${1:-}"
SECRET="${2:-}"
AGENT_ID="${3:-$(scutil --get LocalHostName 2>/dev/null || hostname -s)}"
if [ -z "$SERVER" ] || [ -z "$SECRET" ]; then
  echo "Használat: $0 <szerver-url> <AGENT_SECRET> [agent-név]" >&2
  exit 1
fi
command -v swiftc >/dev/null || { echo "Kell a Swift fordító: xcode-select --install" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$HOME/Library/Application Support/MVKTokenAgent"
BIN="$DIR/mvk-token-agent"
PLIST="$HOME/Library/LaunchAgents/hu.mvk.token-agent.plist"
LOG="$HOME/Library/Logs/mvk-token-agent.log"

mkdir -p "$DIR" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
echo "→ fordítás…"
swiftc -O "$HERE/MVKTokenAgent.swift" -o "$BIN"

umask 077
cat > "$DIR/config.json" <<EOF
{
  "serverUrl": "$SERVER",
  "agentSecret": "$SECRET",
  "agentId": "$AGENT_ID",
  "bundleId": "com.hclinear.metaccazeMiskolc",
  "refreshBelowHours": 3.5,
  "checkEveryMinutes": 10,
  "restartCooldownMinutes": 30,
  "appWarmupSeconds": 75
}
EOF
chmod 600 "$DIR/config.json"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>hu.mvk.token-agent</string>
  <key>ProgramArguments</key><array><string>$BIN</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/hu.mvk.token-agent" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

cat <<EOF

✓ Telepítve: $BIN
  napló:     $LOG
  leállítás: launchctl bootout gui/$(id -u)/hu.mvk.token-agent

FONTOS  egyszeri lépés:
  Rendszerbeállítások → Adatvédelem és biztonság → Teljes lemezhozzáférés → [+]
  és add hozzá ezt a fájlt (Cmd+Shift+G, majd másold be az útvonalat):
    $BIN
  Enélkül a macOS nem engedi kiolvasni az MVK app tokenjét.

Ellenőrzés:  "$BIN" status
             tail -f "$LOG"
Az MVK MobilON+ appot egyszer nyisd meg kézzel, és jelentkezz be, ha kéri.
EOF
