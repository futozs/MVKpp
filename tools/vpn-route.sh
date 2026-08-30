#!/usr/bin/env bash
#
# Visszaút a VPN-kliensek felé.
#
# A PROBLÉMA, amit megold:
#   Ha ezen a gépen egy MÁSIK VPN is fut (utun*), az elviheti az alapértelmezett
#   útvonalat. Ilyenkor a WireGuard-kliensről (10.5.5.x) érkező kérés még
#   megérkezik — a router továbbítja a LAN-címre —, de a gép a VÁLASZT a másik
#   VPN tunneljébe küldi a router helyett. A kapcsolat így félúton elhal: a
#   szerveren minden hibátlannak látszik, a böngészőben mégis örökké tölt.
#
#   Ellenőrzés:  route -n get 10.5.5.2 | grep interface
#   Ha nem `en0` jön vissza, ez a szkript kell.
#
# A MEGOLDÁS:
#   Egy statikus útvonal, ami a VPN-alhálózatot kifejezetten a LAN-routerhez
#   irányítja. Ez erősebb, mint az alapértelmezett útvonal, mert konkrétabb.
#
# Használat:
#   sudo ./tools/vpn-route.sh                      # 10.5.5.0/24 a 192.168.1.1-en át
#   sudo ./tools/vpn-route.sh 10.5.5.0/24 192.168.1.1
#   sudo ./tools/vpn-route.sh --install            # újraindítás után is megmarad
#   sudo ./tools/vpn-route.sh --status             # csak megmutatja, mi a helyzet
#   sudo ./tools/vpn-route.sh --remove             # útvonal és automatika törlése
set -euo pipefail

VPN_NET="${1:-10.5.5.0/24}"
GATEWAY="${2:-}"
PLIST="/Library/LaunchDaemons/hu.mvk.vpnroute.plist"
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

# Az első paraméter kapcsoló is lehet — ilyenkor a hálózat marad az alapértelmezett.
case "${1:-}" in
  --install|--remove|--status) VPN_NET="10.5.5.0/24" ;;
esac

# A LAN-router: az en0-hoz tartozó alapértelmezett átjáró. Szándékosan NEM a
# `route get default`, mert azt épp a másik VPN téríthette el.
detect_gateway() {
  netstat -rn -f inet | awk '$1 == "default" && $NF == "en0" && !seen { print $2; seen = 1 }'
}
[ -n "$GATEWAY" ] || GATEWAY="$(detect_gateway)"

show_status() {
  echo "VPN-alhálózat : $VPN_NET"
  echo "LAN-router    : ${GATEWAY:-(nem található en0 alapértelmezett átjáró)}"
  local probe="${VPN_NET%%/*}"
  probe="${probe%.*}.2"
  echo -n "Válasz a(z) $probe felé ide menne: "
  route -n get "$probe" 2>/dev/null | awk '/interface:/ { print $2 }' || true
  echo
  echo "Aktív VPN-interfészek ezen a gépen:"
  ifconfig | awk '/^utun/ { iface=$1 } /inet / && iface { print "  " iface " " $2; iface="" }' || true
}

case "${1:-}" in
  --status)
    show_status
    exit 0
    ;;
  --remove)
    route -n delete -net "$VPN_NET" 2>/dev/null || true
    if [ -f "$PLIST" ]; then
      launchctl bootout system "$PLIST" 2>/dev/null || true
      rm -f "$PLIST"
      echo "Az automatikus útvonal-helyreállítás eltávolítva."
    fi
    echo "Kész: az útvonal törölve."
    exit 0
    ;;
esac

if [ -z "$GATEWAY" ]; then
  echo "HIBA: nem található en0 alapértelmezett átjáró. Add meg kézzel:" >&2
  echo "  sudo $0 $VPN_NET 192.168.1.1" >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "HIBA: ehhez root kell. Futtasd így:" >&2
  echo "  sudo $0 ${*:-}" >&2
  exit 1
fi

# Idempotens: ha már van ilyen útvonal, előbb elvesszük, hogy a friss átjáró
# kerüljön be (a VPN újracsatlakozása után a régi félrevihetne).
route -n delete -net "$VPN_NET" >/dev/null 2>&1 || true
route -n add -net "$VPN_NET" "$GATEWAY"
echo "Útvonal beállítva: $VPN_NET -> $GATEWAY (en0)"

if [ "${1:-}" = "--install" ]; then
  # A VPN-kliensek újracsatlakozáskor átírhatják a routing táblát, ezért az
  # útvonalat rendszeresen visszatesszük. Olcsó: pár ezredmásodperc percenként.
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>hu.mvk.vpnroute</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$SCRIPT_PATH</string>
        <string>$VPN_NET</string>
        <string>$GATEWAY</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>StartInterval</key><integer>60</integer>
    <key>StandardErrorPath</key><string>/tmp/mvk-vpnroute.log</string>
</dict>
</plist>
PLIST_EOF
  chmod 644 "$PLIST"
  launchctl bootout system "$PLIST" 2>/dev/null || true
  launchctl bootstrap system "$PLIST"
  echo "Automatika telepítve: az útvonal újraindítás és VPN-újracsatlakozás után is helyreáll."
fi

echo
show_status
