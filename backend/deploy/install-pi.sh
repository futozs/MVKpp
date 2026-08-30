#!/usr/bin/env bash
# Raspberry Pi 4 telepítő: Node ellenőrzés, build, systemd service beüzemelése.
# Futtasd a projekt gyökeréből:  sudo bash deploy/install-pi.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_SRC="$APP_DIR/deploy/mvk-gateway.service"
SERVICE_DST="/etc/systemd/system/mvk-gateway.service"
RUN_USER="${SUDO_USER:-pi}"

echo "[*] App könyvtár: $APP_DIR"
echo "[*] Futtató felhasználó: $RUN_USER"

# 1) Node >= 20 kell (natív fetch). Ha nincs, telepítsd NodeSource-ból.
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "[*] Node >= 20 telepítése (NodeSource)…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "[*] Node: $(node -v)"

# 2) függőségek + build
echo "[*] npm ci + build…"
sudo -u "$RUN_USER" bash -lc "cd '$APP_DIR' && npm ci && npm run build"

# 3) service telepítése (útvonal/user behelyettesítéssel)
echo "[*] systemd service telepítése…"
sed -e "s#/home/pi/mvk-api-gateway#$APP_DIR#g" \
    -e "s#^User=pi#User=$RUN_USER#g" \
    "$SERVICE_SRC" > "$SERVICE_DST"

systemctl daemon-reload
systemctl enable mvk-gateway
systemctl restart mvk-gateway

echo ""
echo "[+] Kész. Állapot:"
systemctl --no-pager status mvk-gateway | head -8 || true
echo ""
echo "[i] Token betöltése (a root-eszközről szerzett JWT-vel):"
echo "    curl -X POST http://<PI-IP>:8088/_ingest -H 'Content-Type: application/json' \\"
echo "         -d '{\"jwt\":\"<JWT>\",\"installationId\":\"<UUID ha van>\"}'"
echo "[i] Állapot:  curl http://<PI-IP>:8088/_health"
echo "[i] Napló:    journalctl -u mvk-gateway -f"
