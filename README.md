# MVK MobilON+ — Valós Idejű Tranzit SaaS Rendszer & Folyamatkezelő

Professzionális, modern, valós idejű közösségi közlekedési platform Miskolcra:
- **Modern React + Vite + TypeScript + Tailwind CSS Frontend**: Moduláris komponensek, Lucide ikonok, nulla AI-slop / nulla giccs gradiens, prémium sötét tranzit felület (Linear / Transit inspiráció).
- **Multi-Megálló Figyelő Kijelző (1–6 megálló)**: Valós idejű visszaszámlálás, legközelebbi járat kártyája (járatszám, célállomás, jármű ID / típus, késés/sietés státusz), alatta további érkezésekkel és térképre ugrási funkcióval.
- **Élő Térkép & Járatszűrő**: Forgó irány-nyilas busz és villamos markerek valós pozícióval, sebességgel, járatnyomvonalakkal, megállókkal és járműkövetéssel (max. 12 jármű).
- **SaaS Rendszer Hub & API Inspector**: Élő telemetria, memóriahasználat, token-érvényesség, beépített interaktív REST API playground és token-kezelő modal.
- **Egységes Instance Manager (`manager.mjs` / `start.sh`)**: Egyetlen parancs indítja a backend gateway-t (:8088), a Vite frontendet (:5173) és a csendes Mac token-workert.

- **Statisztikai Adatraktár (MySQL)**: Folyamatos telemetria-gyűjtés, megálló-események és szakaszmenetidők levezetése, éjszakai aggregálás, valamint A→B menetidő-előrejelzés. Részletek: [backend/src/db/README.md](backend/src/db/README.md).

---

## 🚀 Gyors Indítás

```bash
# 1. Függőségek telepítése (első alkalommal)
cd backend && npm install
cd ../frontend && npm install
cd ..

# 2. Statisztikai adatbázis előkészítése (egyszer, MySQL szükséges)
cd backend && npm run db:migrate && cd ..

# 3. Rendszer indítása (Backend + Frontend + Workerek egyben)
./start.sh
# vagy:
npm start
```

### Elérhetőségek:
- **Frontend Dashboard:** [http://localhost:5173](http://localhost:5173)
- **Backend Gateway & API:** [http://localhost:8088](http://localhost:8088)
- **Rendszer Hub & API Inspector:** [http://localhost:5173](http://localhost:5173) *(Rendszer Hub fül)*

---

## 📁 Projekt Felépítés

```
├── backend/                   # Hono + TypeScript API Gateway (:8088)
│   ├── src/index.ts           # REST végpontok, GTFS-RT dekód, valós érkezések, proxy
│   ├── state/                 # jwt.txt, installation_id.txt
│   ├── gtfs/                  # statikus GTFS adatok (indításkor automatikusan frissül)
│   ├── tools/
│   │   ├── token_worker.sh    # Csendes, optimalizált háttér-token frissítő (Mac)
│   │   ├── extract_ios_token.py
│   │   └── refresh_token.sh
│   └── deploy/                # systemd + Pi telepítő szkript
│
├── frontend/                  # Modern React + Vite + TS + Tailwind CSS App (:5173)
│   ├── src/
│   │   ├── App.tsx            # Állapotkezelés, fülváltó, navigáció
│   │   ├── components/
│   │   │   ├── layout/        # Header, státusz-pill, élő pulzálás
│   │   │   ├── multistop/     # MultiStopDashboard, StopCard, AddStopModal (1-6 megálló)
│   │   │   ├── map/           # TransitMap (Leaflet), busz markerek, járatvonalak
│   │   │   ├── fleet/         # FleetFilter, RouteChips, jármű watchlist
│   │   │   ├── stops/         # StopSearchList, StopDetailDrawer
│   │   │   └── hub/           # SystemHub, ApiInspector, TokenModal
│   │   ├── services/api.ts    # REST kliens
│   │   └── types/             # Szigorú TypeScript típusdefiníciók
│   └── dist/                  # Éles build kimenet (a backend is kiszolgálhatja)
│
├── manager.mjs                # Node.js párhuzamos folyamatkezelő (Backend + Frontend + Worker)
├── start.sh                   # Fő indítószkript
├── direct.sh                  # Közvetlen MVK API tesztelő
└── package.json               # Monorepo / gyökér szkriptek
```

---

## 🚏 Főbb Felületek & Funkciók

### 1. Multi-Megálló Figyelő (1–6 Megálló Kijelző)
- Tetszőleges 1–6 megálló egyidejű monitorozása külön kártyákon.
- **Kiemelt Hero kártya a legközelebbi járatnak**:
  - Valós idejű visszaszámlálás (`MOST`, `2 perc`, `14:32`).
  - Hivatalos GTFS járatszín és számozás.
  - Célállomás (headsign).
  - Jármű ID / rendszám és sebesség kijelzés.
  - Késés / sietés státusz-címke (`+2p késés`, `pontos`, `–1p sietés`).
- További 4 közelgő indulás listája.
- Egy kattintással térképre ugrás és járatkövetés.
- A kiválasztott megállók listája automatikusan mentődik `localStorage`-ban.

### 2. Élő Térkép (Leaflet Dark Theme)
- Sötét tónusú tranzit térkép, CartoDB Dark réteggel.
- Valós idejű járműmarkerek:
  - Irány-nyíl a GPS mozgás iránya (`bearing`) szerint.
  - Járatszínnel kitöltött jelvény.
  - Jármű ID címke opció.
- Kattintásra jármű adatlap (sebesség, frissesség mp-ben, teljes menetútvonal kirajzolása).
- Megállók pöttyként: kattintásra felugró valós idejű indulási jegyzék.

### 3. Járatok & Járművek Szűrője
- **Jármű ID követés (Watchlist)**: írd be a jármű azonosítóját (pl. `1641`), `Enter` vagy `+` → követési listára kerül (max. 12 jármű). Csak a követett járművek jelennek meg, és a térkép követi őket.
- **Járműtípus szűrő**: Mind / 🚌 Busz / 🚋 Villamos.
- **Járatszűrő chipek**: élő járműszám-számlálóval (`Csak az élők`, `Mind`, `Egy sem`, `Invertál`).
- **Megjelenítési kapcsolók**: Megállók, Járatvonalak, Mozgó járművek, Jármű ID címkék, Térkép auto-követés.

### 4. Rendszer Hub & Beépített API Inspector
- Szerver és folyamat telemetria (Uptime, memória RSS/Heap, Node verzió).
- GTFS statikus motor adatok (megállók, járatok, menetek száma, feed verzió).
- Token állapot kijelző lejárati visszaszámlálóval és manuális JWT betöltési lehetőséggel.
- **Beépített API Inspector**: tetszőleges MVK végpont azonnali futtatása válaszidővel és syntax-highlighted JSON nézettel.

---

## 🔑 Token Kezelés

A backend tokenjét a `backend/state/jwt.txt` fájl tárolja.
1. **Mac-en**: A háttérben futó `token_worker.sh` automatikusan kiolvassa a Mac-natív MVK MobilON+ appból a tokent és frissíti a gateway-t (0–24 működés, minimális diszkrét logolással).
2. **Webes felületről**: A fejlécben lévő **Token pill** gombra vagy a **Rendszer Hub**-ra kattintva a Token Modal-ban közvetlenül beilleszthető az új JWT.

---

## 🛠️ CLI Hasznos Parancsok

```bash
# Teljes rendszer indítása
./start.sh

# Csak a frontend buildelése
npm run build:frontend

# Közvetlen MVK API hívás tesztelő
./direct.sh positions decoded
./direct.sh token
```
