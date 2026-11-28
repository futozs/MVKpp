# MVK futtatása macOS-en OrbStackkel

Ez a leírás azt mutatja be, hogyan fut a teljes éles stack (db, redis, worker, web, hub, tiles, caddy, cloudflared)
egy Apple Silicon Macen, **OrbStack** Docker-motorral, és hogyan lehet átköltözni Colimáról adatvesztés nélkül.

## Miért OrbStack (és nem Colima vagy natív futtatás)

| | Colima | OrbStack | Natív (Docker nélkül) |
|---|---|---|---|
| Memória | fix méretű VM: amit egyszer megkapott, nem adja vissza (a Linux lapgyorsítótár is benne marad) | **dinamikus**: csak a ténylegesen használt memóriát tartja, a többit visszaadja a macOS-nek | legkevesebb |
| Compose, `docker.sock` | igen | **igen, változatlanul** | nincs |
| A hub (konténerkezelés, deploy) | működik | **működik** | nem működik (a hub a Docker API-ra épül) |
| Rögzített TimescaleDB-image | igen | igen | kézzel kellene azonos verziót telepíteni |

Egy 8 GB-os Mac minin mérve ugyanaz a stack Colimával ~5,1 GB-ot, OrbStackkel ~3,1 GB-ot foglalt a gazdagépen.
A compose fájlokon, a `.env`-en és a kódon **semmit nem kell változtatni**.

> Licenc: az OrbStack személyes, nem üzleti használatra ingyenes.

## Telepítés

```sh
brew install --cask orbstack
orb start                       # ablak nélkül elindítja a Docker motort
docker context use orbstack     # a telepítő általában magától beállítja
```

Ajánlott beállítások szerverként futó gépre:

```sh
orb config set memory_mib 5120               # felső határ (dinamikus, nem foglalja le előre)
orb config set cpu 4
orb config set app.start_at_login true
orb config set app.wait_for_container_stop true   # leállításkor megvárja a konténereket (Postgres!)
orb config set power.pause_in_sleep false          # alvás közben se álljon meg
orb config set rosetta false                       # arm64 image-ekhez nem kell
orb stop && orb start                              # a beállítások érvénybe lépnek
```

- A gazdagép socketje: `~/.orbstack/run/docker.sock`. A **konténereken belül** ugyanúgy `/var/run/docker.sock` – a hub
  `docker.sock`-csatolása és a deploy-segédkonténer változtatás nélkül működik.
- `HUB_BIND` a Mac LAN-címére köthető (pl. `HUB_BIND=192.168.1.10`): az OrbStack a konkrét gazdagép-IP-re is kiteszi a portot
  (`docker.expose_ports_to_lan: true`, alapértelmezett).

Indítás ugyanúgy, mint bárhol:

```sh
docker compose -f infra/docker-compose.yml --env-file infra/.env up -d --build
```

## Automatikus indulás (LaunchAgent)

Két LaunchAgent a `~/Library/LaunchAgents/` alatt (automatikus bejelentkezéssel együtt áramszünet után is elindul):

1. **OrbStack motor** – `orb start` egyszer, bejelentkezéskor:

```xml
<key>Label</key><string>mvk.orbstack</string>
<key>ProgramArguments</key><array><string>/opt/homebrew/bin/orb</string><string>start</string></array>
<key>RunAtLoad</key><true/>
```

2. **Stack** – egy script, ami megvárja a Dockert, majd `up -d`:

```bash
#!/usr/bin/env bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
for i in $(seq 1 120); do
  docker info >/dev/null 2>&1 && break
  [ "$i" = 30 ] && orb start          # ha az OrbStack nem indult el magától
  sleep 5
done
docker info >/dev/null 2>&1 || exit 1
cd "$HOME/mvk" && docker compose -f infra/docker-compose.yml --env-file infra/.env up -d --remove-orphans
```

A konténerek `restart: unless-stopped` beállítása miatt az OrbStack újraindulásakor egyébként is visszajönnek;
a script a biztos indulásért és a compose-állapot helyreállításáért kell.

## Átköltözés Colimáról (adatvesztés nélkül)

Bevált sorrend (kiesés ~5 perc):

1. **Kiinduló állapot rögzítése**: táblánkénti pontos sorszám, konténerállapot, nyilvános elérés.
   ```sh
   docker compose … exec db psql -U mvk -d mvk -At -c \
     "select format('select %L, count(*) from %I.%I;', schemaname||'.'||relname, schemaname, relname)
        from pg_stat_user_tables where schemaname not like '_timescaledb%' order by 1" \
   | docker compose … exec -T db psql -U mvk -d mvk -At -F' ' > elotte-sorok.txt
   ```
2. **Friss mentés** (`pg_dump -Fc`) – és egy példány egy másik lemezre.
3. **A helyben épített image-ek kimentése**, hogy ugyanaz a kód fusson: `docker save -o imagek.tar mvk-web mvk-hub mvk-worker`.
4. **Stack leállítása** (`docker compose … stop`), majd a volume-ok fájlszintű kimentése a jogosultságokkal:
   ```sh
   for v in mvk_db mvk_redis mvk_caddy-data mvk_caddy-config; do
     docker run --rm -v $v:/v:ro -v "$PWD":/out busybox:1.37 sh -c "cd /v && tar -cf /out/vol-$v.tar ."
   done
   ```
5. `colima stop`, a Colima automatikus indításának kikapcsolása, OrbStack telepítése és beállítása (lásd fent).
6. `docker load -i imagek.tar`, majd `docker compose … create` – így a volume-ok a compose címkéivel jönnek létre.
7. **Ellenőrzés visszatöltés előtt**: az image az új volume-ba üres alapmappákat másolhat (pl. `pgdata/data`, `caddy/`).
   Csak akkor töltsd vissza, ha **egyetlen fájl sincs** benne:
   ```sh
   docker run --rm -v mvk_db:/v -v "$PWD":/in:ro busybox:1.37 sh -c \
     '[ $(find /v -type f | wc -l) -eq 0 ] && cd /v && tar -xpf /in/vol-mvk_db.tar'
   ```
8. **Verzió-ellenőrzés**: az újra letöltött `timescale/timescaledb-ha` image-ben pontosan ugyanaz a PostgreSQL és TimescaleDB legyen
   (`postgres --version`, `timescaledb-2.x.so`) – a rögzített tag ezt biztosítja, de érdemes megnézni.
9. `docker compose … up -d`, majd ugyanaz a sorszám-lekérdezés: **egyik táblában sem lehet kevesebb sor**.
10. Próba-build (`docker compose … build`) és újraindítás az új image-ekkel – így a hubból indított deploy is ellenőrizve van.
11. Csak pár nap hibátlan futás után: `colima delete`, `brew uninstall colima lima`.

## Mentés külső lemezre

A `backup.sh` `EXTERNAL_DIR` változójával a napi dump egy második lemezre is átmásolódik (ugyanazzal a megőrzési idővel).

macOS-megjegyzés: a launchd által indított folyamatok a **Teljes lemezhozzáférés** nélkül nem írhatnak külső kötetre
(„Operation not permitted”). Vagy az indított programnak kell megadni az engedélyt, vagy egy olyan programon át kell indítani
a mentést, amelyiknek már van (a gyermekfolyamat örökli).

## Hibaelhárítás

| Tünet | Megoldás |
|---|---|
| `docker: Cannot connect to the Docker daemon` | `orb status` → `orb start`; `docker context use orbstack` |
| A hub nem látja a konténereket | `docker exec <hub> ls -la /var/run/docker.sock` – léteznie kell |
| A LAN-ról nem érhető el a hub | `orb config show \| grep expose_ports_to_lan` → `true`; `HUB_BIND` a Mac aktuális IP-je |
| Sok memória marad lefoglalva egy build után | normális, az OrbStack fokozatosan adja vissza; `docker builder prune` is segít |
| Postgres „recovery” induláskor | nem tiszta leállítás volt: `app.wait_for_container_stop true` |
