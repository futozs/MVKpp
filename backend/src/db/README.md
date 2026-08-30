# MVK Menetadat-raktár

Az élő járműtelemetriából évekig eltartható, indexelt statisztikai adatbázist
épít: járműszintű napi nyomkövetés, vonalszintű pontossági mutatók és A→B
menetidő-előrejelzés.

## Indítás

```bash
cd backend
npm install
npm run db:migrate     # adatbázis, séma, partíciók, naptár, dimenziók
npm run worker         # gyűjtés + feldolgozás (a manager.mjs is ezt indítja)
```

A migráció idempotens — bármikor újrafuttatható, és GTFS-frissítés után
újra kell futtatni, hogy az új megállók és minták bekerüljenek.

Kapcsolat env-változókkal: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`,
`DB_NAME` (alap: `127.0.0.1:3306 / root / — / mvk_stats`).

## Rétegek

| Réteg | Táblák | Megőrzés | Szerep |
|---|---|---|---|
| **L0** | `veh_ping` | 14 nap | Nyers GPS. Nyomvonal-lejátszás és a feldolgozás bemenete. Sosem kérdezzük le statisztikához. |
| **L1** | `trip_run`, `stop_event`, `segment_run` | örökre | Levezetett tények. Minden kérdés megválaszolható belőle. |
| **L2** | `agg_*` | örökre | Éjszakánként újraszámolt összegzések. **Minden UI-chart és előrejelzés kizárólag innen olvas.** |

A nyers pontot azért lehet eldobni, mert a lényeg — hogy a 625-ös busz
07:14:22-kor beért a Villanyrendőrhöz, 38 mp-et állt és 2:10-et késett — már
a tényrétegben van, ezredakkora helyen.

## Miért így néz ki a séma

**Nincs szöveges kulcs a ténytáblákban.** InnoDB minden másodlagos indexbe
bemásolja az elsődleges kulcsot; egy `VARCHAR(16)` járműazonosító
megháromszorozná a tábla és az összes index méretét.

**A `veh_ping` elsődleges kulcsa nem `AUTO_INCREMENT`,** hanem
`(vehicle_key, feed_ts, service_date)`. Két dolgot ad egyszerre:

- egy jármű összes pontja fizikailag egymás mellett van, így a „hol járt 24
  órán át" kérdés egyetlen szekvenciális olvasás (igazolva: `EXPLAIN` szerint
  `Index lookup using PRIMARY`);
- ez a kulcs a deduplikáció is. A jármű ~18 mp-enként ad fixet, mi 5
  mp-enként kérdezünk — az `INSERT IGNORE` a fölös sorokat kulcsütközésre
  ejti. Mérve: 673 megtartott sor mellett 1758 ismétlés esett ki.

**A `segment_run` kulcsában a szakasz van elöl,** mert a domináns lekérdezés
mindig ez: „add ide ennek a szakasznak minden mérését az elmúlt 120 napból" —
profilépítéshez és modelltanításhoz egyaránt.

**A `dim_segment` szándékosan vonalfüggetlen.** Ha egy szakaszon öt vonal jár,
mind az öt ugyanabba a mintakészletbe mér: ötszörös mintaszám az
előrejelzéshez.

**Particionálás dátum szerint.** A `WHERE service_date = …` egyetlen
partíciót érint (igazolva: 17 partícióból `partitions: p20260830`), a
megőrzés pedig `DROP PARTITION` — fájlművelet, nem félmillió sor a
tranzakciós naplóba.

Két MySQL-korlát be van építve: minden egyedi kulcs tartalmazza a
particionáló oszlopot, és particionált táblán nincs idegen kulcs (az
integritást az alkalmazás tartja; a dimenziótáblák nem particionáltak).

## Kulcsstabilitás

A GTFS-feed ~16 napos ablakot fed le és rotál: a `trip_id` és a `service_id`
menetrendváltáskor eltűnik. Ezért a tények szintetikus kulcsokon állnak, és a
GTFS-azonosítók csak attribútumok:

| Kulcs | Természetes alap | Miért stabil |
|---|---|---|
| `vehicle_key` | `vehicle.id` (`625`) | fizikai járműszám, nem menetrendi adat |
| `route_key` | `route_short_name` (`1V`) | a közszolgáltatás azonosítója |
| `stop_key` | `stop_id`, tartalék: név + 30 m | átszámozáskor sem szakad meg a történet |
| `pattern_key` | megállósorrend SHA-1 kivonata | a menetrendváltást túlélő fogalom |

## Feldolgozás

| Folyamat | Ütem | Feladat |
|---|---|---|
| collector | 5 mp | Pozíciók lekérése a helyi gateway-ről, kötegelt `INSERT IGNORE`. |
| matcher | 30 mp | Menethozzárendelés, megálló-események, szakaszmenetidők. |
| closer | 5 perc | Menetek lezárása és összegzése, szellemmenetek jelölése. |
| roller | 03:10 + 5 percenként a mai napra | Aggregátumok, szakaszprofil 120 napos ablakon. |
| janitor | 6 óra | Partíciógyártás előre, ejtés hátulról, `ANALYZE TABLE`. |

Kézi újraszámolás egy napra:

```bash
node src/worker/main.ts --roll 2026-09-01
```

### Mért jellemzők

Az ütemezés nem tetszőleges. A járművek ~18 másodpercenként adnak új
GPS-fixet, és a GTFS-RT feed járművenként csak a LEGUTÓBBI pozíciót hordozza —
18 mp-nél sűrűbben kell tehát kérdezni, különben fixek vesznek el. Az 5 mp
kényelmes ráhagyás; a többlet mind ismétlés, amit a kulcs ejt.

## Két dolog, ami könnyen elromlik

**Időzóna.** Az MVK feed a helyi időt teszi a unix-mezőkbe (mérve: +7200 mp
nyáron), a pozíciókban és az updates-ben egyaránt. Ezt egyszer, beérkezéskor
korrigáljuk valódi UTC-re (`budapestOffsetSec()`, gépfüggetlen). Az
adatbázisban minden UTC; helyi idő csak megjelenítéskor.

**Üzemi nap.** Hajnali 3-ig még az előző naphoz tartozunk, mert a GTFS a
24:00 utáni indulásokat is az előző naphoz sorolja (`24:30:00`). Ezért a
`sched_s` `MEDIUMINT` és lehet 86400 fölött, az `agg_stop_hour.hour` pedig
24–26 is.

## Megálló-detektálás

Nem sugaras geokerítéssel megy — az az út két oldalán lévő, ellenkező irányú
megállópárt együtt kapná el —, hanem a vonalgeometria mentén mért haladással
(`tripStopsAlong`). És mivel a jármű 18 mp alatt ~150 métert tesz meg, nem
eseményre várunk, hanem a megállót közrefogó két pont közé **interpolálunk**;
enélkül a megállók egy része egyszerűen kimaradna.

- `src = 1` — a jármű ténylegesen megállt, az álló pontsorozatból pontos
  érkezés, indulás és tartózkodási idő.
- `src = 3` — interpolált áthaladás.

A tartózkodási idő felbontását a mintavételi ütem korlátozza: ha csak egy álló
pont esik a megállóra, a mért dwell 0. Relatív összehasonlításra így is
használható, abszolút utasszám-becslésre nem.

## Szellemmenetek

Kiesett járatnak **csak** azt szabad nevezni, ami olyan időszakban lett volna
esedékes, amikor ténylegesen gyűjtöttünk adatot — 5 perc ráhagyással mindkét
szélen. Enélkül minden menet, ami a worker indítása előtt közlekedett, hamisan
kiesettnek látszana.

## Végpontok

```
GET /stats/health                            adatminőség, feladatnapló
GET /stats/vehicle/:id?date=                 napi összefoglaló + menetek
GET /stats/vehicle/:id/track?date=&every=    24 órás nyomvonal
GET /stats/vehicle/:id/routes?ym=            vonal-megoszlás
GET /stats/route/:short?from=&to=            OTP, késéseloszlás, szellemmenetek
GET /stats/stop/:id?from=&to=                pontosság, dwell, követési idő
GET /stats/segment?from=&to=&at=             A→B menetidő-becslés
GET /stats/network/slow?from=&to=            lassú szakaszok (15 perces sávok)
```

Ha az adatbázis nem érhető el, ezek 503-at adnak, és a rendszer valós idejű
része érintetlenül működik tovább.

### Az A→B becslésről

A becslés a kérdezett időponthoz legközelebb induló menet nyomvonalát követi,
mert ugyanaz a vonal napszakonként eltérő menetidővel van tervezve — a 14-es
vonalon a Cementgyár–Villanyrendőr szakasz este 11, csúcsidőben 14 perc.

A szakaszok p85-értékét nem egyszerű összeadással kapjuk: az túlbecsülné az
utat, mert nem minden szakasz akad meg egyszerre. A medián fölötti ráhagyást
négyzetesen összegezzük, ami a szakaszok függetlenségét feltételezi.

A válasz `samples`, `coverage` és `confidence` mezője mindig megmondja,
mennyire lehet hinni neki; adat híján a menetrendre esik vissza, és ezt
`"nincs adat"`-ként jelzi. A `scheduleExact: false` azt jelenti, hogy a
menetrendi alap nem a kért napé — az MVK feedje ugyanis csak néhány napra
teljes előre (2026-09-01-re 957 menet volt definiálva a 08-31-i 2545 helyett).

Minden kiadott becslés bekerül a `prediction_log`-ba a céllal együtt, így
utólag mérhető, mennyire vált be — és később ebből derül ki, hogy egy tanított
modell tényleg jobb-e a profilnál.

## Machine learning

Egyelőre nincs, és ez szándékos: a percentilis-profil azonnal működik,
magyarázható, és nem lehet elrontani. A séma viszont az első naptól úgy épül,
hogy a modell később betanítható legyen — az `entry_delay_s`, `tod_bucket`,
`daytype`, `school` mezők és a `wx_hour` tábla visszamenőleg nem állíthatók
elő. Érdemesi küszöb: szakaszonként ~200 mérés, ami nagyjából 3 hónap
folyamatos gyűjtés.
