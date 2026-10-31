# MVK API: teljes útmutató (mccaze)

Az MVK MobilON+ app (fejlesztő: HC Linear, belső neve **metaccaze**) backendje egy Spring Boot szerver. Ez a leírás minden végpontot tartalmaz, amit a projekt használ vagy kipróbált. A valódi szerveren **2026-10-31-én élőben ellenőrizve** (a ✅ jelűek 200-at adtak).

```
Alap URL:   https://mccaze.mvkzrt.hu:8443
GTFS zip:   http://84.206.68.21:8080/MVK_mobilapp/GTFS/MVK_GTFS.zip   (nem kell token)
```

---

## 1. Hitelesítés: a JWT

Minden `/api/v1/*` kéréshez kell:

```
Authorization: Bearer <JWT>
Accept: application/json          (protobufnál: application/x-protobuf, */*)
```

| Tulajdonság | Érték |
|---|---|
| Típus | JWT (`eyJ….eyJ….…`) |
| Élettartam | **~9 óra** (`exp` claim) |
| Claimek, amiket használunk | `exp`, `iat`, `installation-id` (UUID, az app telepítésének azonosítója) |
| Ki adja ki | Csak az MVK app kapja meg, **App Attesttel** (Apple eszköz-igazolás). Kézzel nem lehet „bejelentkezni”, nincs felhasználónév/jelszó. |
| Hol tárolja az app | NSUserDefaults, kulcs: `flutter.cached_backend_jwt` (Flutter app) |
| macOS-en | `~/Library/Containers/com.hclinear.metaccazeMiskolc/Data/Library/Preferences/com.hclinear.metaccazeMiskolc.plist` (csak **Teljes lemezhozzáféréssel** olvasható) |
| iOS-en | ugyanez a plist egy helyi Finder-backupban (v2: `backend/tools/extract_ios_token.py`, git `4c3e2b2`) |
| Lejárt vagy rossz token | `401` / `403` |

### 1.1 Token megszerzése: három út

**A) Token-agent (élesben ez megy).** Az `apps/token-agent/MVKTokenAgent.swift` a Macen fut. Kiolvassa a plistből a legkésőbb lejáró JWT-t, és HMAC-aláírva felküldi a szervernek (`POST /agent/token`). Ha a token 3,5 órán belül lejár, vagy az MVK elutasítja, a háttérben újraindítja az MVK appot (`open -g`), ami így friss tokent kér. Telepítés: README 4. fejezet.

**B) Kézzel a plistből** (a terminálnak Teljes lemezhozzáférés kell):

```bash
python3 - <<'EOF'
import plistlib, re, json, os
p = os.path.expanduser("~/Library/Containers/com.hclinear.metaccazeMiskolc/Data/Library/Preferences/com.hclinear.metaccazeMiskolc.plist")
s = json.dumps(plistlib.load(open(p, "rb")), default=str)
print(max(set(re.findall(r"eyJ[\w-]+\.[\w-]+\.[\w-]+", s)), key=len))
EOF
```

**C) Szerveroldali megújítás.** Ugyanezt hívja az app is. Egy még érvényes tokenből újat kér:

```bash
curl -s -X POST "https://mccaze.mvkzrt.hu:8443/api/v1/installation/generate-jwt" \
  -H "Authorization: Bearer $MVK_JWT" \
  -H "installation-id: <installation-id a JWT-ből>" \
  -H "Content-Type: application/json" -d '{}'
```

A válaszban egy új `eyJ…` JWT van. App Attest nélkül az MVK elutasíthatja; a worker ezért csak megpróbálja (`apps/worker/src/token.ts → renewToken`), és ha nem sikerül, marad az agent.

### 1.2 A token claimjeinek megnézése

```bash
echo "$MVK_JWT" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | jq .
# exp - now = hátralévő másodperc
```

### 1.3 Gyors beállítás a példákhoz

```bash
export MVK=https://mccaze.mvkzrt.hu:8443
export MVK_JWT='eyJ...'                     # lásd 1.1
alias mvk='curl -s -H "Authorization: Bearer $MVK_JWT" -H "Accept: application/json"'
```

---

## 2. Végpontok áttekintése

| # | Metódus | Útvonal | Kötelező paraméter | Válasz | Állapot |
|---|---|---|---|---|---|
| 1 | GET | `/api/v1/gtfs/get-positions` | – | GTFS-RT protobuf (VehiclePosition) | ✅ |
| 2 | GET | `/api/v1/gtfs/get-updates` | – | GTFS-RT protobuf (TripUpdate) | ✅ |
| 3 | GET | `/api/v1/gtfs/list-cancelled-trips` | – | JSON tömb (trip_id-k) | ✅ |
| 4 | POST | `/api/v1/route/plan` | body: `points`, `departureTime` | JSON útvonaltervek | ✅ |
| 5 | GET | `/api/v1/geocode/search` | `query` | JSON címlista | ✅ |
| 6 | GET | `/api/v1/geocode/reverse` | `lat`, `lon` | JSON cím | ✅ |
| 7 | GET | `/api/v1/weather/latest` | – | JSON időjárás + előrejelzés | ✅ |
| 8 | GET | `/api/v1/weather/alerts` | `lastFetch` (LocalDateTime) | JSON tömb | ✅ |
| 9 | GET | `/api/v1/news/available` | `language` | JSON hírek | ✅ |
| 10 | GET | `/api/v1/parameter/list` | – | JSON tervezési paraméterek | ✅ |
| 11 | GET | `/api/v1/gbfs/gbfs.json` | – | GBFS 2.2 index (Lime) | ✅ |
| 12 | GET | `/api/v1/gbfs/load/<feed>.json` | – | GBFS feed | ✅ |
| 13 | POST | `/api/v1/statistics/route-schedule` | (body ismeretlen) | – | GET-re `Request method 'GET' is not supported`, POST-ot nem próbáltam |
| 14 | POST | `/api/v1/installation/generate-jwt` | `installation-id` fejléc | új JWT | lásd 1.1 C |

Hibaformátum (mindegyiknél, általában HTTP 500):

```json
{"type":"SERVICE_ERROR","message":"Required request parameter 'language' ... is not present","messages":null}
```

---

## 3. Végpontok részletesen

### 3.1 Járműpozíciók: `GET /api/v1/gtfs/get-positions`

```bash
curl -s -H "Authorization: Bearer $MVK_JWT" -H "Accept: application/x-protobuf, */*" \
  "$MVK/api/v1/gtfs/get-positions" -o positions.bin
```

- `content-type: application/octet-stream`, ~3–5 KB, `FULL_DATASET`, GTFS-RT 2.0.
- Egy entitás (dekódolva):

```json
{
  "id": "1",
  "vehicle": {
    "trip": { "tripId": "10753_1835_041000_AW6", "startTime": "04:10:00", "startDate": "20261031",
              "scheduleRelationship": "SCHEDULED", "routeId": "935", "directionId": 0 },
    "position": { "latitude": 48.1059, "longitude": 20.7898, "bearing": 275.01, "odometer": 33197, "speed": 6 },
    "currentStopSequence": 4, "currentStatus": "IN_TRANSIT_TO", "stopId": "SP66",
    "timestamp": 1793420122,
    "vehicle": { "id": "49", "label": "BUS", "licensePlate": "KAH008 (49)" },
    "occupancyStatus": "EMPTY"
  }
}
```

- A járművek kb. 15 másodpercenként küldenek új pozíciót; a worker 2,5 másodpercenként kérdez le (`POLL_MS`).

### 3.2 Menet-előrejelzések: `GET /api/v1/gtfs/get-updates`

Ugyanúgy hívandó, mint a 3.1. ~24 KB, TripUpdate entitások `stopTimeUpdate[]` listával (`stopSequence`, `stopId`, `arrival/departure.{delay,time}`). A `delay` másodpercben van, a negatív érték sietést jelent.

**Dekódolás (Node):**

```js
// npm i gtfs-realtime-bindings
const G = require("gtfs-realtime-bindings");
const buf = require("fs").readFileSync("positions.bin");
const m = G.transit_realtime.FeedMessage.decode(buf);
console.log(JSON.stringify(G.transit_realtime.FeedMessage.toObject(m, { longs: Number, enums: String }), null, 2));
```

### 3.3 Törölt menetek: `GET /api/v1/gtfs/list-cancelled-trips`

```bash
mvk "$MVK/api/v1/gtfs/list-cancelled-trips"
# []   vagy   ["10753_1835_041000_AW6", ...]   (lehet {"trips":[...]} vagy objektumok tripId/trip_id/id mezővel)
```

A lista **naptári napra** szól, és éjfélkor vált. A szolgáltatási nap viszont 03:00-kor vált (lásd 4.).

### 3.4 Útvonaltervező: `POST /api/v1/route/plan`

```bash
curl -s -X POST "$MVK/api/v1/route/plan" \
  -H "Authorization: Bearer $MVK_JWT" -H "Content-Type: application/json" \
  -d '{
    "points": [ {"lat":48.0962,"lon":20.7547}, {"lat":48.1035,"lon":20.7784} ],
    "departureTime": "2026-10-31T10:00:00",
    "travelProfiles": ["TRANSIT"],
    "wheelchairAccessible": false
  }'
```

| Mező | Kötelező | Megjegyzés |
|---|---|---|
| `points` | igen | `[from, to]`, `{lat, lon}` |
| `departureTime` | igen | **Budapesti helyi idő**, zóna nélkül. A `Z` végződést figyelmen kívül hagyja (10:00Z → 10:00 helyi), a `+01:00` pedig **500-at** ad. |
| `travelProfiles` | nem | Enum: `TRANSIT`, `CAR`, `WALK`, `BICYCLE`, `BICYCLE_RENT`, `SCOOTER_RENT`, `MULTIMODAL`. Ha kimarad, mindegyiket visszaadja (~15 terv). |
| `wheelchairAccessible` | nem | bool |

Válasz:

```json
{
  "logHeaderId": 16295,
  "trips": [{
    "logDetailsId": 82531, "travelProfile": "TRANSIT",
    "start": "2026-10-31T10:04:30", "end": "...", "durationSec": 908, "distanceMeter": 2313,
    "elevationMeter": 0, "cost": 0, "co": 0, "health": 0.0, "utilityScore": 52,
    "legs": [{
      "mode": "BUS", "routeShortName": "21", "routeLongName": "...", "routeColor": "...",
      "polyline": "<encoded polyline>", "routeId": "...", "tripId": "...",
      "fromStopId": "...", "fromName": "...", "from": {"lat":0,"lon":0},
      "toStopId": "...", "toName": "...", "to": {"lat":0,"lon":0},
      "start": "...", "end": "...", "durationSec": 0, "distanceMeter": 0, "elevationMeter": 0,
      "intermediateStopNames": ["..."]
    }]
  }]
}
```

A `mode` értékei: `WALK`, `BUS`, `TRAM`, `CAR`, `BICYCLE`, … A visszakapott időpontok is helyi idők, zóna nélkül.

### 3.5 Címkeresés: `GET /api/v1/geocode/search?query=`

```bash
mvk "$MVK/api/v1/geocode/search?query=$(python3 -c 'import urllib.parse;print(urllib.parse.quote("Városház tér"))')"
```

Egy tömböt ad vissza, elemenként: `country, countryCode, state, stateDistrict, region, county, city, cityDistrict, suburb, neighbourhood, postcode, road, houseNumber, lat, lon`. A `lat` és `lon` **string**. Országos keresés, ezért a „Tiszai” lekérdezés más városokat is hoz; ha Miskolcra kell, írd hozzá a „Miskolc” szót.

### 3.6 Fordított geokódolás: `GET /api/v1/geocode/reverse?lat=&lon=`

```bash
mvk "$MVK/api/v1/geocode/reverse?lat=48.1035&lon=20.7784"
# {"city":"Miskolc","suburb":"Belváros","road":"Városház tér","houseNumber":"8","postcode":"3525",...}
```

### 3.7 Időjárás: `GET /api/v1/weather/latest`

```bash
mvk "$MVK/api/v1/weather/latest"
```

Mezők: `airPollution {aqi, timestamp}`, `current {dt, temp, weatherType, icon}`, `hourlyForecasts[] {dt, temp, weatherType, icon}`. A `weatherType` enum, pl. `CLEAR`, `FEW_CLOUDS_11_25`, `SCATTERED_CLOUDS_25_50`, `BROKEN_CLOUDS_51_84`, `OVERCAST_CLOUDS_85_100`. Az `icon` OpenWeather-kód.

### 3.8 Időjárási riasztások: `GET /api/v1/weather/alerts?lastFetch=`

```bash
mvk "$MVK/api/v1/weather/alerts?lastFetch=2026-10-30T00:00:00"   # []
```

A `lastFetch` kötelező, `LocalDateTime` formátumú (zóna nélkül).

### 3.9 Hírek: `GET /api/v1/news/available?language=hu`

```bash
mvk "$MVK/api/v1/news/available?language=hu"
```

A `language` kötelező (`hu`/`HU` egyformán működik). Elemenként: `id, title, type, shortContent, longContent (HTML, entitásokkal), modifiedTime, validityStart, validityEnd`.

Megfigyelések (2026-10-31, 10 hír): a `shortContent` mindig a címmel egyezik; a `type` szinte mindig `Egyéb` (egy `Rendezvény`); a `longContent` csak `p`, `a`, `em`, `strong`, `br` taget használ, a felsorolások `;`-vel záruló külön bekezdések, egy hír pedig sima szöveg üres sorokkal. Az időpontok zóna nélküli budapesti helyi idők. A `validityStart` a közzététel napja, nem az esemény kezdete.

A webapp nem ezt hívja közvetlenül: a worker `GET /engine/news` végpontja 10 percig tárolja, szerkezetes blokkokra bontja (bekezdés, alcím, címke, lista), és felismeri a szövegben említett járatokat (`packages/core/src/news.ts`). Ha az MVK nem válaszol, a legutóbbi jó lista megy ki `stale: true` jelzéssel.

### 3.10 Tervezési paraméterek: `GET /api/v1/parameter/list`

Elemenként `{id, name, type, minValue, maxValue, value, description, unit}`. A jelenlegi értékek:

| name | value | jelentés |
|---|---|---|
| WALK_SPEED | 4.82 | gyaloglási sebesség, km/h |
| BIKE_SPEED | 17 | kerékpársebesség, km/h |
| WALK_KCAL / BIKE_KCAL / MIKRO_KCAL | 295 / 450 / 450 | kcal/óra |
| PASS | TRUE | van-e bérlete a felhasználónak |
| PASS_PRICE / PASS_MONTHLY_USAGE | 0 / 40 | bérlet ára, havi használat |
| MIKRO_PRICE / MIKRO_UNLOCK_FEE | 0 / 269 | roller díja, Ft |
| CAR_KM / USER_CAR | 30 / 4 | autó Ft/km, autótípus (1–6) |
| TRIP_DURATION / TRIP_COST / ENVIRONMENT_FRIENDLY / CALORIES_BURNED | 2 | súlyok (1 nem számít, 3 nagyon fontos) |

### 3.11 Mikromobilitás (GBFS): `GET /api/v1/gbfs/gbfs.json` és `/api/v1/gbfs/load/<feed>.json`

```bash
mvk "$MVK/api/v1/gbfs/gbfs.json"
mvk "$MVK/api/v1/gbfs/load/free_bike_status.json"
```

Lime rolleres és kerékpáros adatok, GBFS 2.2/2.3 szabvány szerint. Feedek: `system_information`, `free_bike_status` (~145 KB, `ttl` 60 s), `system_pricing_plans`, `geofencing_zones`, `vehicle_types`, `station_information`, `station_status`.

### 3.12 GTFS menetrend (nincs token)

```bash
curl -s -o MVK_GTFS.zip http://84.206.68.21:8080/MVK_mobilapp/GTFS/MVK_GTFS.zip
```

Szinte naponta új verzió jön (pl. `20261031-1`). **Használat előtt mindig ellenőrizd**: 2026-10-27-én üres zip jelent meg.

---

## 4. Buktatók (élőben ellenőrizve)

1. **A GTFS-RT `timestamp` és `time` mezői budapesti helyi időt kódolnak unix időként.** A header timestamp 3597 másodperccel járt a valódi UTC előtt (CET, +1 óra). Valódi UTC = érték − budapesti eltolás (télen 3600, nyáron 7200).
2. **A `trip_id` formátuma** `<service>_<shape>_<HHMMSS>_<kód>` (pl. `10753_1835_041000_AW6`). A GTFS-ben nincs `block_id`. Két feed-verzió között a `shape|első indulás` alapján lehet összepárosítani.
3. **Éjfél utáni menetek**: a GTFS-ben 00:xx–02:xx idővel az előző esti szolgáltatási naphoz tartoznak; a szolgáltatási nap 03:00-kor vált.
4. **Az útvonaltervező** időzóna nélküli helyi időt vár és ad vissza (lásd 3.4).
5. **Lejárt tokennel** 401/403 jön. Ne kérdezd le 2,5 másodpercenként, mert úgysem sikerül (a worker ilyenkor leáll a pollozással).
6. Minden hibaüzenet `SERVICE_ERROR` JSON. A szöveg megmondja, melyik paraméter hiányzik; így derült ki a `language` és a `lastFetch`.

---

## 5. Token nélkül: a saját proxyn át

A worker `/api/*` útvonala a szerver tokenjét teszi a kérésbe. Csak az utas-oldali, olvasó végpontok érhetők el, IP-címenként 120 kérés/perc korláttal (`apps/worker/src/http/compat.ts → PROXY_ALLOW`):

```bash
curl -s https://mvk.futozs.hu/api/v1/weather/latest
curl -s https://mvk.futozs.hu/api/v1/news/available?language=hu
curl -s -X POST -H 'content-type: application/json' https://mvk.futozs.hu/api/v1/route/plan \
  -d '{"points":[{"lat":48.0962,"lon":20.7547},{"lat":48.1035,"lon":20.7784}],"departureTime":"2026-10-31T10:00:00"}'
```

Engedett útvonalak: `POST route/plan`, `GET geocode/(search|reverse)`, `GET gbfs/*`, `GET news/*`, `GET weather/(latest|alerts)`, `GET parameter/list`, `GET statistics/*`, `GET gtfs/(get-positions|get-updates|list-cancelled-trips)`. Bármely más végponthoz a rendszer-hub **MVK API → API-vizsgáló** felülete kell (LAN-only, `/system/mvk-call`).

Token beküldése kézzel a szervernek:

```bash
curl -X POST -H "X-Admin-Key: $ADMIN_KEY" --data "$MVK_JWT" https://mvk.futozs.hu/_ingest
curl -s https://mvk.futozs.hu/_health | jq .jwt        # present, expiresInSec, installationId
```

---

## 6. Hol van a kódban

| Mi | Fájl |
|---|---|
| Upstream kliens (Bearer, időkorlát, 401/403) | `apps/worker/src/mvk.ts` |
| Token tárolás, megújítás (`generate-jwt`) | `apps/worker/src/token.ts` |
| Alap URL, GTFS URL, poll-időközök | `apps/worker/src/config.ts` (`MVK_API`, `MVK_GTFS_URL`, `POLL_MS`) |
| Pollozás (positions, updates, cancelled) | `apps/worker/src/engine.ts` |
| Proxy allowlist | `apps/worker/src/http/compat.ts` |
| Hírek: letöltés, gyorsítótár (`/engine/news`) | `apps/worker/src/news.ts` |
| Hírek: HTML → blokkok, járatfelismerés | `packages/core/src/news.ts` |
| Token-agent (macOS) | `apps/token-agent/MVKTokenAgent.swift` |
| MVK-szimulátor fejlesztéshez (:8899) | `tools/import-mysql/src/mock-mvk.ts` |
