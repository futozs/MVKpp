# MVK MobilON+ — élő dashboard (backend + frontend)

Élő buszkövetés Miskolcra: valós idejű járműpozíciók a térképen + valós érkezési
idők a megállóknál (GTFS-RT), a saját appod tokenjével.

```
files/
├── backend/     Hono + TS: proxy + GTFS-RT dekód + valós érkezések + token-mentés
│   ├── src/index.ts      a szerver
│   ├── state/jwt.txt      a token (újraindítás túléli)
│   ├── gtfs/*.txt         statikus GTFS (megállók, menetrend)
│   ├── tools/extract_ios_token.py   token újraszedő iPad backupból
│   └── deploy/            systemd + Pi telepítő
└── frontend/
    └── dashboard.html    a térkép (a backend szolgálja ki a /-on)
```

## Futtatás (Mac vagy Pi)

```bash
cd backend
npm install          # egyszer
npm run build        # egyszer (Node >= 20); Mac-en Node 26 alatt kihagyható
npm start            # -> http://localhost:8088
```
Nyisd meg: **http://localhost:8088** — ott a dashboard élő buszokkal.

A token a `state/jwt.txt`-ben van → **bármennyiszer újraindíthatod**, megmarad.

## Végpontok

| Út | Mit ad |
|---|---|
| `/` | a dashboard |
| `/live/positions` | élő járműpozíciók (protobuf → JSON) |
| `/live/arrivals?stop=SP1&limit=10` | **valós érkezések** egy megállóhoz (RT + menetrend) |
| `/live/updates` | GTFS-RT frissítések összegzés |
| `/live/vehicle?id=1641` | **egy jármű élő állapota**: `inService` + pozíció (üres, ha nincs bevetésen) |
| `/gtfs/route-geo?route=20,1V` | járat(ok) vonalgeometriája + érintett megállói (a járatszűrőhöz) |
| `/gtfs/stops.json`, `/gtfs/routes.json` | statikus adat a frontendnek |
| `/api/*` | nyers MVK API, Bearer beinjektálva |
| `/_health` `/_ingest` `/_export` `/_renew` | token-kezelés |

## Token frissítése (ha lejárt, ~9 óránként)

A megújítás a szerveroldalon attesztációt kér (a `/_renew` 403), ezért a tokent az
**iPadről** kell utántölteni (ott az App Attest megújítja):

1. Nyisd meg egyszer az MVK appot az iPaden (frissíti a tokent).
2. Finder → iPad → **helyi backup a Macre** (titkosítatlan). *(Inkrementális, gyors.)*
3. A backup a TCC-védett `~/Library/Application Support/MobileSync/Backup/` alatt van —
   húzd ki a hosszú nevű mappát egy szabad helyre (pl. `files/ipad_backup/`).
4. ```bash
   python3 backend/tools/extract_ios_token.py \
     --backup /Users/futozs/Downloads/files/ipad_backup/<UDID> \
     --ingest http://localhost:8088
   ```
Kész — a backend viszi tovább, nem kell újraindítani.

## Raspberry Pi (0–24)

```bash
sudo bash deploy/install-pi.sh      # Node + build + systemd service
# token átvitele a Macről a Pi-re:
curl -s http://localhost:8088/_export > token.json
curl -X POST http://<PI-IP>:8088/_ingest -H 'Content-Type: application/json' -d @token.json
```
`HOST=0.0.0.0` (a service-ben) → a Pi IP-jén a LAN-ról is elérhető a dashboard.

## Jogi/hatókör
Kizárólag a saját, jogszerűen birtokolt appod interoperabilitási vizsgálatához.
A backend a genuine app által kiadott tokent használja újra; nem tör fel semmit.
