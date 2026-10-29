#!/usr/bin/env bash
# Fejlesztői élő környezet: MVK-szimulátor + worker egy rögzített nap
# visszajátszásával, a megadott pillanattól.  ./tools/dev-live.sh 2026-10-28 08:00
set -euo pipefail
cd "$(dirname "$0")/.."
DAY="${1:-2026-10-28}"; AT="${2:-08:00}"
OFF=$(node -e 'const d=new Date(process.argv[1]+"T12:00:00Z");const f=new Intl.DateTimeFormat("en-US",{timeZone:"Europe/Budapest",timeZoneName:"shortOffset"}).formatToParts(d).find(p=>p.type==="timeZoneName").value.replace("GMT","");const m=f.match(/([+-])(\d+)/);console.log(`${m[1]}${m[2].padStart(2,"0")}:00`)' "$DAY")
export DEV_CLOCK_AT="${DAY}T${AT}:00${OFF}"
set -a; . ./.env.dev; set +a
(cd tools/import-mysql && node src/mock-mvk.ts "$DAY" 8899) &
MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
sleep 4
cd apps/worker
MVK_API=http://127.0.0.1:8899 WORKER_PORT=8090 node src/main.ts
