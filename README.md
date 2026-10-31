# MVK++ — valós idejű buszkövető Miskolcra

Next.js webapp + valós idejű worker + macOS token-agent, Postgres/TimescaleDB-n, Upstash Redis gyorsítótárral.

- **Megállófigyelő**: a szerver WebSocketen küldi a változást (busz beért, elindult, új késés) — rendszám, hol jár, mennyit késik/siet, előre jelzett rendszám.
- **Térkép** élő járművekkel és **idővonallal** (bármelyik múltbeli nap visszajátszása).
- **Menetrend** élő indulás/érkezés naplóval, megállónkénti tényadattal.
- **Útvonaltervező** (RAPTOR): késés-előrejelzés és átszállási kockázat; **múltbeli tervezés** a ténylegesen lezajlott menetekkel.
- **Statisztika**: hálózat (csúcsidők, lassú szakaszok), vonalak, megállók, járművek, üzemzavarok.
- **Rendszám-előrejelzés** minden kint lévő buszra, órákra előre (forda-terv), önjavító súlyokkal.
- **Kijelző** (`/kijelzo`): utastájékoztató tévére vagy tabletre — 1–3 megálló egymás mellett, élőben, nagy betűkkel; a Figyelőből indítható.
- **Késés-előrejelzés megállónként**: a mostani késésből és az elmúlt 8 hét szakaszidejeiből — „ide várhatóan +3 perccel ér, legrosszabb esetben +5” (visszamérve: 3 megállóra 46 mp átlagos hiba, a felső becslés ~85%-ban tart).
- **Felszálltam + Utazásaim**: a követett buszra „Felszálltam”, vagy a nyitott térkép magától felismeri, ha együtt mozogsz egy busszal; utazás közben élő késés, várható és legkésőbbi érkezés minden megállóra. Az utazások a telefonon gyűlnek, bejelentkezve a felhőbe is (Statisztika → Utazásaim: km, idő, begyűjtött rendszámok).
- **Forda-tábla** (a Parkoló oldalon): a flotta napja idővonalon — lefutott menetek és a forda-terv szerinti következők.
- **Parkoló**: ki áll most melyik végállomáson, ki van a kocsiszínben (G-járattal beállt, 1 órája néma, vagy ma még nem volt kint) — buszra és villamosra, a következő indulás tippjével, 14 napos kiállási előzménnyel; a kedvenc parkolók elöl állnak és a felhőbe mentődnek.
- **Fiók** passkey-vel, minden beállítás kétirányú felhős szinkronnal; **push-értesítés** kézbesítési naplóval.
- A nyers GPS-adat örökre megmarad; ha az MVK nem ad ki menetrendet, automatikus fallback az utolsó jóra.
- **Volán és vasút Borsod-Abaúj-Zemplénben** a MÁV+ (OTP2) adataiból: térkép, figyelő (állomás vágánnyal, viszonylat, vonatszám), menetrend, tervező, utazásnapló, statisztika, push — módonként kikapcsolható. A MÁV+ az **MVK tartaléka** is: token-hiba (401/403) vagy egyperces kiesés esetén innen jönnek az MVK járművei. Részletek: [docs/MAVPLUSZ_OTP2.md](docs/MAVPLUSZ_OTP2.md).

Az architektúra és a v2-hibák részletei: [docs/v3.md](docs/v3.md).

---

## Tartalom

1. [Melyik gépen mi fut?](#1-melyik-gépen-mi-fut)
2. [Szerver telepítése (VPS, Docker Compose)](#2-szerver-telepítése-vps-docker-compose)
3. [Upstash Redis (gyorsítótár)](#3-upstash-redis-gyorsítótár)
4. [Token-agent a Macen (MVK app + token)](#4-token-agent-a-macen-mvk-app--token)
5. [A token útja — hova és hogyan küldjük (kézzel is)](#5-a-token-útja--hova-és-hogyan-küldjük-kézzel-is)
6. [Minden egy Macen](#6-minden-egy-macen)
7. [A régi (v2) adatok átvitele](#7-a-régi-v2-adatok-átvitele)
8. [Fejlesztés helyben](#8-fejlesztés-helyben)
9. [Mappaszerkezet](#9-mappaszerkezet)
10. [Környezeti változók](#10-környezeti-változók)
11. [Üzemeltetés](#11-üzemeltetés)
12. [Rendszer-hub (belső hálós vezérlőpult)](#12-rendszer-hub-belső-hálós-vezérlőpult)

---

## 1. Melyik gépen mi fut?

```
┌──────────────── Mac (bérelt vagy saját) ────────────────┐
│  MVK MobilON+ app  ──(plist)──►  mvk-token-agent         │──┐  HMAC-aláírt POST /agent/token
└──────────────────────────────────────────────────────────┘  │  (kb. 6 óránként új token)
                                                              ▼
┌──────────────────────── Szerver (VPS) — Docker Compose ─────────────────────────┐
│  caddy (HTTPS) ──► worker  :8090  MVK-pollozás, illesztés, WebSocket, push, API │
│                └─► web     :3000  Next.js felület + /stats /account /push /v3   │
│  db: Postgres 17 + TimescaleDB + PostGIS (a port kívülről zárt)                 │
└──────────────────────────────┬──────────────────────────────────────────────────┘
                               └──► Upstash Redis (REDIS_URL) — közös gyorsítótár
```

| Felállás | Mit telepítesz hova | Fejezet |
|---|---|---|
| **A) Ajánlott:** VPS + külön Mac a tokenhez | VPS: Docker Compose (db, worker, web, caddy). Mac: csak a token-agent. | [2](#2-szerver-telepítése-vps-docker-compose), [3](#3-upstash-redis-gyorsítótár), [4](#4-token-agent-a-macen-mvk-app--token) |
| **B) Minden egy Macen** | Ugyanaz a Mac futtatja a Docker Compose-t és a token-agentet | [6](#6-minden-egy-macen) |
| **C) Csak token-agent** | Egy Mac, ami csak tokent küld egy máshol futó szervernek | [4](#4-token-agent-a-macen-mvk-app--token) |
| **D) Fejlesztői gép** | Helyi db (Docker) + worker egy rögzített nap visszajátszásával + `next dev` | [8](#8-fejlesztés-helyben) |

Az iOS app ugyanazokat a v2-végpontokat hívja (`/live/*`, `/gtfs/*`, `/stats/*`, `/push/*`, `/account/*`, `/weather`, `/_health`) — ezek útvonala és válaszformája nem változott, csak új mezők jöttek.

---

## 2. Szerver telepítése (VPS, Docker Compose)

**Kell:** Linux VPS (2 vCPU / 4 GB RAM elég), Docker + Docker Compose v2, egy domain, aminek az A-rekordja a VPS-re mutat, nyitott 80-as és 443-as port.

> A passkey-k a domainhez kötődnek: ha a régi rendszer domainjét használod, a meglévő fiókok változatlanul működnek.

```bash
git clone <repo-url> mvk && cd mvk
cp infra/.env.example infra/.env
```

Töltsd ki az `infra/.env`-t:

| Változó | Honnan |
|---|---|
| `DOMAIN` | a domain, pl. `mvk.pelda.hu` |
| `POSTGRES_PASSWORD`, `APP_SECRET`, `ADMIN_KEY`, `AGENT_SECRET` | mindegyik: `openssl rand -hex 32` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | **a régi szerver kulcspárja**, különben a meglévő push-feliratkozások nem kapnak értesítést. Új telepítésnél: `npx web-push generate-vapid-keys` |
| `REDIS_URL` | Upstash kapcsolati szöveg — lásd [3.](#3-upstash-redis-gyorsítótár) (üresen is működik) |
| `PG_SHARED_BUFFERS`, `PG_CACHE` | a RAM-hoz igazítva (4 GB → `1GB` / `3GB`) |

Az `APP_SECRET`-et őrizd meg: ezzel van titkosítva a tárolt MVK-token, ha elveszik, a tárolt tokenek olvashatatlanok. Az `AGENT_SECRET` kell majd a Macen is.

Ha a régi adatokat is át akarod hozni, **most** csináld meg a [7. fejezet](#7-a-régi-v2-adatok-átvitele) A) útját, és csak utána indíts. Indítás:

```bash
docker compose -f infra/docker-compose.yml --env-file infra/.env up -d --build
docker compose -f infra/docker-compose.yml --env-file infra/.env logs -f worker
```

A worker induláskor lefuttatja az adatbázis-migrációt, letölti a GTFS-t, és vár a tokenre (`nincs MVK token` a naplóban, amíg a Mac nem küld). Ellenőrzés:

```bash
curl -s https://mvk.pelda.hu/_health      # jwt.present, expiresInSec, poll
curl -s https://mvk.pelda.hu/system/info  # cache.backend: "redis", cache.redis: "ready"
```

**Frissítés:** `git pull && docker compose -f infra/docker-compose.yml --env-file infra/.env up -d --build`.

---

## 3. Upstash Redis (gyorsítótár)

A web és a worker közös, kétszintű gyorsítótárat használ (`packages/cache`): a folyamat memóriája + Redis. A Redis újraindítás után is megmarad, és több web-példány között közös.

1. [console.upstash.com](https://console.upstash.com) → **Create Database** → régió: **eu-central-1 (Frankfurt)**, típus: Regional.
2. A database oldalán **Connect** → a **Redis** (nem REST) fül → másold ki a `rediss://default:<jelszó>@<név>.upstash.io:6379` szöveget.
3. Írd be az `infra/.env`-be: `REDIS_URL=rediss://default:…@….upstash.io:6379`, majd `docker compose … up -d`.

Ennyi. Ellenőrzés: `/system/info` → `cache.backend: "redis"`, `cache.redis: "ready"`; a worker naplójában induláskor: `gyorsítótár: memória + Redis (REDIS_URL)`.

| Mit tárol | Meddig |
|---|---|
| statisztika (`/stats/*`, `/v3/stats/*`) | ma: 1 perc, lezárt napok: 10–30 perc |
| menetrend (`/gtfs/timetable*`), a GTFS-verzióhoz kötve | ma: 10 perc, más nap: 1 óra |
| idővonal (`/engine/history/*`) lezárt ablakai | 1 nap – 1 hét |
| múltbeli útvonaltervek, szakasz-becslések | 2 perc – 1 nap |
| múltbeli menetnaplók (`/gtfs/trip-journal`) | 6 óra |

A nagy értékek gzip-pel tömörítve mennek a Redisbe (4 MB fölött csak memóriában maradnak). Az élő adat (járműpozíciók, megállófigyelő) **nincs** gyorsítótárazva — az WebSocketen megy. Ha a Redis nem elérhető, semmi sem áll le: a rendszer újraszámol, és percenként egyszer figyelmeztet a naplóban. `REDIS_URL` nélkül minden csak memóriában cache-el.

---

## 4. Token-agent a Macen (MVK app + token)

Az MVK API-hoz egy kb. 9 órás JWT kell, amit csak az MVK MobilON+ app kap meg. A `mvk-token-agent` (Swift, `apps/token-agent/`) egy Macen fut, és:

- fél percenként (a szerver kérésére; legfeljebb `checkEveryMinutes`-enként) megkérdezi a szervert (`/agent/status`), meddig él még a szerver tokenje, és van-e parancs a rendszer-hubból; ha a szerver nem érhető el (pl. gépindításkor még nem fut a Docker stack), 15 mp-től 2 percig növekvő szünettel újrapróbálja;
- a hub parancsait a lemezre is felírja (`pending-commands.json` a konfiguráció mellett), így ha közben leáll, újraindulás után lezárja a félbemaradtat (restart-app után elindítja az appot, ha bezárva maradt), és pótolja az el nem jutott nyugtát;
- ha 3,5 órán belül lejár, vagy az MVK elutasította: **a háttérben újraindítja az MVK appot** (`open -g`, nem veszi el a fókuszt), megvárja, hogy friss tokent kapjon, **kiolvassa a plistjéből**, és HMAC-aláírva **felküldi** (`/agent/token`) — így a token kb. 6 óránként cserélődik;
- közben az appot futva tartja, hogy az magától is frissíthessen.

### Telepítés

1. **App Store → MVK MobilON+**, nyisd meg egyszer kézzel, fogadd el, amit kér.
2. Swift fordító: `xcode-select --install`.
3. Másold a gépre az `apps/token-agent` mappát (vagy klónozd a repót), és futtasd:

   ```bash
   cd apps/token-agent
   ./install.sh <szerver-url> <AGENT_SECRET> [agent-név]
   ```

   | Hol fut a szerver | `<szerver-url>` |
   |---|---|
   | VPS (Caddy mögött) | `https://mvk.pelda.hu` |
   | ugyanezen a Macen (Docker Compose) | `http://127.0.0.1:8090` |
   | fejlesztői worker | `http://127.0.0.1:8090` |

   Az `<AGENT_SECRET>` ugyanaz, mint a szerver `infra/.env`-jében. Az `agent-név` alapból a gép neve; több Mac esetén mindegyiknek más legyen (a szerver mindig a legkésőbb lejáró tokent használja).

4. **Egyszeri kézi lépés:** Rendszerbeállítások → Adatvédelem és biztonság → **Teljes lemezhozzáférés** → [+] → Cmd+Shift+G, és add hozzá:
   `~/Library/Application Support/MVKTokenAgent/mvk-token-agent`
   Enélkül a macOS nem engedi kiolvasni az app tokenjét.

5. A Mac **ne aludjon el**, és a felhasználó legyen bejelentkezve (az agent a bejelentkezett munkamenetben fut): Rendszerbeállítások → Energia → „Automatikus alvás megakadályozása”, Felhasználók → automatikus bejelentkezés. Szerverként: `sudo pmset -a sleep 0 disksleep 0`.

### Futtatás és ellenőrzés

A telepítő `launchd` alá teszi (`hu.mvk.token-agent`): bejelentkezéskor elindul, leállás után újraindul. Kézzel:

```bash
AGENT="$HOME/Library/Application Support/MVKTokenAgent/mvk-token-agent"
"$AGENT" status                     # van-e olvasható token, hány perc van hátra
"$AGENT" once                       # egy kör most: státusz → (app-újraindítás) → küldés
tail -f ~/Library/Logs/mvk-token-agent.log
launchctl kickstart -k gui/$(id -u)/hu.mvk.token-agent   # újraindítás
launchctl bootout gui/$(id -u)/hu.mvk.token-agent        # leállítás
```

Eltávolítás: `launchctl bootout …`, majd töröld a `~/Library/LaunchAgents/hu.mvk.token-agent.plist` fájlt és a `~/Library/Application Support/MVKTokenAgent` mappát.

**Beállítások:** `~/Library/Application Support/MVKTokenAgent/config.json` (módosítás után `launchctl kickstart -k …`):

| Mező | Alap | Jelentés |
|---|---|---|
| `serverUrl` | — | a szerver címe (lásd fent) |
| `agentSecret` | — | = a szerver `AGENT_SECRET`-je |
| `agentId` | gépnév | az agent neve a szerver naplójában |
| `bundleId` | `com.hclinear.metaccazeMiskolc` | az MVK app azonosítója |
| `refreshBelowHours` | `3.5` | ennél kevesebb hátralévő időnél kér új tokent |
| `checkEveryMinutes` | `10` | ellenőrzési gyakoriság |
| `restartCooldownMinutes` | `30` | két app-újraindítás között legalább ennyi idő |
| `appWarmupSeconds` | `75` | ennyit vár újraindítás után a token kiolvasásával |

**Hibakeresés** (a naplóban):

- `/agent/status → HTTP 401` — rossz `agentSecret`, vagy a Mac órája 5 percnél többet téved.
- `/agent/status → HTTP 0` — a szerver nem elérhető (URL, tűzfal, DNS).
- `a plist nem olvasható` — hiányzik a Teljes lemezhozzáférés (4. lépés).
- `nincs token a plistben` — nyisd meg egyszer kézzel az MVK appot.

---

## 5. A token útja — hova és hogyan küldjük (kézzel is)

**Automatikusan** (az agent): `POST <szerver>/agent/token`

```
X-Agent-Ts:        <unix másodperc>
X-Agent-Id:        <agent-név>
X-Agent-Signature: hex(HMAC-SHA256(AGENT_SECRET, "<ts>.<nyers törzs>"))
{"jwt": "<token>", "installationId": "…", "agentId": "…", "info": {…}}
```

A szerver ±5 percnél régebbi aláírást nem fogad el. A tokent `APP_SECRET`-tel (AES-256-GCM) titkosítva tárolja, és mindig a legkésőbb lejárót használja. VPS-en a Caddy a `/agent/*` utat a workerhez irányítja.

**Kézzel** (vészhelyzetben, ha nincs Mac kéznél) — admin-kulccsal:

```bash
curl -X POST -H "X-Admin-Key: $ADMIN_KEY" --data "<JWT>" https://mvk.pelda.hu/_ingest
# vagy installation-id-vel együtt:
curl -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
     --data '{"jwt":"<JWT>","installationId":"<id>"}' https://mvk.pelda.hu/_ingest
```

**Ellenőrzés:** `curl -s https://mvk.pelda.hu/_health` → `jwt.present: true`, `jwt.expiresInSec` (másodperc a lejáratig), `tokenRejected: false`.

---

## 6. Minden egy Macen

Ugyanaz a Mac futtatja a szervert és a token-agentet (pl. egy otthoni Mac mini).

1. Docker: [Docker Desktop](https://www.docker.com/products/docker-desktop/) vagy `brew install colima docker docker-compose docker-buildx && colima start --cpu 4 --memory 6`.
2. A [2. fejezet](#2-szerver-telepítése-vps-docker-compose) lépései ugyanígy (domain + a routeren a 80/443 továbbítva a Macre — HTTPS nélkül a passkey és a push nem működik).
3. Token-agent a [4. fejezet](#4-token-agent-a-macen-mvk-app--token) szerint, **`http://127.0.0.1:8090`** címmel: a compose a worker portját csak a gépen belülre nyitja ki (`127.0.0.1:8090`), kívülről minden a Caddyn át megy.
4. Az alvást itt is tiltsd le (4/5. lépés), különben az egész szerver elalszik.

---

## 7. A régi (v2) adatok átvitele

A v2 MySQL-dumpja: `data/legacy/mvk_stats.sql` (git alatt nincs). Az import (`tools/import-mysql`) átviszi a fiókokat, passkey-ket, push-feliratkozásokat, a menetrend-archívumot és az időjárást; a nyers GPS-es napokat az új illesztővel újraszámolja, a többi napot átveszi, végül újragenerálja az aggregátumokat és az üzemzavarokat (a régi, hamis üzemzavarokat nem viszi át).

**A) Ajánlott: helyben importálni, aztán a kész adatbázist átvinni** (kipróbálva: ~180 MB-os mentés, minden tábla sorszáma egyezik).

```bash
# 1. helyben: MySQL + a dump betöltése (egyszer)
brew install mysql && brew services start mysql
mysql -u root -e "CREATE DATABASE mvk_prod"
mysql -u root mvk_prod < data/legacy/mvk_stats.sql

# 2. helyben: fejlesztői Postgres + import (~9 perc; a sémát az import maga hozza létre)
docker compose -f infra/docker-compose.dev.yml up -d db
cp .env.dev.example .env.dev
bun install
set -a; . ./.env.dev; set +a
MYSQL_DB=mvk_prod bun run import:mysql

# 3. helyben: mentés
docker compose -f infra/docker-compose.dev.yml exec db pg_dump -U mvk -Fc -d mvk -f /tmp/mvk.dump
docker compose -f infra/docker-compose.dev.yml cp db:/tmp/mvk.dump ./mvk.dump
scp mvk.dump vps:~/mvk/

# 4. a VPS-en, MÉG A WORKER ELSŐ INDÍTÁSA ELŐTT
C="docker compose -f infra/docker-compose.yml --env-file infra/.env"
$C up -d db
$C cp mvk.dump db:/tmp/mvk.dump
$C exec -T db psql -U mvk -d mvk -c "CREATE EXTENSION IF NOT EXISTS timescaledb" -c "SELECT timescaledb_pre_restore()"
$C exec -T db pg_restore -U mvk -d mvk --no-owner /tmp/mvk.dump
$C exec -T db psql -U mvk -d mvk -c "SELECT timescaledb_post_restore()"
$C up -d --build
```

Mindkét compose ugyanazt a rögzített image-et használja (`timescale/timescaledb-ha:pg17.11-ts2.31.0`) — a visszaállításhoz a TimescaleDB-verziónak egyeznie kell, ezért ezt ne írd át az egyik oldalon.

**B) Közvetlenül a szerver adatbázisába:** ha a MySQL elérhető a szerverről, az import a worker konténerében is futtatható (a db portja kívülről zárt):

```bash
$C run --rm -e MYSQL_HOST=<mysql-gép> -e MYSQL_USER=root -e MYSQL_PASS=… -e MYSQL_DB=mvk_prod \
   worker node --experimental-strip-types tools/import-mysql/src/main.ts
```

A lépések külön is futtathatók: `STEPS=static,legacy,replay,fill,refresh,incidents`.

---

## 8. Fejlesztés helyben

**Kell:** [Bun](https://bun.sh) ≥ 1.3, Node ≥ 22 (a worker TypeScriptet futtat típus-eltávolítással), Docker.

```bash
bun install
docker compose -f infra/docker-compose.dev.yml up -d      # Postgres :5433 + Redis :6380
cp .env.dev.example .env.dev                              # REDIS_URL=redis://127.0.0.1:6380 (vagy Upstash)
./tools/dev-live.sh 2026-10-28 08:00                      # MVK-szimulátor + worker egy rögzített nap visszajátszásával
bun run dev:web                                           # http://localhost:3000
```

A web a `apps/web/.env.local`-ból olvas:

```
DATABASE_URL=postgres://mvk:mvk@127.0.0.1:5433/mvk
WORKER_URL=http://127.0.0.1:8090
NEXT_PUBLIC_WS_URL=ws://127.0.0.1:8090/ws
APP_SECRET=<ugyanaz, mint a .env.dev-ben>
REDIS_URL=redis://127.0.0.1:6380
```

A `tools/dev-live.sh` a `DEV_CLOCK_AT` fejlesztői órával a workert a megadott múltbeli pillanatba teszi, a szimulátor (`tools/import-mysql/src/mock-mvk.ts`, :8899) pedig az adatbázisban rögzített GPS-pontokat játssza vissza MVK-formátumban — így egy valódi nap a menetrenddel összhangban, élőben nézhető. Valódi MVK-val: `set -a; . ./.env.dev; set +a; bun run dev:worker` (token kell hozzá: agent `http://127.0.0.1:8090`-ra, vagy `/_ingest`).

```bash
bun run test        # minden csomag tesztje (core: illesztő, GTFS, forda-terv; cache: TEST_REDIS_URL-lel a Redis-szint is)
bun run typecheck
bun run build       # Prisma-kliens + Next production build
```

---

## 9. Mappaszerkezet

```
.
├── apps/
│   ├── web/             Next.js 16 (App Router) — a teljes felület
│   │   ├── app/           layout, oldal, és route handlerek: /stats, /account, /push, /v3 → @mvk/api
│   │   ├── src/
│   │   │   ├── components/  multistop (megállófigyelő), map (térkép + idővonal), timetable,
│   │   │   │                routeplanner, stats, notifications, account, layout (fejléc), ui
│   │   │   ├── lib/         realtime (WebSocket-kliens), sync (felhős szinkron), push, account
│   │   │   ├── hooks/ services/ context/ types/ styles/
│   │   └── public/        ikonok, manifest, service worker (sw.js)
│   ├── worker/          az élő motor (Node, TypeScript)
│   │   └── src/
│   │       ├── main.ts      indulás: migráció, GTFS, tanulás, HTTP + WebSocket, ütemezett jobok (pg-boss)
│   │       ├── engine.ts    MVK-pollozás 2,5 mp-enként → illesztés → adatbázis + események
│   │       ├── feeds.ts     GTFS letöltés, ellenőrzés, fallback; schedule.ts menetrend-archívum
│   │       ├── persist.ts   kötegelt írás (GPS-pont, menet, megálló-esemény, szakasz)
│   │       ├── hub.ts       WebSocket-témák: vehicles, stop:<id>, trip:<id>, runs:<nap>, sync
│   │       ├── predict.ts   rendszám-előrejelzés (forda-terv + tanult láncok, önjutalmazás)
│   │       ├── planner.ts   RAPTOR útvonaltervező; incidents.ts üzemzavar-észlelés
│   │       ├── push.ts      push-értesítések sora; token.ts MVK-token tárolás és megújítás
│   │       └── http/        compat.ts (v2-végpontok az iOS appnak), v3.ts (/engine/*), router.ts
│   └── token-agent/     macOS agent (Swift) + install.sh — MVK app újraindítása, token kiolvasása és küldése
├── packages/
│   ├── core/            közös logika: GTFS + fallback, idő (Budapest, 3:00-s szolgáltatási nap), geo,
│   │                    TripMatcher (illesztő), megállófigyelő-számítás, forda-terv (rotation.ts) + tesztek
│   ├── db/              SQL-séma (sql/*.sql, Timescale), migráció, pg pool, Prisma-kliens, titkosítás, HMAC
│   ├── api/             a web szerveroldali API-ja: statisztika, passkey-fiók, szinkron, push
│   └── cache/           kétszintű gyorsítótár (memória + Redis/Upstash) + tesztek
├── infra/
│   ├── docker-compose.yml      éles: db, worker, web, caddy
│   ├── docker-compose.dev.yml  fejlesztői: db (:5433), redis (:6380)
│   ├── Dockerfile              worker és web image (bun a függőségekhez, node futtatja)
│   ├── Caddyfile               HTTPS + útválasztás (élő/v2 végpontok → worker, a többi → web)
│   └── .env.example            az éles beállítások sablonja
├── tools/
│   ├── import-mysql/    v2 MySQL → v3 adatátvitel (main.ts), MVK-szimulátor (mock-mvk.ts),
│   │                    illesztő-ellenőrző egy rögzített napon (check-matcher.ts)
│   ├── dev-live.sh      fejlesztői élő környezet (szimulátor + worker, fejlesztői órával)
│   └── vpn-route.sh     a Mac VPN-útvonala (a /Library/LaunchDaemons/hu.mvk.vpnroute.plist futtatja — ne töröld)
├── data/                helyi adatok, git alatt nincs: gtfs-cache/ (GTFS-mentés), legacy/ (v2 MySQL-dump)
├── docs/v3.md           architektúra, a v2 hibái és javításuk, kompatibilitás
├── docs/MAVPLUSZ_OTP2.md  MÁV+ OTP2: feltérképezés, terv és megvalósítás (Volán, vasút, MVK-tartalék)
├── .env.dev.example     a fejlesztői beállítások sablonja
└── package.json         Bun workspace (apps/*, packages/*, tools/*) és a gyökérszintű parancsok
```

---

## 10. Környezeti változók

| Változó | Ki használja | Kötelező | Jelentés |
|---|---|---|---|
| `DATABASE_URL` | worker, web, import | igen | Postgres kapcsolat |
| `APP_SECRET` | worker, web | igen | az MVK-token titkosítási kulcsa |
| `ADMIN_KEY` | worker, web, hub | igen (éles) | `X-Admin-Key` a védett végpontokhoz (`/_jwt`, `/_export`, `/_ingest`, `/system/*`, `/v3/admin/*`); a hub ezzel éri el a workert és a webet |
| `AGENT_SECRET` | worker | igen (éles) | a token-agent HMAC-titka |
| `REDIS_URL` | worker, web | nem | `redis://` vagy `rediss://` — Upstash vagy helyi Redis |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | worker, web | push-hoz | Web Push kulcspár |
| `DOMAIN` | compose, caddy | igen (éles) | a site domainje |
| `RP_ORIGINS` | web | igen (éles) | a passkey engedélyezett originjei (a compose a `DOMAIN`-ből állítja) |
| `WORKER_URL` | web | igen | a worker belső címe (build közben is: átirányítások) |
| `NEXT_PUBLIC_WS_URL` | web (böngésző) | fejlesztésben | WebSocket cím, ha nem ugyanazon az originen van |
| `DB_POOL` | worker, web | nem | pg-pool méret |
| `POLL_MS`, `CANCELLED_MS`, `GTFS_CHECK_MS`, `WEATHER_MS` | worker | nem | pollozási időközök (2,5 mp / 30 mp / 30 perc / 10 perc) |
| `MVK_API`, `MVK_GTFS_URL` | worker | nem | az MVK címei (fejlesztésben a szimulátor) |
| `BOOTSTRAP_GTFS` | worker | nem | helyi GTFS-zip az első induláshoz |
| `DEV_CLOCK_AT` | worker | csak fejlesztés | fejlesztői óra (élesben soha) |
| `OTP2_ENABLED`, `REGIONAL` | worker | nem | MÁV+ be/ki (`0` = se tartalék, se Volán/vasút); `REGIONAL=0`: csak az MVK-tartalék |
| `OTP2_POLL_MS`, `OTP2_FALLBACK_POLL_MS`, `OTP2_ALERTS_MS`, `OTP2_BOARDS_MS`, `REGIONAL_DAYS_AHEAD`, `FALLBACK_OUTAGE_MS`, `FALLBACK_RECOVER_POLLS` | worker | nem | MÁV+ időközök és az átállás szabálya — lásd [docs/MAVPLUSZ_OTP2.md](docs/MAVPLUSZ_OTP2.md) M.7 |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASS`, `MYSQL_DB`, `STEPS` | import | importhoz | a v2 MySQL elérése, futtatandó lépések |
| `HUB_BIND`, `HUB_PORT` | compose (hub) | a hubhoz | a hub LAN-címe és portja (pl. `192.168.1.11`, `8099`); üresen csak `127.0.0.1` |
| `HUB_PASSWORD` | hub | a hubhoz | belépési jelszó, min. 12 karakter |
| `HUB_BACKUP_HOUR`, `HUB_BACKUP_KEEP` | hub | nem | napi automatikus mentés órája (`-1` = ki) és megtartott darabszám (4, 7) |
| `HUB_GIT_TOKEN` | hub | privát repónál | GitHub fine-grained token (Contents: read) a frissítéshez |
| `HUB_ALLOWED_CIDRS` | hub | nem | engedett kliens-tartományok; üresen magánhálózatok + loopback + VPN (100.64/10) — ajánlott szűkíteni, pl. `192.168.1.0/24,10.5.5.0/24` |
| `HUB_ALLOWED_HOSTS` | hub | nem | ha nem IP-címmel éred el a hubot (pl. `hub.lan`): az engedett nevek (DNS-rebinding ellen minden más Host tiltva) |
| `METRICS_KEY` | web, hub | a hubhoz | csak-olvasó kulcs a web válaszidőihez (`X-Metrics-Key`); a nyilvános web így nem kapja meg az `ADMIN_KEY`-t |

---

## 11. Üzemeltetés

- **Állapot:** `/_health` (token, poll), `/system/info` (GTFS, illesztés, predikció, WebSocket-kliensek, gyorsítótár), `/engine/predict/status` (előrejelzés pontossága horizontonként, súlyok, tervezett menetek).
- **GTFS kézi frissítés:** `curl -X POST -H "X-Admin-Key: …" https://<domain>/system/reload-gtfs`.
- **Mentés:** a [rendszer-hubból](#12-rendszer-hub-belső-hálós-vezérlőpult) egy gombbal (és naponta magától). Kézzel: `docker compose -f infra/docker-compose.yml --env-file infra/.env exec db pg_dump -U mvk -Fc -d mvk -f /tmp/mvk.dump`, majd `… cp db:/tmp/mvk.dump ./mvk-$(date +%F).dump`. Visszaállítás: [7/A, 4. lépés](#7-a-régi-v2-adatok-átvitele).
- **Naplók:** `docker compose … logs -f worker` / `web` / `caddy`; Macen `~/Library/Logs/mvk-token-agent.log`.
- **Tárhely:** GPS ~2–3 MB/nap tömörítve, megálló-események ~1 MB/nap → évente ~1,5 GB.

---

## 12. Rendszer-hub (belső hálós vezérlőpult)

Külön Next.js app (`apps/hub`), plusz egy konténer ugyanabban a Compose-projektben. **Csak a belső hálón** érhető el (pl. `http://192.168.1.11:8099`), és innen az egész rendszer látszik és irányítható:

| Oldal | Mit látsz / mit tudsz csinálni |
|---|---|
| **Áttekintés** | egy mondatban az állapot, riasztások (token, agent, MVK-feed, konténer, lemez, mentés, event loop, elérhetőség), minden alrendszer fő száma |
| **Szolgáltatások** | minden konténer CPU / memória / hálózat / lemez, újraindítás, leállítás, indítás; worker és web folyamat; Docker-gazdagép, kötetek mérete |
| **Válaszidők** | kívülről 30 mp-enként mért elérhetőség és válaszidő (worker, web, a nyilvános domain a Caddyn át), belülről útvonalanként p50/p95/p99 és hibaarány (worker, web API, MVK API) |
| **Naplók** | élő naplók: worker, hub és (Dockerben) minden konténer — szűrés szintre/szövegre, megállítás, letöltés |
| **Token és agent** | visszaszámláló, előzmények, agentek állapota; **MVK app újraindítása**, token azonnali küldése, agent újraindítása, szerveroldali megújítás, kézi betöltés, a token megtekintése |
| **MVK API** | lekérések, hibák, végpontonkénti válaszidők, napi feed-egészség, GTFS-verziók + újratöltés, **API-vizsgáló** (bármely MVK-végpont a szerver tokenjével; a GTFS-RT protobuf JSON-ként) |
| **Adatforrások** | az MVK forrása most (natív vagy MÁV+ tartalék), átváltások, árnyék-mérés (késés, lefedettség), MÁV+-hívások és terhelési korlát, a regionális menetrend építései + újraépítés |
| **Feladatok** | pg-boss ütemezés és futások, ML-modell és rendszám-előrejelző állapota; minden feladat indítható most |
| **Használat** | aktív eszközök (napi/heti/havi), új és visszatérő, platform, böngésző, telepített app arány, nézetek, ki van fent most — és **a kedvencek ranglistája** (vonal, megálló, jármű, parkoló, kijelző) |
| **Felhasználók** | fiókok listája; részletek (kedvencek, passkey-k, munkamenetek, eszközök, utazások, push, beállítások), kiléptetés, passkey/fiók törlése, adatexport (JSON) |
| **Push** | feliratkozások, figyelések fajtánként, kézbesítések, hibák |
| **Adatbázis** | méret táblánként (hypertable-darabok, tömörítés), napi növekedés, kapcsolatok, futó lekérdezések megszakítása |
| **Mentések** | mentés most, napi automatikus mentés, letöltés, feltöltés, **visszaállítás** (előtte biztonsági mentés; a régi adatbázis csak félreáll, hiba esetén automatikusan visszakerül) |
| **Telepítés** | git-állapot, érkező commitok, **frissítés + újratelepítés egy gombbal**, korábbi telepítések naplója, műveleti napló (minden beavatkozás: ki, honnan, mikor) |

### Bekapcsolás

1. `infra/.env`-be (lásd `infra/.env.example`):

   ```
   HUB_BIND=192.168.1.11        # a szerver LAN-címe — SOHA ne 0.0.0.0 egy nyilvános VPS-en
   HUB_PORT=8099
   HUB_PASSWORD=<openssl rand -base64 24>
   METRICS_KEY=<openssl rand -hex 32>
   HUB_ALLOWED_CIDRS=192.168.1.0/24,10.5.5.0/24   # a LAN és a WireGuard-alháló (ajánlott)
   HUB_GIT_TOKEN=<csak privát repóhoz — a repó most privát, kell>
   ```

2. Indítás/frissítés ugyanúgy, mint eddig (a hub egy plusz konténer):

   ```bash
   mkdir -p data/backups
   docker compose -f infra/docker-compose.yml --env-file infra/.env up -d --build
   ```

3. Böngészőben: `http://192.168.1.11:8099` → jelszó. Kívülről a WireGuard-VPN-en át is elérhető (a `10.x`, `100.64.x` tartomány engedett).

4. **Token-agent frissítése a Macen** (a hubból kért parancsokhoz kell, a régi agent csak nem fogad parancsot): `cd apps/token-agent && ./install.sh <szerver-url> <AGENT_SECRET>`. Az új agent fél percenként jelentkezik, így a „MVK app újraindítása” gomb ~1,5 percen belül friss tokent hoz.

### Hogyan működik

- **HTTP, nem HTTPS:** a hub a belső hálón titkosítatlanul megy. Megosztott vagy idegen Wi-Fin (ahol valaki lehallgathat) csak a WireGuard-VPN-en át használd — az titkosít. A belépés után a Telepítés → Műveleti naplóban nézd meg, milyen címmel látszol: ha `172.x`, a Docker elfedi a valódi címet, és a `HUB_ALLOWED_CIDRS` szűkítése nem működik (ilyenkor a jelszó és a port kötése véd).
- **Biztonság:** a port csak a `HUB_BIND` címen figyel; a hub minden kérésnél ellenőrzi, hogy a kliens magánhálózati címről jön-e; jelszó + aláírt, `HttpOnly`, `SameSite=Strict` süti, szerveroldali munkamenet-listával (a kilépés azonnal érvénytelenít, a hub újraindulása mindenkit kiléptet); csak IP-címmel vagy engedett névvel nyitható meg (DNS-rebinding ellen); más oldalról indított kérést elutasít (Origin + Sec-Fetch-Site); 8 hibás próbálkozás után 15 perc zár; minden beavatkozás a `hub_audit` táblába kerül. A hub a Docker-socketet kapja meg, ami **root-egyenértékű** — ezért nem kerülhet nyilvános hálóra. A Caddy a hub belső végpontjait (`/system/metrics|live|logs|mvk-call|jobs`, `/v3/admin/*`) és a veszélyes régi admin-végpontokat (`/_jwt`, `/_export`, `/_renew`, `/system/restart`) kívülről 404-gyel zárja — ezeket mostantól a hubból éred el. A nyilvános `POST /v3/usage` 8 KB-os, címenként és összesen is korlátozott; a használati sorok 400 nap után törlődnek.
- **Adatok:** az adatbázist közvetlenül olvassa; a worker és a web belső állapotát admin-kulcsos végpontokon (`/system/metrics`, `/system/live`, `/system/logs[/stream]`, `/system/mvk-call`, `/system/jobs/*`, `/v3/admin/metrics`) — a kulcs a hub szerverén marad, a böngésző nem kapja meg. A konténereket a Docker Engine API-n éri el.
- **Használat és kedvencek:** a webapp névtelen jelet küld (`POST /v3/usage`): véletlen eszközazonosító, platform, telepített-e, megnyitott nézetek, a kedvencek pillanatképe. IP-címet nem tárol; bejelentkezve az eszköz a fiókhoz kötődik. (Ezt érdemes egy mondatban az adatkezelési tájékoztatóban is jelezni.)
- **Telepítés:** egy leválasztott segédkonténer futtatja (`git pull --ff-only` → `compose build` → worker és web csere → egészség-ellenőrzés → a hub cseréje), a repóval a gépen érvényes útvonalán felcsatolva — így a hub önmagát is lecserélheti, és a git-műveletek a repó tulajdonosának nevében futnak.
- **Mentés:** `pg_dump -Fc` az adatbázis saját konténerében (a verzió mindig egyezik), a gépen `data/backups/`. A visszaállítás `timescaledb_pre_restore()` / `post_restore()` között fut; a régi adatbázis átnevezve vár, hiba esetén visszakapja a nevét.

**Fejlesztés:** `apps/hub/.env.local` (lásd a `.claude/launch.json` „hub” bejegyzését), `bun run --cwd apps/hub dev` → `http://localhost:3010`. Docker nélkül a konténer-, mentés- és telepítés-funkciók jelzik, hogy nem érhetők el; minden más működik.
