#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# direct.sh — KÖZVETLEN MVK API hívás PROXY NÉLKÜL.
# A tokent a backend/state/jwt.txt-ből olvassa, a valódi szervert hívja
# (https://mccaze.mvkzrt.hu:8443) és a terminálba írja a választ.
#
# A protobuf végpontoknál (positions/updates) KÉT mód van:
#   ./direct.sh positions            # RAW — amit a szerver kidob (nyers protobuf)
#   ./direct.sh positions decoded    # DECODED — olvasható JSON
#
# Egyéb:
#   ./direct.sh updates [decoded]    # GTFS-RT trip-frissítések
#   ./direct.sh cancelled            # törölt járatok
#   ./direct.sh geocode "Tiszai"     # címkeresés
#   ./direct.sh reverse 48.10 20.79  # fordított geokód
#   ./direct.sh route                # útvonalterv (minta body)
#   ./direct.sh gbfs                 # GBFS (bringák/rollerek)
#   ./direct.sh weather | alerts     # időjárás / riasztások
#   ./direct.sh news | params | stats
#   ./direct.sh token                # a token lejárata (helyben)
#   ./direct.sh raw /api/v1/....      # tetszőleges path (HTTP fejlécekkel)
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
BASE="https://mccaze.mvkzrt.hu:8443"
JWT_FILE="$DIR/backend/state/jwt.txt"

TOKEN="$(tr -d '[:space:]' < "$JWT_FILE" 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then echo "❌ Nincs token: $JWT_FILE üres/hiányzik."; exit 1; fi
AUTH=(-H "Authorization: Bearer $TOKEN" -H "Accept: application/json")

pretty(){ if command -v jq >/dev/null; then jq .; else cat; fi; }
urlenc(){ python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$1"; }

# RAW: nyers választ stdout-ra, státusz/méret stderr-re
get_raw(){ local tmp; tmp="$(mktemp)"; local code
  code="$(curl -s -o "$tmp" -w '%{http_code}|%{size_download}|%{content_type}' "${AUTH[@]}" "$BASE$1")"
  echo "→ HTTP ${code//|/ · } (nyers — fájlba irányítható: ./direct.sh ... > out.bin)" >&2
  cat "$tmp"; echo; rm -f "$tmp"; }

# DECODED: protobuf → JSON (backend node_modules gtfs-realtime-bindings)
get_decoded(){ curl -s "${AUTH[@]}" "$BASE$1" | ( cd "$DIR/backend" && node --input-type=module -e '
  import G from "gtfs-realtime-bindings";
  const c=[]; for await (const x of process.stdin) c.push(x);
  const buf=Buffer.concat(c);
  if(!buf.length){ console.error("(üres — lejárt token? ./direct.sh token)"); process.exit(1); }
  const feed=G.transit_realtime.FeedMessage.decode(new Uint8Array(buf));
  console.log(JSON.stringify(feed.toJSON(),null,2));
  console.error("→ "+feed.entity.length+" entitás");
' ); }

echo "→ $BASE  (token: ${TOKEN:0:12}…)" >&2
cmd="${1:-positions}"; shift || true
mode="${1:-}"
case "$cmd" in
  positions) [ "$mode" = "decoded" ] || [ "$mode" = "d" ] && get_decoded /api/v1/gtfs/get-positions || get_raw /api/v1/gtfs/get-positions ;;
  updates)   [ "$mode" = "decoded" ] || [ "$mode" = "d" ] && get_decoded /api/v1/gtfs/get-updates   || get_raw /api/v1/gtfs/get-updates ;;
  cancelled) curl -s "${AUTH[@]}" "$BASE/api/v1/gtfs/list-cancelled-trips" | pretty ;;
  geocode)   curl -s "${AUTH[@]}" "$BASE/api/v1/geocode/search?query=$(urlenc "${1:-Tiszai}")" | pretty ;;
  reverse)   curl -s "${AUTH[@]}" "$BASE/api/v1/geocode/reverse?lat=${1:-48.10}&lon=${2:-20.79}" | pretty ;;
  route)     curl -s "${AUTH[@]}" -H "Content-Type: application/json" -X POST "$BASE/api/v1/route/plan" \
               -d '{"travelProfiles":["eco"],"departureTime":"2026-08-29T08:00:00Z","wheelchairAccessible":false}' | pretty ;;
  gbfs)      curl -s "${AUTH[@]}" "$BASE/api/v1/gbfs/gbfs.json" | pretty ;;
  weather)   curl -s "${AUTH[@]}" "$BASE/api/v1/weather/latest" | pretty ;;
  alerts)    curl -s "${AUTH[@]}" "$BASE/api/v1/weather/alerts" | pretty ;;
  news)      curl -s "${AUTH[@]}" "$BASE/api/v1/news/available" | pretty ;;
  params)    curl -s "${AUTH[@]}" "$BASE/api/v1/parameter/list" | pretty ;;
  stats)     curl -s "${AUTH[@]}" "$BASE/api/v1/statistics/route-schedule" | pretty ;;
  token)     node -e 'const t=process.argv[1].split(".")[1];const c=JSON.parse(Buffer.from(t,"base64"));const s=c.exp-Math.floor(Date.now()/1000);console.log(JSON.stringify(c,null,2));console.error("→ lejárat: "+Math.floor(s/60)+" perc múlva")' "$TOKEN" ;;
  raw)       curl -s -i "${AUTH[@]}" "$BASE${1:-/api/v1/gtfs/get-positions}" ;;
  *)         echo "ismeretlen: $cmd (lásd a fejlécet)"; exit 1 ;;
esac
