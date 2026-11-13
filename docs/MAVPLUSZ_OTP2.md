# MÁV+ OTP2 GraphQL: teljes feltérképezés és integrációs terv

A MÁV+ utazástervező (mavplusz.hu) backendje egy **OpenTripPlanner 2** szerver. Token nélkül elérhető, és egyetlen GraphQL végponton adja az MVK-t (villamos, busz), a MÁV-Volán helyközi buszait és a vasutat: élő GPS-pozíciókat, valós idejű indulásokat, menetrendet, nyomvonalakat, zavarokat és útvonaltervezést.

Ez a leírás két dolgot tartalmaz:

1. **Feltérképezés (1–7. fejezet):** mi van az API-ban, hogyan kell kérdezni, mire kell figyelni. **2026-10-31-én 05:39 és 05:50 között élőben ellenőrizve**, a saját éles MVK-adatunkkal (`mvk.futozs.hu`) párhuzamosan.
2. **Integrációs terv (8–17. fejezet):** az OTP2 legyen az MVK API **tartaléka** (fallback), utána pedig jöjjön a Volán és a vasút a térképre, a megállófigyelőbe, a menetrendbe, a statisztikába és mindenhova, módonként ki-be kapcsolható beállításokkal.
3. **Megvalósítás (M. fejezet, rögtön a 0. után):** ami ebből elkészült, és ahol a terv a mérések miatt módosult. **Ahol a 8–17. fejezet eltér, az M. fejezet a mérvadó.**

Az MVK saját API-ja: [MVK_API.md](MVK_API.md). A rendszer felépítése: [v3.md](v3.md).

---

## 0. Röviden: amit a mérés eldöntött

| Kérdés | Válasz (mérve) |
|---|---|
| Ugyanaz az adat, mint az MVK-é? | **Igen.** A `trip_id`, `stop_id`, `route_id` és a jármű-azonosító **pontosan egyezik** a saját MVK GTFS-ünkkel, csak `mvkzrt:` előtagot kap. 35 járműből 35 egyezett. A TripMatcher változtatás nélkül megeszi. |
| Mennyit késik az MVK-hoz képest? | **0–40 mp** (medián ~10 mp) a natív GTFS-RT-hez képest. Tartaléknak bőven jó, főforrásnak nem. |
| Hiánytalan? | **Nem.** Az OTP2 egy **régebbi MVK GTFS-verziót** használ (élesben `20261031-1`, az OTP2-ben legfeljebb `20261028-1`), ezért az új menetrendű menetek járműveit kihagyja (most 37-ből 2 hiányzott, a 23-as vonal új menetei teljesen). A sietést jelző (negatív) MVK-előrejelzések sem jelentek meg. Az MVK törléslistája nincs benne. |
| Kell token? | **Nem.** Nincs hitelesítés, nincs introspection. |
| Mibe kerül a fallback? | **Semmibe.** A Volánhoz és a vasúthoz úgyis le kell kérdeznünk a régiót 15 mp-enként, és ugyanaz a kérés az MVK járműveit is visszaadja. |
| Az MVK időbélyeg-furcsasága? | Az OTP2 **már kijavítja**: a `lastUpdated` valódi UTC. Pontosan `MVK timestamp − 3600` (8 járműnél másodpercre egyezett). |
| Mit ad még? | Vasútnál **vágányt** (valós időben változik), **vonatszámot és -nevet** (IC TOKAJ), **késés okát** („Pálya állapota miatti késés”), kocsiösszeállítási megjegyzéseket, pótlóbuszt. Volánnál kocsiállást és járatszámot. |

**Döntés:** az MVK API marad a fő forrás. Ha elnémul, a worker magától átáll az OTP2-re, és visszaáll, ha az MVK újra él. A Volán és a vasút **csak** az OTP2-ből jön, ezért az OTP2-kliens állandóan fut.

---

## M. Megvalósítás (2026-10-31)

### M.1 Ami a terv óta kiderült

| Terv | Mérés | Megoldás |
|---|---|---|
| Párhuzamos lekérések (járművek, táblák, zavarok) | Három párhuzamos kérésre a szerver `403` + `host limit achived` **szöveggel** válaszol (nem JSON), és pár másodpercig mindent elutasít. 300–500 ms-os közökkel sosem jött elő. | `apps/worker/src/otp2/client.ts`: **egyetlen sor**, legalább 500 ms közzel, két prioritással (élő adat elöl, menetrend-építés hátul). Korlátnál 15 mp szünet, legfeljebb 3 újrapróbálás. |
| „Könnyű követés” (10.1): csak az élő járművek | A menetrend nélkül nincs megállótábla, viszonylat, tervező, statisztika. | **Teljes regionális menetrend** naponta, GTFS-ként (M.3). |
| Téglalap a régióra | A téglalap átlóg Hevesbe és Szabolcsba. | **Sokszög**: a régi Borsod-Abaúj-Zemplén megye (Ózd és Sátoraljaújhely benne), plusz Füzesabony (`packages/core/src/transit/region.ts`, 21 csúcs). A **megyét érintő** menetek a **teljes útvonalukkal** kerülnek be. |
| Átállás 3 hibás poll / 30 mp után (8.2) | A felhasználó döntése: csak valódi kiesésre. | M.2 |
| Külön `/v3/transit/*` végpontok (14.) | Az app már a v2-végpontokat használja mindenhol. | A v2-végpontok **opcionális** `?modes=` paramétert kaptak (M.5); nélküle a válasz **bájtra ugyanaz**, mint eddig (iOS app). |
| A peron külön megálló (`1:005511387_3`) | A menetrend az állomás `_0` megállóját használja, az élő adat a peronét. | `stationKeyOf()`: az élő késés és vágány az állomás menetrendi megállójához kötődik. |
| `::rt#…` mintázatok | Az OTP2 a valós időben született mintázatokra `null`-t ad. | A felderítés kihagyja őket. |

### M.2 Az MVK forrása (`apps/worker/src/sources.ts`)

- **Azonnal tartalékra**, ha nincs használható token, vagy az MVK `401`/`403`-at ad. (`OTP2_ENABLED=0` mellett nincs hova átállni: az MVK marad, a régi adat 60 mp-ig él.)
- **60 mp** folyamatos kiesés (időtúllépés, 5xx, értelmezhetetlen protobuf) után is tartalékra.
- Tartalékban az MVK-t **10 mp-enként** próbáljuk (csak érvényes tokennel); **5 egymás utáni** sikeres poll után vissza.
- Átálláskor az MVK utolsó saját előrejelzései 60 mp-ig megmaradnak, amíg a MÁV+ megállónkénti adata megjön. A v2-válasz fejléce tartalékban is a feed idejét adja, és csak mért (GPS) pozíciót tartalmaz.
- Tartalékban az MVK járművei a MÁV+-ból jönnek (`mvkzrt:` előtag nélkül, tehát a saját azonosítóinkkal), a TripMatcher ugyanúgy illeszt, a késést maga méri. A MÁV+ által ismert MVK-menetek valós idejét 30 mp-enként kötegben kérjük (megállónkénti előrejelzés).
- Ha az MVK él, a MÁV+ ugyanazon járműveit **árnyékként** összevetjük (késés p50/p95, lefedettség)  ebből tudjuk, mennyire jó a tartalék.
- A napi tartalék-idő, a MÁV+ hívásszámlálói és az árnyék-mérés a `source_health` táblába mennek (percenként; újraindítás után folytatódnak).

### M.3 Regionális menetrend (`apps/worker/src/regional/feeds.ts`, `packages/core/src/transit/regionalGtfs.ts`)

1. **Felderítés:** `stopsByBbox` a régió köré, a sokszögön belüli megállók mintázatai (`mvkzrt:` és `rt#` nélkül).
2. **Mintázatok:** megállósor, nyomvonal, vonal, üzemeltető; 30-as kötegekben, az `otp_pattern` táblában 7 napig gyorsítótárazva.
3. **Napi menetek:** `tripsForDate` 60-as kötegekben a szolgáltatási napra és a következőre. Éjszakai menetek: a nap 03:00 utáni indulásai, plusz a következő nap 03:00 előttiek +24 órával (mint az MVK-nál).
4. **GTFS:** routes (üzemeltetővel, móddal), stops (állomás–peron szülő-gyerek, peronszám), trips (vonatszám), stop_times (fel-/leszállási tilalommal), shapes, calendar_dates. Vasútnál a csempe a kategória (IC, Sz, IR, Pót…), a színe a MÁV-é.
5. **Tárolás:** zipként a `gtfs_feed` táblában (`source = 'regional'`, `service_date`), validálva; a megálló/vonal-dimenziók (`stop`, `route`) frissülnek.
6. **Összefésülés:** szolgáltatási naponként az MVK-feed és a regionális feed **egy közös** `Feed`-be (`Feed.compose`); közös megállónál az MVK-é nyer.

Ütemezés: indításkor a hiányzó napok, utána pg-boss `regional-build` **03:20 és 15:20**-kor (ma + 2 nap), mindkétszer friss felderítéssel és friss menetekkel (a délutáni a MÁV napközbeni változásait hozza; a letöltött napi menetek 6 óráig jók). Ha a tartalom nem változott, nem tárolódik újra; egy nap felülírt változatai törlődnek (a `service_day` által hivatkozott marad). Egy nap építése ~3–4 perc (élőben: 2854 menet, 332 vonal, 5213 megálló). A hubból kézzel is indítható.

### M.4 Valós idő (`apps/worker/src/regional/realtime.ts`)

| Kérés | Gyakoriság | Mire |
|---|---|---|
| Járművek (közút: villamos, busz, Volán a régió körül; vasút országosan, csak a feedben ismert menetek) | 15 mp | térkép, illesztés, GPS-tárolás, statisztika |
| Kiszökött Volán-mintázatok járművei | 30 mp | a régióból kifutó menetek végig követhetők |
| MVK-menetek valós ideje | 30 mp, csak tartalékban | megállónkénti előrejelzés |
| Zavarok (`hkir`, `1`) | 2 perc | késésok, kocsiösszeállítás, pótlás  menetenként, `transit_notice` táblába |
| Figyelt állomások táblája | 60 mp, csak ha valaki nézi | vágány (és változása), törölt menet, késés még el nem indult vonatra |

A vasúti késés a következő megállótól a hátralévő megállókra terjed; a TripMatcher módonként külön profillal illeszt (`MATCH_COACH`, `MATCH_RAIL`: vonatnál 50 m/s, 600 m-es eltérés, 400 m-es állomás-zóna). Minden regionális GPS-jel a `veh_ping`-be kerül, a menetek a `trip_run`-ba (`trip_short` = vonatszám, `rt_source`), a megálló-események a `stop_event`-be  ugyanúgy, mint az MVK-nál. A becsült (menetrendből számolt, nem GPS) helyzetet nem tároljuk.

### M.5 Végpontok

A **v2-végpontok** opcionális `?modes=` paramétert kaptak (`tram,bus,coach,rail` részhalmaza vagy `all`). **Nélküle a válasz bájtra ugyanaz, mint eddig** (csak MVK  az iOS app ezt olvassa).

| Végpont | `?modes=`-szal |
|---|---|
| `/live/positions`, `/live/vehicle` | Volán (rendszám) és vonat (vonatszám, név, hivatalos késés) is; a vonat- és rendszámkeresés is |
| `/live/arrivals`, `/live/multi-arrivals` | állomásnál a peronok összevonva; vágány és változása, MÁV-megjegyzések, mód, üzemeltető, vonatszám |
| `/live/cancelled` | a regionális törlések is |
| `/gtfs/stops.json`, `/gtfs/routes.json` | plusz oszlopok: mód, szülő-állomás, állomás-e, közös megálló (a Volán-megálló MVK-párja); vonal: mód, kulcs, üzemeltető. Amíg a regionális menetrend indulás után épül, `no-store` (nem ragad be a csak MVK-s lista) |
| `/gtfs/route-geo`, `/live/trip-path`, menetrend, menetnapló | regionális azonosítókkal is működnek (a trip-path regionális járműnél módot, rendszámot, vonatszámot is ad) |

Új: `/engine/transit/search` (állomás, megálló, vonatszám), `/engine/transit/stop`, `/engine/transit/relation?from=&to=` (A → B közvetlenül), `/engine/transit/train?no=` (vonatszám ma / holnap) és `?trip=` (pontosan az a vasúti menet), `/engine/transit/trip?trip=` (bármely mód menete ugyanebben az alakban  a térképen követett jármű menetrendje: MVK busz / villamos, Volán, vonat), `/engine/transit/alerts`; `/engine/plan?modes=`; `/v3/stats/regional?days=&modes=`; a `/stats/*` és `/v3/stats/*` `?modes=`-szal regionálisan is szűr. Üzemeltetés (admin-kulccsal): `GET /system/sources`, `POST /system/regional-build`, a `/system/metrics` `source` mezője.

WebSocket: `vehicles@<módok>` és `stop:<id>@<módok>` téma (a `vehicles` és `stop:<id>` marad MVK); az üzenet a `topic` mezőben visszaküldi, melyik témára jött.

`/gtfs/meta.json` `regional` mezője: `off` / `pending` / `ready`  a web `pending` alatt 45 mp-enként újrakéri a katalógust (élesítés után ~3–4 percig épül a mai nap).

**Közös megállók** (`packages/core/src/transit/stopTwins.ts`): a Volán-megálló, amely 220 m-en belül egy azonos nevű MVK-oszlop mellett áll („Miskolc (Hejőcsaba), cementgyár” ↔ „Cementgyár”; a „Miskolc,” előtag, a zárójeles városrész és az „utca / út / tér” nem számít), a legközelebbi ilyen oszlophoz tartozik (élőben 89 pár). Más nevű közeli megállót (Auchan ↔ Keleti kapu, autóbusz-állomás ↔ Búza tér) nem vonunk össze. A `/live/arrivals`, `/live/multi-arrivals` `&merge=all|mvk|coach|off` paramétere (WebSocket: `stop:<id>@<módok>~<merge>`, push: `params.merge`): `all`  az MVK-oszlop és a párja indulásai egy táblán (a válasz `merged` mezője sorolja), `mvk` / `coach`  közös helyen csak az egyik, `off` vagy hiányzó  a régi tábla. A v2 (`?modes=` nélkül) nem változik.

### M.6 Felület

- **Beállítások:** módonként kapcsoló (villamos, városi busz, Volán, vonat), alapból mind be; az első indításkor egy kártya kérdez (marad / csak MVK). **Közös megállók:** Összevonva (alap) / Csak MVK / Csak Volán / Külön  minden megállótáblára (térkép, figyelő, kioszk, értesítés); összevont nézetben a Volán-iker nem külön pötty és nem külön tétel, a figyelő régi iker-bejegyzése az MVK-oszlopra kerül. A fejléc változatlan; az alcím („Miskolc és Borsod közlekedése”) csak a lap címében és a manifestben van.
- **Térkép:** vonat-pirula kategóriával és vonatszámmal, Volán-csempe, becsült helyzet szaggatott kerettel; szűrő módra, üzemeltetőre, vonatkategóriára, késésre; kereső rendszámra (Volán) és vonatszámra. **Bármely jármű követésekor** asztalon jobb oldalt a kártya fölött teljes hosszában ott a menet menetrendje (`FocusDock` + `TripTimetable`, `/engine/transit/trip`): hol tart (sáv + „7/23 megálló”), a következő megálló kiemelve, menetrendi és várható idő, vágány / kocsiállás, vonatnál a késés oka; a térkép gombjai és a jármű a mellette maradó részre húzódnak. Telefonon csak vonatnál van menetrend, a kártya fölött összecsukva (utolsó elhagyott + a következő kettő, „Mind”-dal lenyitható)  busznál, villamosnál, Volánnál ott csak a kártya. A követés-kártya vonatnál a MÁV hivatalos késését mutatja.
- **Figyelő:** állomás (vágányokkal), viszonylat (A → B), vonatszám; kioszk és „szokásos utad” is a bekapcsolt módokkal. Az először nézett állomás táblája 1,5 mp múlva lekérődik (nem a következő percben). Amíg a MÁV nem adta ki a vágányt, a korábbi napok szerinti **várható vágány** látszik (szaggatott keret, „~”): ugyanez a menet ezen az állomáson legalább 2 napon, legalább 60%-ban; különben a vonal ugyanabba az irányba induló menetei legalább 3-szor, 70%-ban (`core/transit/platformGuess.ts`, `transit_platform` 6 hét).
- **Menetrend:** Mind / MVK / Volán / Vonat nézet; **útvonaltervező** Volánnal és vonattal (csempe: „IC 582”, vágány). A tervezőnek saját pipái vannak („Mivel utaznál?”  MVK mindig, Volán, Vonat; `mvk_pref_plan_*`, alapból a Beállítások szerint): mindennel akár Budapest-Keletiig, csak MVK-val a városon belül; átpipáláskor újratervez, a már nem választható hely kiürül.
- **Utazásnapló:** Volánra és vonatra is lehet felszállni; a közelségi küszöbök módonként (vonatnál tágabbak).
- **Parkoló:** az MVK flottájáé  a Szondi György utcai kocsiszínbe, a „néma = beállt” szabályba és a Forda-táblába csak MVK-jármű kerül. A „Volán és vonat” kapcsoló (alapból ki, `mvk_pref_parking_regional`) külön szakaszban mutatja a megyén belüli autóbusz-állomásokon és pályaudvarokon álló regionális járműveket (kocsiszín nélkül; a 15 percnél régebben esedékes, el nem indult menet nem „következő”). A következő menet a MÁV+ kiadásából (biztos) vagy a rendszám-becslőből (forda, megszokott jármű, visszafordulás; a megyén belül induló menetekre, 3 órán belül).
- **Útvonaltervező, „most”:** regionális menetnél az élő késés a MÁV hivatalos késése (mint a térképen és a táblán), nem a 30–60 mp-cel késő jelből mért.
- **Jármű-azonosító mindenhol olvashatóan** (`displayVehicleId`): Volán-busz a magyar rendszám-alakban („RWE-771”, „AA JB-306”), vonat a típusa, sorozata és pályaszáma („KISS 815 038”, „M41 418 322”, „Vectron 193 025”); a teljes UIC-szám a buborékban (`vehicleIdTitle`). A menetek `routeShort`-ja regionálisnál a vonal kulcsa  a felület a címkét kapja („3765”, „IC 191”).
- **Statisztika:** „Vasút és Volán” panel (pontosság, napi késés, legtöbbet késő vonatok, MÁV-késésokok, vágányváltozás); a Járművek, Vonalak és Megállók panel a regionálisakat is mutatja; az üzemzavar és a hőtérkép MVK-s marad.
- **Push:** a figyelés a bekapcsolt módokat nézi (`params.modes`); a szöveg módhoz illő („IC 582 vonat, 3. vágány”).
- **Hub:** „Adatforrások” oldal (forrás, átváltások, árnyék-mérés, MÁV+-hívások és korlát, regionális építések, napi grafikonok), riasztás tartalékra váltáskor és ha a MÁV+ elhallgat.

### M.7 Beállítások (környezeti változók)

| Változó | Alap | Mit |
|---|---|---|
| `OTP2_ENABLED` | `1` | `0` = nincs MÁV+ (se tartalék, se regionális) |
| `REGIONAL` | `1` | `0` = csak az MVK-tartalék, Volán és vasút nélkül |
| `OTP2_URL` | mavplusz.hu GraphQL | |
| `OTP2_USER_AGENT` | `mvk-zsombi-modra/3 (+https://mvk.futozs.hu)` | |
| `OTP2_POLL_MS` / `OTP2_FALLBACK_POLL_MS` | 15000 / 10000 | járművek normál és tartalék üzemben |
| `OTP2_ALERTS_MS` / `OTP2_BOARDS_MS` | 120000 / 60000 | zavarok, figyelt állomások táblái |
| `REGIONAL_DAYS_AHEAD` | 2 | ennyi nappal előre épül a menetrend |
| `FALLBACK_OUTAGE_MS` / `FALLBACK_RECOVER_POLLS` | 60000 / 5 | kiesés → tartalék, sikeres pollok → vissza |

Adatbázis: `packages/db/sql/007_transit.sql` (forrás a `gtfs_feed`-ben, állomás–peron a `stop`-ban, `trip_run.trip_short` / `rt_source`, `otp_pattern`, `source_health`, `transit_notice`, `transit_platform`).

---

## 1. A végpont

| | |
|---|---|
| URL | `https://mavplusz.hu/otp2-backend/otp/routers/default/index/graphql` (az eredetileg talált `hu//otp2-backend` dupla perjel is működik, de egy perjellel használd) |
| Metódus | `POST` |
| Fejlécek | `Content-Type: application/json`, **`Accept-Language: hu`** (nélküle angol szövegek jönnek, lásd 4.5, 9. pont) |
| Törzs | `{ "query": "...", "variables": { ... }, "operationName": "..." }` |
| Hitelesítés | nincs |
| Introspection | tiltva (`IntrospectionDisabled`) |
| Válaszidő | 120–400 ms lekérdezésenként, a tervező (`plan`) ~850 ms |
| Tömörítés | `content-encoding: gzip`, kérd `Accept-Encoding: gzip`-pel |
| Korlátozás | nincs `RateLimit`/`Retry-After` fejléc, nincs dokumentált korlát (lásd 15. fejezet, mennyit kérdezzünk) |
| Hibák | **HTTP 200** jön akkor is, ha a lekérdezés hibás: a hiba az `errors` tömbben van. A státuszkód nem elég, az `errors` mezőt mindig nézni kell. |

```bash
curl -s https://mavplusz.hu/otp2-backend/otp/routers/default/index/graphql \
  -H 'content-type: application/json' -H 'accept-language: hu' --compressed \
  -d '{"query":"{ feeds { feedId } serviceTimeRange { start end } }"}'
```

Hibás mező esetén (így derül ki, mi létezik, ha nincs introspection):

```json
{"errors":[{"message":"Validation error (FieldUndefined@[planConnection]) : Field 'planConnection' in type 'QueryType' is undefined", "extensions":{"classification":"ValidationError"}}]}
```

A séma a szabványos **OTP2 „GTFS GraphQL API”**, de egy **régebbi kiadás**: hiányzik belőle a `planConnection` és a `canceledTrips` is (lásd 6. fejezet). Mezőreferenciának az OTP2 nyilvános dokumentációja jó, de minden mezőt ki kell próbálni, mielőtt építünk rá.

---

## 2. Az adatuniverzum

**14 feed, 156 üzemeltető**, menetrendi ablak: **2025-11-01 → 2027-06-20** (`serviceTimeRange`: `1761951600` → `1813528800`).

| Feed | Mi ez | Kell nekünk? |
|---|---|---|
| **`mvkzrt`** | MVK Zrt., Miskolc: 58 vonal (3 villamos + 55 busz) | ✅ tartalék |
| **`hkir`** | MÁV-Volán helyközi és helyi buszok, 61 üzemeltető-egység | ✅ Volán |
| **`1`** | Vasút: MÁV-START + GYSEV + 80 külföldi vasút | ✅ vonatok |
| `BKK`, `debrecen`, `szeged`, `VBUSZ`, `pecs`, `kecskemet`, `kaposvar`, `tatabanya`, `szombathely`, `paks` | más városok | – (később) |
| `bahart` | balatoni hajók | – |

### 2.1 A minket érintő üzemeltetők

| `agency.gtfsId` | Név | Megjegyzés |
|---|---|---|
| `mvkzrt:MVK` | MVK Zrt. | |
| **`hkir:hkir_V`** | MÁV Személyszállítási Zrt. – Helyközi busz | **Ez viszi a miskolci helyközi járatokat** (a Miskolc környéki 80 Volán-járműből 75), mód: `COACH` |
| `hkir:hkir_V-28352` | MÁV – Tiszaújváros | helyi buszok |
| `hkir:hkir_V-19433` / `-20491` | Mezőkövesd / Eger | a régióban látott helyi egységek, `BUS` (a listában van még pl. Kazincbarcika `-06691` és Ózd `-14492`) |
| `1:198` | MÁV Személyszállítási Zrt. | vonatok |
| `1:134` | GYSEV Zrt. | |
| `1:199` | Szlovák Vasutak | nemzetközi vonatoknál előfordulhat |

„MÁV – Miskolc” nevű egység **nincs**: a miskolci helyközi forgalom a `hkir_V` alatt fut.

### 2.2 Élő járművek (mérve)

| Mikor, hol | Összesen | Bontás |
|---|---|---|
| 05:44, egész ország | **1873** | `hkir` 1021 · `BKK` 499 · `1` (vasút) 276 · **`mvkzrt` 34** · `debrecen` 29 · `VBUSZ` 13 · `paks` 1 |
| ugyanekkor, módonként | | `COACH` 912 · `BUS` 534 · `RAIL` 256 · `TRAM` 113 · `TROLLEYBUS` 38 · `SUBURBAN_RAILWAY` (HÉV) 16 · `TRAMTRAIN` 4 |
| 05:39, Miskolc régió (47,75–48,30 É, 20,30–21,10 K) | **126** | MVK busz 30 · MVK villamos 5 · Volán `COACH` 75 · helyi Volán 5 · vonat 11 |

Napközben ennél jóval több. Az `isEstimated` (menetrendből becsült, nem GPS) a teljes országos mintában csak 6 vonatnál volt `true`; a többi valódi GPS. 5 percnél régebbi jele 42 Volán-járműnek és 1 vonatnak volt.

---

## 3. Azonosítók

Minden stabil azonosító `feed:entitás` alakú (`gtfsId`). A GraphQL `id` mező (base64, pl. `QWxlcnQ6…`) átlátszatlan, ne használd.

### 3.1 MVK: megfeleltetés a saját adatainkkal (ellenőrizve)

| Entitás | OTP2 | Saját (MVK GTFS / GTFS-RT) | Egyezés |
|---|---|---|---|
| Jármű | `vehicleId: "mvkzrt:1644"` | `vehicle.id: "1644"` | **35/35** (az előtag levágása után) |
| Rendszám | `label: "NID044 (1644)"` | `vehicle.licensePlate: "NID044 (1644)"`, a natív `label` csak `"BUS"` | ✅ |
| Menet | `mvkzrt:10951_1396_051000_B3O` | `trip_id: 10951_1396_051000_B3O` | ✅ |
| Megálló | `mvkzrt:SP298`, név: **`Miskolc, Papírgyár`** | `SP298`, név: `Papírgyár` | az ID ✅, a névben „Miskolc, ” előtag |
| Vonal | `mvkzrt:1`, `mode: BUS`, `type: 704` | `route_id: 1`, `route_type: 704` (villamos: 900) | ✅ |
| Minta (pattern) | `mvkzrt:1:1:01` = vonal:irány:sorszám | nincs ilyen, a mi `pattern`-ünk más | – |
| `blockId` | `null` | a GTFS-ben sincs `block_id` | ✅ (forda-terv továbbra is a miénk) |

A megállók **száma** is stimmel: a Miskolc-bbox 577 `mvkzrt` megállót ad, az éles GTFS-ben 586 van (a különbség a dobozon kívül eső, illetve csak az új GTFS-ben szereplő megállók).

### 3.2 Volán (`hkir`)

| Entitás | Példa | Jelentés |
|---|---|---|
| Jármű | `hkir:hkir_LWA387`, `label: "LWA387"` | a **rendszám** |
| Menet | `hkir:hkir_H2504_1385-1`, `tripShortName: "3/1385"` | `vonalszám/járatszám` |
| Vonal | `hkir:hkir_V-28352-H-3-3`, `shortName: "3"` | a `shortName` a kiírt vonalszám (Miskolcon négyjegyű: `3765`, `3738`) |
| Megálló | `hkir:hkir_214771_2` | `_1` / `_2`: a két irány oldala |
| Állomás | `hkir:hkir_213938` (Miskolc, autóbusz-állomás) | szülő-megálló |
| Kocsiállás | `hkir:hkir_213938_11`, `platformCode: "11"` | a Búza téri állomáson 1–20 |

### 3.3 Vasút (`1`)

| Entitás | Példa | Jelentés |
|---|---|---|
| Jármű | `1:945514150834`, `label: ""` | 12 jegyű járműszám (valószínűleg az európai járműszám, EVN). A vonatszámot a menetből kell venni. |
| Menet | `1:35051173` | **numerikus, nem a vonatszám.** Stabil kulcsnak a `(serviceDate, vonatszám)` párt használd (lásd 9.1). |
| Vonatszám és nem | `tripShortName: "5040 személyvonat"`, `"582 TOKAJ InterCity"`, `"5019 InterRégió"` | első szám = vonatszám, utána a nem és a név |
| Vonal | `1:E28519657`, `longName: "Sz 5510/5512/…"`, `"IC TOKAJ"` | egy „vonal” = vonatszámok csoportja |
| **`route.shortName`** | `<span class="MNR2007">&#484;</span>` | **HTML!** A MÁV saját piktogram-betűtípusának egy jele. Soha ne jelenítsd meg nyersen (XSS, értelmetlen karakter). |
| `route.type` | `102` IC / távolsági, `103` InterRégió, `106` személyvonat | |
| Állomás | `1:005511387` = Miskolc-Tiszai | valószínűleg UIC-alapú kód (55 = Magyarország) |
| Vágány | `1:005511387_3`, `platformCode: "3"` | `_1`…`_9`, `_1Kih`, betűs is (`A`); `_0` = állomásszintű, vágány nélkül |

### 3.4 A régió fontos megállói (ellenőrizve)

| Hely | Vasút | Volán | MVK |
|---|---|---|---|
| **Miskolc-Tiszai pu.** | `1:005511387` (1–9, 1Kih) | `hkir:hkir_213995_1`, `_2` | busz: `SP388`, `SP389`, `SP391`, `SP392`, `SP393`, `SP3548`; villamos: `SP475`, `SP476`, `SP477` |
| **Miskolc-Gömöri pu.** | `1:005512674` (1–3) | – | `SP155`, `SP156`, `SP159` |
| **Miskolc, autóbusz-állomás** (Búza tér) | – | `hkir:hkir_213938` (20 számozott kocsiállás) | `SP66`–`SP77` (Búza tér) |
| **Nyékládháza** | `1:005511361` | legalább 24 megálló (`vasútállomás`: `hkir:hkir_214073_1`) | – |
| **Füzesabony** | `1:005511296` | `hkir:hkir_101346` (vasútállomás, kocsiállásokkal) | – |
| **Felsőzsolca** | `1:005511395` | `hkir:hkir_213433_*` és mások | `SP145` |
| Mezőkövesd | `1:005511312` (vágány `_2` látszott) | | |

---

## 4. Mezők és jelentésük

### 4.1 Két időkódolás, nem szabad összekeverni

| Mező | Kódolás | Példa |
|---|---|---|
| `vehiclePositions.lastUpdated`, `serviceTimeRange`, `alerts.effectiveStartDate/EndDate` | **unix másodperc, valódi UTC** | `1793421548` |
| `stoptime.serviceDay` | a szolgáltatási nap **helyi éjfele** unixban | `1793401200` = 2026-10-31 00:00 CET |
| `scheduledArrival/Departure`, `realtimeArrival/Departure` | **másodperc a `serviceDay` óta** (éjfél után 86 400 fölé is mehet) | `20280` = 05:38 |
| `arrivalDelay`, `departureDelay` | előjeles másodperc, a negatív sietés | `188`, `-81` |
| `plan(date, time)` | **helyi** dátum és idő | `"2026-10-31"`, `"07:00"` |
| `plan` eredmény `startTime`/`endTime` | unix **ezredmásodperc** | |

Egy indulás valódi időpontja: `serviceDay + realtimeDeparture`.

**Az MVK furcsasága itt már nincs:** az MVK GTFS-RT helyi időt kódol unixként (MVK_API.md 4.1), az OTP2 `lastUpdated` viszont valódi UTC. Az OTP2-adapterben tehát **tilos** levonni a budapesti eltolást.

### 4.2 Jármű (`VehiclePosition`)

| Mező | Jelentés |
|---|---|
| `vehicleId`, `label` | lásd 3. fejezet |
| `lat`, `lon` | GPS |
| `heading` | fok (vasútnál egész szám) |
| `speed` | **m/s** (a Volán 1,94 = 7 km/h; az MVK-nál ugyanannál a fixnél pontosan a natív érték, az iránnyal együtt) |
| `lastUpdated` | a jármű utolsó jele, UTC unix |
| `isEstimated` | `false` valódi GPS, `true` menetrendből becsült |
| `stopRelationship { status stop }` | `STOPPED_AT` (áll a megállóban), `IN_TRANSIT_TO` (oda tart); a szabványos `INCOMING_AT` nem jött elő |
| `nextStop { arrivalDelay departureDelay scheduledArrival realtimeArrival stop }` | a következő megálló a késéssel együtt |
| `trip { gtfsId tripShortName routeShortName tripHeadsign serviceDate directionId pattern { code } route { … } }` | a menet, `serviceDate` ISO (`2026-10-31`) |

### 4.3 Indulás (`Stoptime`)

| Mező | Jelentés |
|---|---|
| `realtime` | van-e valós idejű adat |
| `realtimeState` | `SCHEDULED` (csak menetrend), `UPDATED` (busz-előrejelzés), **`MODIFIED`** (vasútnál ez jön), `CANCELED`, `ADDED` |
| `headsign` | cél |
| `stop { platformCode }` | **vágány / kocsiállás.** Vasútnál a valós idejű adat **átírhatja** (a menetrend szerint vágány nélküli megálló élőben „8”-as vágányt kapott) |
| `pickupType` | `SCHEDULED`, `NONE` (végállomás, nem lehet felszállni), **`COORDINATE_WITH_DRIVER`** (feltételes megálló) |
| `trip { wheelchairAccessible bikesAllowed }` | IC-knél `POSSIBLE` / `ALLOWED`, személyvonatnál többnyire `NO_INFORMATION` |

### 4.4 Zavar (`Alert`)

`feed`, `alertHeaderText`, `alertDescriptionText` (HTML lehet), `alertUrl`, `alertEffect`, `alertCause`, `alertSeverityLevel`, `effectiveStartDate`, `effectiveEndDate` (`null` lehet), `entities` (`Trip` / `Route` / `Stop` / `Unknown`). **`alertId` mező nincs.**

### 4.5 Buktatók (élőben ellenőrizve)

1. **A megállók közösek a feedek között, mindkét irányban.** Egy `hkir` megállón MVK-járat áll meg, és fordítva: a Tiszai pu. `mvkzrt:SP388` indulásai között a `hkir:hkir_3738_366-5` Volán-járat is ott volt. **Mindig a menet üzemeltetője (`trip.route.agency`) vagy módja szerint szűrj, soha ne a megálló feedje szerint.**
2. **A `numberOfDepartures` nem szigorú korlát.** `numberOfDepartures: 10` mellett 15 sor jött. **Állomáson** (`station`) a korlát vágányonként értendő: a Miskolc-Tiszai 11 vágánya miatt `numberOfDepartures: 12` szinte az egész napot visszaadta (93 KB). Mindig adj meg `timeRange`-et (mp), és a kliensen rendezz és vágj.
3. **`trip.stoptimes` csak menetrend.** Valós idejű késés és vágány csak a `trip.stoptimesForDate(serviceDate: "YYYYMMDD")`-ből jön. Ugyanannál a vonatnál a `stoptimes` 0 késést mutatott, a `stoptimesForDate` +180 mp-et és élő vágányt.
4. **Dupla vonatok.** Ugyanaz a vonat két menetként is szerepelhet (`520 HERNÁD - ZEMPLÉN InterCity` és `520 ZEMPLÉN InterCity` ugyanabban a percben, ugyanarról a vágányról), és az összekapcsolt vonatok is külön sorok (`181 HERNÁD` + `507 HERNÁD - ZEMPLÉN`, 07:35, 3-as vágány). Vonatszám + idő + vágány szerint vond össze.
5. **Dupla MVK-menetek.** Az MVK GTFS-ben két szolgáltatás ugyanarra a napra is él (`10825_22_062000_AZM` és `_AW9`, mindkettő aktív 10-31-én). A natív tábla ezt már kiszűri; az OTP2-ből jövőnél ugyanezt kell tenni.
6. **Az OTP2 MVK-adata régebbi GTFS-en fut** (3.1, 7. fejezet). Az OTP2 csak azokat a járműveket adja, amelyek menetét ismeri: az új szolgáltatási azonosítójú menetek (pl. `11025_…` a 23-ason) **hiányoznak** a járművek közül és a megállótáblákról is.
7. **A `plan` nem minden indulást ad,** csak a keresési ablak (`searchWindowUsed: 10800` mp) legjobb lehetőségeit. „Minden vonat Füzesabonyba” kérdésre a megállótábla kell, nem a tervező.
8. **`plan` helyi időt vár** (`time: "05:00"` → 05:09-es indulás), az eredmény viszont UTC ezredmásodperc.
9. **Nyelv:** `Accept-Language: hu` nélkül a tervező angolul ír (`5169 passenger train`), és a Telebusz-zavar is angol (`Telebus: this route operates only upon request!`). Magyar fejléccel: `5169 személyvonat`, `Telebusz: csak igény jelzése esetén közlekedik!`.
10. **HTML a mezőkben:** a vasúti `route.shortName` (3.3) és a zavarok `alertDescriptionText` mezője HTML. Csak tisztítva (vagy szövegként) jelenítsd meg.

---

## 5. Lekérdezés-katalógus (mind kipróbálva)

### 5.1 Élő járművek egy területen

```graphql
query Vehicles($swLat: Float!, $swLon: Float!, $neLat: Float!, $neLon: Float!) {
  vehiclePositions(swLat: $swLat, swLon: $swLon, neLat: $neLat, neLon: $neLon,
                   modes: [TRAM, BUS, COACH, RAIL]) {
    vehicleId label lat lon heading speed lastUpdated isEstimated
    stopRelationship { status stop { gtfsId name } }
    nextStop { arrivalDelay departureDelay scheduledArrival realtimeArrival stop { gtfsId } }
    trip {
      gtfsId tripShortName tripHeadsign serviceDate directionId
      pattern { code }
      route { gtfsId mode type shortName longName color textColor agency { gtfsId } }
    }
  }
}
```

Változók a régióhoz: `{"swLat":47.75,"swLon":20.30,"neLat":48.30,"neLon":21.10}`. Mért méret: 126 jármű, 117 KB (tömörítetlen), 209 ms. Az MVK-hoz elég `modes: [TRAM, BUS]` és a `48.0, 20.6 → 48.2, 20.95` doboz (35 jármű, 13 KB).

Egyetlen kérés adja mind a négy réteget; utána **üzemeltető szerint** szétválogatni:

| Réteg | Szűrés |
|---|---|
| MVK villamos + busz | `trip.route.agency.gtfsId === "mvkzrt:MVK"` |
| Volán | `vehicleId` `hkir:` kezdetű |
| Vasút | `vehicleId` `1:` kezdetű (`RAIL`, `SUBURBAN_RAILWAY`, `TRAMTRAIN`, `RAIL_REPLACEMENT_BUS`) |

### 5.2 Megállótábla (egy megálló)

```graphql
{
  stop(id: "mvkzrt:SP388") {
    gtfsId name
    stoptimesWithoutPatterns(numberOfDepartures: 10, timeRange: 5400, omitNonPickups: true) {
      serviceDay scheduledDeparture realtimeDeparture departureDelay realtime realtimeState headsign
      trip { gtfsId routeShortName route { mode agency { gtfsId } } }
    }
  }
}
```

### 5.3 Állomástábla (vasút, autóbusz-állomás)

```graphql
{
  station(id: "1:005511387") {
    name
    stoptimesWithoutPatterns(numberOfDepartures: 3, timeRange: 7200, omitNonPickups: true) {
      serviceDay scheduledDeparture realtimeDeparture departureDelay realtime realtimeState headsign
      stop { platformCode }
      trip { gtfsId tripShortName wheelchairAccessible bikesAllowed
             route { longName mode type agency { gtfsId } } }
    }
  }
}
```

Valódi sorok (Miskolc-Tiszai, 05:40-kor):

| Menetrend | Várható | Vonat | Cél | Vágány |
|---|---|---|---|---|
| 05:44 | 05:44 | 35029 személyvonat | Tiszaújváros | 3 |
| 05:50 | 05:50 | 5027 személyvonat | Füzesabony | 7 |
| 06:26 | 06:26 | 580 TOKAJ InterCity | Budapest-Nyugati | 9 |
| 07:30 | **07:34 (+4)** | 582 TOKAJ InterCity | Budapest-Nyugati | 9 |

A Miskolci autóbusz-állomáson (`hkir:hkir_213938`) ugyanez a lekérdezés kocsiállással adja: `05:45 | 3765/651 | Kazincbarcika | kocsiállás 11`.

### 5.4 Egy menet valós idővel

```graphql
{
  trip(id: "1:35051173") {
    tripShortName tripHeadsign
    alerts { alertDescriptionText }
    stoptimesForDate(serviceDate: "20261031") {
      stop { name platformCode }
      scheduledArrival realtimeArrival arrivalDelay realtime realtimeState
    }
    tripGeometry { length points }
  }
}
```

Eredmény: `5040 személyvonat → Miskolc-Tiszai`, minden megállóban +180 mp, Miskolc-Tiszai 8-as vágány, és a zavarokból: **„Pálya állapota miatti késés”**.

### 5.5 Sok menet egy kérésben (az MVK-fallbackhez)

A GraphQL aliasokkal egy kérésben több menetet is lekérdezhetünk. Így pótolható az MVK `get-updates` (lásd 8.4):

```graphql
{
  t0: trip(id: "mvkzrt:10951_1396_051000_B3O") { ...rt }
  t1: trip(id: "mvkzrt:10836_2022_052000_AZE") { ...rt }
}
fragment rt on Trip {
  gtfsId
  stoptimesForDate(serviceDate: "20261031") { stop { gtfsId } realtimeArrival arrivalDelay realtime realtimeState }
}
```

Nem létező menetre `null` jön, hiba nélkül.

### 5.6 Nyomvonal

```graphql
{ pattern(id: "mvkzrt:1:1:01") { code headsign stops { gtfsId name } patternGeometry { length points } } }
```

A `points` Google-féle kódolt polyline (5 tizedes). Az 1-es busz egy mintája: 25 megálló, 522 pont, 1351 karakter. A menetre szabott változat: `trip { tripGeometry { points } }`.

### 5.7 Napi menetrend egy megállóban

```graphql
{ stop(id: "1:005511361_0") { stoptimesForServiceDate(date: "20261031", omitNonPickups: true) {
    pattern { code headsign } stoptimes { scheduledDeparture trip { tripShortName } } } } }
```

Mintánként csoportosít (Nyékládháza: 105 minta, de sok üres; 64 indulás).

### 5.8 Katalógusok

| Lekérdezés | Mire | Mért |
|---|---|---|
| `routes(feeds: ["mvkzrt"]) { gtfsId shortName mode color textColor }` | vonallista | 58 (3 `TRAM`, 55 `BUS`) |
| `route(id: "mvkzrt:23") { trips { gtfsId } patterns { code } }` | egy vonal menetei | |
| `trip(id) { activeDates }` | a menet naptára | `["20261031","20261101",…]` |
| `stopsByBbox(minLat, minLon, maxLat, maxLon)` | megállók egy területen | Miskolc: 844 (577 MVK, 246 Volán, 21 vasúti) |
| `stops(name: "Tiszai")` | keresés név szerint | 25 találat, minden feedből |
| `nearest(lat, lon, maxDistance, filterByPlaceTypes: [STOP])` | közeli megállók | Városház tér: `SP487` 67 m |
| `feeds { feedId agencies { gtfsId name } }` | üzemeltetők | 14 feed |
| `serviceTimeRange { start end }` | menetrendi ablak | |

### 5.9 Zavarok

```graphql
{ alerts(feeds: ["mvkzrt", "hkir", "1"]) {
    feed alertHeaderText alertDescriptionText alertEffect alertCause alertSeverityLevel
    effectiveStartDate effectiveEndDate
    entities { __typename ... on Trip { gtfsId } ... on Route { gtfsId } ... on Stop { gtfsId name } } } }
```

Mért (05:45): **83 zavar, 82 vasúti, 1 Volán, 0 MVK.** A vasúti zavarok nagy része **egy vonathoz kötött késésok**, ezért a táblán és a statisztikában is értékes:

| Darab | Szöveg |
|---|---|
| 36 | Pálya állapota miatti késés |
| 14 | Vonat műszaki hibája miatti késés |
| 6 | Társvasúttól átvett késés |
| 5 | Tartózkodási idő túllépése |
| 3 | Biztosítóberendezési hiba miatti késés |
| 2–2 | Más vonat által okozott késés; Csatlakozásra várás miatti késés |
| egyedi | „A vonat utolsó kettő kocsija Nyíregyházáig közlekedik.”, „A vonat első kocsija lezárva közlekedik…”, „Mándok - Tornyospálca: pótlóbusz”, „Várhatóan 15-20 perces késéssel indul.” |

Az MVK hírei továbbra is az MVK API-ból jönnek (`/engine/news`), itt nincsenek.

### 5.10 Útvonaltervező

```graphql
{ plan(from: {lat: 48.1036, lon: 20.7784}, to: {lat: 47.7491, lon: 20.4107},
       date: "2026-10-31", time: "12:00", numItineraries: 3) {
    searchWindowUsed
    itineraries { startTime endTime duration
      legs { mode startTime endTime departureDelay realTime
             from { name stop { gtfsId platformCode } } to { name }
             route { shortName agency { gtfsId } } trip { gtfsId tripShortName } legGeometry { points } } } } }
```

Városház tér → Füzesabony: `12:02 gyalog → 12:04 1V villamos → Tiszai pu. → 12:20 5127 személyvonat`. Multimodális és országos: a villamost és a vonatot egy tervben köti össze. **`planConnection` nincs.**

---

## 6. Eltérések a korábbi (beillesztett) jegyzethez képest

| Korábbi állítás | Mérve 2026-10-31-én |
|---|---|
| `plan` / **`planConnection`** | Csak `plan` van. `planConnection` → `FieldUndefined`. |
| `realtimeState`: `SCHEDULED`, `UPDATED`, `CANCELED`, `ADDED`, `NO_DATA` | Vasútnál **`MODIFIED`** jön. `NO_DATA` nem látszott. |
| 130 aktív zavar | Most 83 (82 vasút). Napszaktól függ. |
| 1608 jármű (késő este) | 05:44-kor 1873. Napközben több. |
| `numberOfDepartures` = darabszám | Nem szigorú; állomáson vágányonként számít (4.5, 2. pont). |
| „Ez az egy végpont szükségtelenné teszi az MVK API-t” | **Nem.** Az OTP2 MVK-adata 0–40 mp-cel késik, régebbi GTFS-en fut (hiányzó járművek), a sietést nem mutatja, és nincs benne az MVK törléslistája. **Tartaléknak** jó (7. fejezet). |
| Az MVK API Play Integrity JWT-vel védett | Az Android appnál. Az Apple-appok App Attestet használnak; mi a Macen futó appból vesszük a tokent (MVK_API.md 1. fejezet). |
| `canceledTrips` | Nincs ilyen mező ebben az OTP-verzióban. |

---

## 7. MVK natív kontra OTP2: mérés

Ugyanabban a percben (05:46) lekérve a saját éles `/live/positions` és `/live/arrivals?stop=SP388` végpontunkat (natív MVK GTFS-RT), valamint az OTP2-t:

| Szempont | Natív MVK | OTP2 (`mvkzrt`) |
|---|---|---|
| Járművek | 37 | 35 (hiányzott: `33` a 16-oson, `2203` a 23-ason) |
| Jármű-azonosító egyezés | | 35/35 |
| Menet-azonosító egyezés | | 34–35/35 (két mérésből) |
| Pozíció-eltérés | | harmaduk 0 m, a többi 1–138 m (az OTP2 régebbi fixe) |
| Késés a natívhoz képest (`ts − 3600 − lastUpdated`) | | **0–40 mp, medián ~10 mp** |
| Időbélyeg | helyi idő unixként | valódi UTC |
| GTFS-verzió | `20261031-1` | ≤ `20261028-1` (a 23-as a régi `10910` szolgáltatással) |
| Új menetrendű menetek | megvannak | **hiányoznak** (a 23-as `11025_…` menetei sem a járművek, sem a táblák között) |
| Késés-előrejelzés, késik a busz | 8: +197 mp; 44: +64 mp | 8: +208 mp; 44: +47 mp |
| Késés-előrejelzés, siet a busz | 44: −140 mp; 21: −197 mp | **0, `SCHEDULED`** (a sietés hiányzik) |
| Törölt menetek | `list-cancelled-trips` | nincs megfelelője |
| Hírek, időjárás | van | nincs |

**Következtetés.** Az OTP2 ugyanaz az MVK-adat, csak késve és hiányosabban. A fallbackben ezért **a pozíciókra** építünk: a TripMatcher ugyanúgy illeszt és **maga méri a késést** (`measuredDelaySec`), ahogy most is. Az OTP2 késés-előrejelzése csak kiegészítés. Az OTP2 hiányzó járműveit pótolni nem tudjuk, ezért a hub mutassa a lefedettséget (8.6).

---

## 8. Architektúra: a forrás-réteg

> Ez és a következő fejezetek az **eredeti terv**. Ahol a megvalósítás eltér (átállási szabály, végpontok, menetrend), az **M. fejezet** a mérvadó.

```
                         ┌───────────── worker ─────────────────────────────────────────┐
 MVK GTFS-RT ──2,5 mp──► │ MvkSource  ──┐                                               │
 (token)                 │              ├─► SourceManager ──► RtFrame ──► buildSnapshot │──► TripMatcher, WS, push…
                         │ Otp2Mvk ─────┘   (primary/fallback)                          │    (változatlan)
                         │   ▲                                                          │
 MÁV+ OTP2 ──15 mp──────►│ RegionalPoller ──► Volán-réteg ─┐                            │
 (régió bbox)            │   (1 kérés)    └─► Vasút-réteg ─┴─► TransitHub ──► /v3/transit/*, WS „transit”
                         │ Otp2Static (napi) · Otp2Boards (igény szerint, 20 mp cache) · Otp2Alerts (2 perc)
                         └──────────────────────────────────────────────────────────────┘
```

### 8.1 Közös köztes alak: `RtFrame`

Ma a `buildSnapshot` (`packages/core/src/realtime/snapshot.ts`) közvetlenül protobufot dekódol, és levonja a helyi eltolást. Ketté kell vágni:

```ts
// packages/core/src/realtime/frame.ts
export type RtVehicle = {
  id: string;            // MVK: "1644" (előtag nélkül)
  label: string;         // rendszám, ha van
  lat: number; lon: number;
  bearing: number | null; speed: number | null;   // m/s
  ts: number;            // valódi UTC unix  az adapter feladata, hogy már így adja
  rtTripId: string;      // a forrás menet-azonosítója (előtag nélkül)
  routeId: string;
};
export type RtStopUpdate = { stopId: string; unix: number | null; delay: number | null };
export type RtFrame = {
  source: "mvk" | "otp2";
  fetchedAt: number;
  headerTs: number;
  vehicles: RtVehicle[] | null;                   // null = ez a rész nem jött le
  updates: Map<string, RtStopUpdate[]> | null;    // tripId → megállók
  error: string | null;
};
```

- `decodeMvkFrame(positions, updates, offset)`: a mai dekódolás, az eltolás levonásával.
- `otp2Frame(vehiclePositions, tripBatch)`: előtag le, **eltolás nélkül**.
- `buildSnapshot(frame, days, midnightUnix, now)`: a mai logika második fele, változatlanul.

Így a snapshot, a TripMatcher, a megállófigyelő és a push semmit sem tud arról, honnan jött az adat.

### 8.2 `SourceManager`: mikor álljon át

| Állapot | Belépés | Kilépés |
|---|---|---|
| `primary` (MVK) | indulás; vagy fallbackből, ha az MVK **5 egymás utáni** pollja sikeres és a token érvényes | |
| `fallback` (OTP2) | nincs token vagy lejárt; **3 egymás utáni** hibás MVK-poll; vagy 30 mp óta nincs sikeres pozíció | vissza `primary`-ba (fent) |
| `down` | az OTP2 is 60 mp óta hibás | bármelyik forrás újra él |

- A hiszterézis (3 be, 5 ki) azért kell, hogy egy-egy hibás poll ne billegtesse.
- Fallbackben az OTP2-t **10 mp-enként** kérdezzük. Sűrűbben értelmetlen: az OTP2 adata maga is 10–40 mp-es.
- A váltás **nem okoz duplikációt**: az OTP2 `lastUpdated` ugyanaz a másodperc, mint a natív `timestamp − eltolás`, ezért az `engine.lastTs` ellenőrzése és a `veh_ping (vehicle_id, ts)` egyedi index kiszűri az ismétlést.
- Az `engine.pollOnce` mai korai visszatérése („nincs MVK token” → üres snapshot) megszűnik: token nélkül is van adat, csak a tartalék forrásból.
- A `rtError` helyett új mező: `snapshot.source = "mvk" | "otp2"` és `snapshot.lagSec`. A WebSocket `tick` is viszi.

### 8.3 Ami fallbackben működik, és ami nem

| Funkció | Fallbackben |
|---|---|
| Térkép, járműkövetés, élő mozgás | ✅ (10–40 mp-cel lemaradva; a mozgásmodell ezt kisimítja) |
| TripMatcher, menetek, megálló-események, statisztika | ✅ (saját mérés, változatlan) |
| Megállófigyelő, „Elérem?”, push | ✅ |
| Késés-előrejelzés megállónként | ✅ részben (8.4) |
| Rendszám-előrejelzés, forda-terv | ✅ (a saját adatainkból) |
| Törölt menetek | ⚠️ a nap utolsó MVK-listája marad, `stale: true` jelzéssel |
| Új GTFS-verzió menetei | ⚠️ hiányozhatnak (az OTP2 nem ismeri őket) |
| MVK hírek | ⚠️ a meglévő 10 perces gyorsítótár, `stale: true` |
| MVK-útvonaltervező (`/api/v1/route/plan`) | ❌, helyette a saját RAPTOR-unk vagy az OTP2 `plan` |
| Kihasználtság (`occupancyStatus`) | ❌ |

### 8.4 Megállónkénti előrejelzés fallbackben

Két réteg:

1. **Minden pollban:** a `nextStop.arrivalDelay` járművenként. A `buildSnapshot` már tud késésből és menetrendből időpontot számolni (`if (unix == null && delay != null && sched)`), ez elég a következő megállóra.
2. **30 mp-enként:** egy aliasos kérés (5.5) az összes futó MVK-menet `stoptimesForDate`-jével. Csúcsidőben ~60 menet × ~25 megálló, egy kérésben (~50–80 KB). Ez pótolja a `get-updates`-et.

### 8.5 Árnyék-összevetés (amikor az MVK él)

A regionális poll 15 mp-enként úgyis lehozza az MVK járműveit. Ezt nem dobjuk el, hanem összevetjük a natívval, és a hubba írjuk:

- **lefedettség:** OTP2-járművek / natív járművek (most 35/37 = 95%)
- **késés:** p50 / p95 másodpercben
- **pozíció-eltérés:** p50 / p95 méterben

Ha a lefedettség hirtelen leesik (pl. az MVK új GTFS-t adott ki, és az OTP2 még nem töltötte be), a hub jelez: a fallback ilyenkor kevesebbet ér.

### 8.6 Kódhelyek

| Mi | Hova |
|---|---|
| `RtFrame`, MVK-dekódoló, snapshot-építés szétválasztva | `packages/core/src/realtime/frame.ts`, `snapshot.ts` |
| OTP2 GraphQL-kliens (időkorlát 8 mp, `Accept-Language: hu`, `User-Agent`, `errors` ellenőrzés, `upstreamMetrics`) | `apps/worker/src/sources/otp2Client.ts` |
| A lekérdezések egy helyen, típusosan | `apps/worker/src/sources/otp2Queries.ts` |
| Válasz → `RtFrame` (MVK), → `TransitVehicle` (Volán, vasút) | `packages/core/src/sources/otp2.ts` (tiszta függvények, tesztelhetők) |
| Átállás | `apps/worker/src/sources/manager.ts` |
| Regionális poll, Volán- és vasút-réteg | `apps/worker/src/transit/*.ts` |
| Tesztek: rögzített OTP2-válaszok → ugyanazok a menetek, mint a natívból | `packages/core/test/otp2*.test.ts`, minták: `packages/core/test/fixtures/otp2/` |
| Szimulátor fejlesztéshez (mint a `mock-mvk.ts`) | `tools/import-mysql/src/mock-otp2.ts` |

---

## 9. Adatmodell

### 9.1 Az azonosító-szabály

**Az MVK-azonosítók maradnak előtag nélkül** (`SP388`, `21`, `1644`, `10951_1396_…`). **Minden más forrás pontosan úgy kerül be, ahogy az OTP2 adja, előtaggal** (`hkir:hkir_213938_11`, `1:005511387_3`, `hkir:hkir_LWA387`).

- Egy azonosító akkor MVK-s, ha nincs benne kettőspont. (Az MVK-azonosítókban sosem volt.)
- Így a meglévő adat, a v2-végpontok és az iOS app érintetlen marad, a nagy hypertable-ök (`veh_ping`, `stop_event`, `segment_run`) sémája nem változik.
- **Vasútnál a menet kulcsa** nem az OTP2 numerikus `trip.gtfsId`-ja (napról napra változhat), hanem: `1:<vonatszám>` a `route_short` helyén és a `serviceDate`. A `trip_id` mezőbe az OTP2-azonosító kerül, de a statisztika vonatszám szerint csoportosít.
- **Volánnál** a `route_short` = `hkir:<vonalszám>` (pl. `hkir:3765`). Megjelenítéskor az előtag lemarad.

### 9.2 `007_transit.sql` (javaslat)

```sql
-- Kis, nem hypertable táblák bővítése (nullable, nincs visszatöltés)
ALTER TABLE stop    ADD COLUMN IF NOT EXISTS feed text, ADD COLUMN IF NOT EXISTS parent_station text,
                    ADD COLUMN IF NOT EXISTS platform text, ADD COLUMN IF NOT EXISTS mode text;
ALTER TABLE route   ADD COLUMN IF NOT EXISTS feed text;          -- a `kind` új értékei: COACH, RAIL
ALTER TABLE vehicle ADD COLUMN IF NOT EXISTS feed text;
ALTER TABLE trip_run ADD COLUMN IF NOT EXISTS rt_source text;    -- 'mvk' | 'otp2' | 'mixed'

-- Forrásonkénti egészség (a feed_health MVK-s, ez mindegyikre)
CREATE TABLE IF NOT EXISTS source_health (
  service_date date NOT NULL, source text NOT NULL,
  polls_ok int NOT NULL DEFAULT 0, polls_fail int NOT NULL DEFAULT 0,
  lag_p50_s int, lag_p95_s int, coverage real, fallback_s int NOT NULL DEFAULT 0,
  PRIMARY KEY (service_date, source)
);

-- Vasúti késésokok és megjegyzések (az alerts-ből), a statisztikához
CREATE TABLE IF NOT EXISTS rail_notice (
  service_date date NOT NULL, train_no int NOT NULL, trip_id text NOT NULL,
  text text NOT NULL, kind text NOT NULL,          -- 'cause' | 'composition' | 'replacement' | 'other'
  first_seen timestamptz NOT NULL, last_seen timestamptz NOT NULL,
  PRIMARY KEY (service_date, train_no, text)
);
```

- A `stop_event.src` új értéket kap: **`4` = az OTP2 állapotából** (Volán, vasút; lásd 10.1). A statisztika az MVK-t (1–3) és a többit így külön tudja kezelni.
- A `trip_run.source` CHECK-je marad (`live` / `replay` / `legacy`); az adatforrás a `rt_source`-ba kerül.
- **Mennyiség:** a régióban napközben ~100–200 nem MVK-s jármű, 15–30 mp-enként új jellel: ~300–600 ezer `veh_ping` sor naponta, az MVK két-háromszorosa. A 3 napos tömörítéssel ez néhány MB naponta.

---

## 10. Statikus adatok a Volánhoz és a vasúthoz

A TripMatcher egy teljes `Feed`-et vár (megállók, menetek, időpontok, nyomvonalak, naptár). Az MVK-nál ez a GTFS zip. A másik két forrásnál két út van:

### 10.1 Könnyű követés (első kör, javasolt)

Az OTP2 már elvégzi az illesztést: megmondja a menetet, a megállót, az állapotot és a késést. Ebből saját illesztő nélkül is lesz statisztika:

- **menet** (`trip_run`): az első és az utolsó jel, induló és záró késés;
- **megálló-esemény** (`stop_event`, `src = 4`): amikor a `stopRelationship` `STOPPED_AT X`-re vált, az érkezés; amikor elhagyja, az indulás. A késés a `nextStop`/`stoptimesForDate`-ből;
- **nyers GPS** (`veh_ping`): ugyanúgy, a térkép idővonalához.

Vasútnál ez elég is: a MÁV saját késésadata pontos és hivatalos.

### 10.2 Teljes regionális feed (később, Volánhoz)

Ha a Volánra is a saját késésmérésünket, mozgásmodellünket és előrejelzésünket akarjuk, a régióról naponta egy szintetikus `Feed` épül a GraphQL-ből:

1. `stopsByBbox(régió)` → megállók;
2. a megállók `routes` mezőjéből a régiót érintő vonalak;
3. vonalanként `patterns { patternGeometry stops }` és `tripsForDate(serviceDate)` → `stoptimes`.

Ez a napi szinkron (03:30-kor, mint a GTFS-ellenőrzés) Redisbe és a `gtfs_feed` mintájára az adatbázisba kerül.

**Nyitott kérdés:** létezik-e nyilvános GTFS-letöltés a `hkir` és a vasúti feedhez. Nem ellenőriztem. Ha van, az jobb forrás a statikus adathoz, mint a GraphQL.

### 10.3 Mit tárolunk statikusan

| Adat | Frissítés | Hol |
|---|---|---|
| Régió megállói, állomásai, vágányai | naponta | `stop` (`feed`, `parent_station`, `platform`, `mode`) |
| Vonalak, színek | naponta | `route` (`feed`, `kind`) |
| Nyomvonalak (`pattern.code` szerint) | naponta, változáskor | Redis, 24 h |
| Napi menetek (könnyű követéshez) | naponta + ha ismeretlen menet jön | memória |

---

## 11. Volán-integráció

**Mit kapunk:** a Búza téri autóbusz-állomás 20 kocsiállása, a régió helyközi vonalai (`37xx`, `13xx`), a városon belüli Volán-megállók (egy részük közös az MVK-éval), élő GPS rendszámmal.

| Hely az appban | Mit mutat |
|---|---|
| **Térkép** | `COACH` ikon a **vonalszámmal** (`3765`); a kártyán járatszám (`3765/651`), cél, rendszám, késés, következő megálló |
| **Megállófigyelő** | MVK-megállónál a Volán-indulások is (az OTP2-tábla úgyis adja, pl. `SP388`-on a `3738`); az autóbusz-állomás **kocsiállással**; „Elérem?” ugyanúgy |
| **Menetrend** | vonal → mai menetek irányonként; megálló → napi indulások (5.7) |
| **Statisztika** | vonalanként pontosság, kocsiállásonként forgalom, késések napszak szerint |
| **Push** | „A 3765-ös Kazincbarcika felé 6 percet késik” |

**Régió-szűrő:** csak a régió bboxában lévő járművek, és a beállításban egy kapcsoló: „Csak a Miskolcot érintő járatok”.

---

## 12. Vasút-integráció

**Mit kapunk:** minden vonat élő GPS-szel, vonatszámmal és névvel, vágánnyal (élőben változik), hivatalos késéssel, **késésokkal**, kocsiösszeállítási megjegyzésekkel, pótlóbusszal, akadálymentességi és kerékpár-adattal (IC-knél).

### 12.1 Állomások, amiket a felhasználó hozzáadhat

Bármelyik `1:` állomás felvehető a megállófigyelőbe. Alapból ajánlott: **Miskolc-Tiszai**, **Miskolc-Gömöri**, **Felsőzsolca**, **Nyékládháza**, **Füzesabony**, Mezőkövesd (azonosítók: 3.4).

### 12.2 Állomástábla

| Oszlop | Forrás |
|---|---|
| Idő, várható idő, késés | `serviceDay + scheduled/realtimeDeparture`, `departureDelay` |
| Vonatszám, nem, név | `tripShortName` (pl. `582` · `InterCity` · `TOKAJ`) |
| Cél | `headsign` |
| **Vágány** | `stop.platformCode`; ha élőben változott, kiemelve |
| **Késés oka** | `alerts`, `entities.Trip.gtfsId` = a menet |
| Megjegyzés | kocsiösszeállítás, „lezárva közlekedik”, pótlóbusz (`alerts`) |
| Ikonok | `wheelchairAccessible`, `bikesAllowed` |
| **„Hol jár most?”** | `vehiclePositions` ahol `trip.gtfsId` = a menet: helyzet, sebesség, következő állomás |

Összevonás: vonatszám + idő + vágány szerint (4.5, 4. pont). Az összekapcsolt vonatok egy sorban: `IC 181 HERNÁD + IC 507`.

### 12.3 A többi helyen

| Hely | Mit mutat |
|---|---|
| **Térkép** | vonat-ikon a vonatszámmal (`IC 582`), a pálya nyomvonala (`tripGeometry`), állomások |
| **Menetrend** | állomás → mai indulások; vonat → megállói valós idővel (5.4) |
| **„Elérem a vonatot?”** | villamos → Tiszai pu. → vonat: a meglévő `transferChance` a villamos mért és a vonat hivatalos késésével |
| **Csatlakozás-figyelő** | „Ha a 1V 4 percet késik, eléred-e a 07:30-as IC-t” |
| **Push** | „A 5139 Füzesabony felé 6 percet késik, 6-os vágány”; vágányváltáskor is |
| **Utazásnapló** | a beszállás GPS-alapú megerősítése a vonat élő pozíciójával (mint a buszoknál) |
| **Kijelző** (`/kijelzo`) | állomástábla módban, pl. a Tiszai pu.-ra |
| **Statisztika** | vonatonkénti pontosság Miskolcon, késésokok megoszlása, tipikus késés naptípus szerint, vágányhasználat |

### 12.4 Csomópont-nézet

A Tiszai pályaudvaron hat MVK-busz-, három villamos-, két Volán- és egy vasúti megálló van (3.4). A felhasználónak ez **egy hely**. Ugyanazon név alatt, 250 méteren belül lévő megállókat egy „csomópont” kártyába vonjuk össze, módonkénti fülekkel: villamos · busz · Volán · vonat.

---

## 13. Beállítások: módonként ki-be

A cél egy univerzális app, de nem mindenkinek kell minden. Van, akinek csak a vonat és a villamos számít, van, akinek csak a regionális busz.

### 13.1 A kapcsolók

Új szakasz a Beállításokban (`SettingsMenu`): **„Közlekedési módok”**.

| Kulcs | Felirat | Alapérték |
|---|---|---|
| `mvk_pref_mode_tram` | Villamos (MVK) | be |
| `mvk_pref_mode_bus` | Városi busz (MVK) | be |
| `mvk_pref_mode_coach` | Helyközi busz (Volán) | **ki** |
| `mvk_pref_mode_rail` | Vonat (MÁV) | **ki** |
| `mvk_pref_coach_region_only` | Csak a Miskolcot érintő Volán-járatok | be |

- **Miért ki alapból a Volán és a vonat:** a mostani felhasználóknál semmi ne változzon, és a térkép ne teljen meg egyszerre 100 új járművel. Az első indításkor egy kártya („Új: vonatok és Volán-buszok. Bekapcsolod?”) egy érintéssel bekapcsolja.
- A minta ugyanaz, mint a `watchPrefs.ts`-ben: `PrefItem` lista, `useToggle`. Új fájl: `apps/web/src/lib/modePrefs.ts`, benne a `useEnabledModes()` hook.
- **Felhős szinkron:** a kulcsok `mvk_` kezdetűek, és nincsenek a `DEVICE_ONLY` listán, ezért a meglévő szinkron (`apps/web/src/lib/sync.ts`) kulcsonként, kétirányúan viszi őket. Semmit nem kell hozzá írni. A kedvencek és a figyelt megállók előtagos azonosítókkal (`1:005511387`) ugyanúgy szinkronizálódnak.

### 13.2 Hol hat

| Hely | Hatás |
|---|---|
| Térkép | a `FilterState.type` (`"all" \| "bus" \| "tram"`) helyett `modes: Mode[]`; a régi érték átfordítása: `all` → az engedélyezett módok |
| Megállófigyelő | a keresés csak engedélyezett módú megállót ad; a táblák szűrve |
| Menetrend | a vonallista szűrve |
| Útvonaltervező | az OTP2 `plan` `transportModes` paramétere |
| Statisztika | csak az engedélyezett módok fülei |
| Push | kikapcsolt módra nem megy értesítés (a meglévő figyelés megmarad, csak szünetel) |
| Szerver | minden új végpont `?modes=tram,bus,coach,rail` paramétert fogad, a WebSocket-feliratkozás is; így nem küldünk le fölösleges adatot |

---

## 14. Új végpontok (worker)

**A v2-végpontok (`/live/*`, `/gtfs/*`, `/stats/*`) örökre csak MVK-adatot adnak, ugyanabban az alakban** (az iOS app ezt olvassa, lásd v3.md). Fallbackben is MVK-adatot adnak, csak az OTP2-ből. Vonat és Volán soha nem kerül bele.

| Végpont | Mit ad |
|---|---|
| `GET /v3/transit/vehicles?modes=&bbox=` | járművek minden módból, egységes alakban |
| `GET /v3/transit/stop/:id/departures?modes=` | megállótábla bármelyik feedből; MVK-megállónál a saját előrejelzésünk + a Volán-indulások |
| `GET /v3/transit/station/:id/board?hours=2` | állomástábla vágánnyal, késésokkal, összevonva |
| `GET /v3/transit/trip/:id` | egy menet: megállók valós idővel, jármű, zavarok |
| `GET /v3/transit/search?q=&modes=` | megálló- és állomáskeresés minden feedben |
| `GET /v3/transit/route/:id/day?date=` | egy vonal napi menetrendje |
| `GET /v3/transit/alerts?modes=` | zavarok magyarul |
| `GET /v3/transit/plan?from=&to=&time=&modes=` | OTP2 `plan` (multimodális, országos), gyorsítótárral |
| `GET /v3/sources` | forrás-egészség: MVK és OTP2 állapota, késés, lefedettség, fallback-idő |
| WS `transit` csatorna | járművek és táblák élőben, módszűrővel |

**Gyorsítótár** (`packages/cache`): megállótábla 20 mp, állomástábla 30 mp, zavarok 2 perc, nyomvonal és katalógus 24 óra, tervező 60 mp (kerekített koordináta + perc szerint). Ugyanarra a táblára érkező párhuzamos kéréseket egy OTP2-kérésbe vonjuk össze.

**Védelem:** IP-nkénti korlát, mint a mostani proxynál (`compat.ts → PROXY_ALLOW`). A böngésző sosem hívja közvetlenül az OTP2-t.

---

## 15. Udvariasság, kockázatok

### 15.1 Mennyit kérdezünk

| Kérés | Gyakoriság | Naponta |
|---|---|---|
| Régió járművei (MVK + Volán + vasút) | 15 mp (fallbackben 10 mp) | ~5 800 |
| MVK-menetek aliasos kötege | 30 mp, **csak fallbackben** | 0 (fallbackben ~2 900) |
| Táblák | igény szerint, 20–30 mp-es gyorsítótárral, összevonva | néhány ezer |
| Zavarok | 2 perc | 720 |
| Statikus szinkron | naponta | néhány tucat |

Összesen nagyjából **8–10 ezer kérés naponta**, gzippel néhány tíz MB. Ennyit egyetlen worker küld, a felhasználók számától függetlenül.

- `User-Agent: mvk-zsombi-modra/3 (+https://mvk.futozs.hu)`, hogy az üzemeltető lássa, ki kérdez.
- Hibánál exponenciális visszalépés (10 → 20 → 40 → 60 mp), ne bombázzuk, ha baja van.

### 15.2 Kockázatok

| Kockázat | Mit teszünk |
|---|---|
| Nincs SLA, bármikor megváltozhat vagy lezárhatják | Az MVK marad a fő forrás; az OTP2 kiesése csak a Volánt és a vasutat érinti, és a felület ezt kiírja. |
| OTP-frissítéskor mezők tűnhetnek el (pl. megjelenik a `planConnection`, a `plan` elavul) | A katalógus minden lekérdezése éjszakánként lefut a hub szondájában (`hub_probe` tábla); `errors` esetén riasztás. A lekérdezések egy fájlban vannak (`otp2Queries.ts`). |
| Az OTP2 MVK-adata régebbi GTFS-en fut | lefedettség-mérés (8.5); fallbackben a hiányzó járművek nem pótolhatók |
| Felhasználási feltételek | A mavplusz.hu ÁSZF-jét nem néztem meg. Indulás előtt érdemes elolvasni, és ha kell, a MÁV-tól engedélyt kérni. |
| A vasúti `trip.gtfsId` napról napra változhat | a statisztika kulcsa a vonatszám (9.1) |

---

## 16. Ütemterv

| Fázis | Tartalom | Kész, ha |
|---|---|---|
| **F0** | OTP2-kliens, lekérdezés-katalógus, rögzített minták, hub-szonda, árnyék-összevetés | a hubban látszik a lefedettség, a késés és a pozíció-eltérés |
| **F1** | `RtFrame` szétválasztás, `SourceManager`, fallback-jelzés a felületen | az MVK-token elvételekor 30 mp-en belül átáll, a térkép és a figyelő megy tovább; visszaadva visszaáll; nincs dupla `veh_ping` |
| **F2** | Mód-kapcsolók, `/v3/transit` alap, `007_transit.sql`, regionális poll | a kapcsolók szinkronizálnak, a v2-végpontok válasza bájtra ugyanaz |
| **F3** | Vasút: állomástábla, keresés, térkép, „Hol jár most?”, push | a Tiszai pu. felvehető, vágány és késésok látszik, a vonat a térképen |
| **F4** | Volán: térkép, megállótábla, autóbusz-állomás, menetrend | a Búza tér kocsiállással, a Volán-járművek a térképen |
| **F5** | Statisztika (vasúti pontosság, késésokok, Volán), tervező-bővítés, kijelző, csomópont-nézet, csatlakozás-figyelő | |
| **F6** (opcionális) | Teljes regionális Volán-feed (10.2), saját késésmérés és mozgásmodell a Volánra | |

Az F1 önmagában is megéri: ma, ha a token lejár, az app élő adat nélkül marad.

---

## 17. Nyitott kérdések

1. Van-e nyilvános GTFS-letöltés a `hkir` és a vasúti feedhez? Ha igen, statikus adatnak azt használjuk.
2. Mekkora legyen a régió? A javasolt doboz (47,75–48,30 É, 20,30–21,10 K) lefedi Füzesabonyt, Mezőkövesdet, Tiszaújvárost és Kazincbarcikát; Ózd (48,22 / 20,29), Sátoraljaújhely és Hidasnémeti kívül esik. Beállítható legyen (`OTP2_BBOX`).
3. Alapból ki vagy be legyen a Volán és a vonat? A javaslat: ki, egy első indításkori kártyával (13.1).
4. Megjelennek-e az MVK törlései az OTP2-ben `CANCELED` állapotként? A mérés idején nem volt törlés, nem tudtam ellenőrizni.
5. Mennyire stabil a vasúti `trip.gtfsId` napok között? Pár nap gyűjtés után kiderül.

---

## Függelék A: az MVK másik két forrása

**1. Az app éles API-ja: `https://mccaze.mvkzrt.hu:8443/api/v1/…`.** Ezt használjuk főforrásként, részletesen: [MVK_API.md](MVK_API.md). Bearer JWT kell hozzá (Androidon Play Integrity, Apple-en App Attest alapján adja ki az MVK); token nélkül 401/403.

**2. Admin- és menetrend-szerver: `https://devgtfsapi.mvkzrt.hu`** (Laravel, „MVK Admin”). A gyökér `/login`-ra visz (csak munkatársaknak). Három nyilvános, kulcs nélküli GET-végpontja van:

| Útvonal | Mit ad |
|---|---|
| `/api/routes/trips` | mind a 61 vonal `[{route_short_name, route_long_name}]` |
| `/api/routes/calander/days` | szolgáltatási napok `[{date}]` (sic: „calander”) |
| `/api/route/{route_short_name}/{direction}/{date}` | egy vonal napi menetrendje |

> **Ne használjuk.** A beillesztett jegyzet szerint fejlesztői gép, bekapcsolt `APP_DEBUG`-gal (a hibák SQL-t és fájlútvonalakat szivárogtatnak), és az `/api/routes/{param}` útvonal az útvonal-szegmenst SQL-oszlopnévként illeszti be. Ezt én nem ellenőriztem, és nem is kell. Érdemes jelezni az MVK-nak. Menetrendhez a GTFS zip és az OTP2 elég.

**Statikus GTFS-tükör:** `http://84.206.68.21:8080/MVK_mobilapp/GTFS/MVK_GTFS.zip` (token nélkül, csak menetrend). Ezt töltjük ma is (`config.gtfsUrl`).

## Függelék B: hogyan lehet mezőt felderíteni introspection nélkül

A szerver a nem létező mezőt név szerint visszautasítja (`FieldUndefined@[alerts/alertId]`), a létezőt elfogadja. Egy mező kipróbálása tehát egyetlen kérés: ha nincs `errors`, a mező létezik. Nem létező azonosítóra (`trip(id: "…")`) `null` jön, hiba nélkül. Így derült ki, hogy a `planConnection`, a `canceledTrips` és az `alertId` hiányzik, az `isEstimated`, a `stoptimesForDate`, a `stoptimesForServiceDate`, a `patternGeometry` és a `tripGeometry` pedig megvan.

## Függelék C: a mérés körülményei

- Időpont: 2026-10-31 05:39–05:50 (CET), szombat hajnal, a reggeli forgalom indulásakor.
- Natív összevetés: `https://mvk.futozs.hu/live/positions` és `/live/arrivals?stop=SP388` (az éles worker, MVK GTFS-RT 2,5 mp-es pollal), ugyanabban a percben.
- Saját GTFS: éles `20261031-1`, a helyi gyorsítótárban `20261028-1` (`data/gtfs-cache/latest.zip`); a menet- és megálló-azonosítókat ehhez is összevetettem.
- Kb. 30 lekérdezés összesen, mindegyik 120–870 ms.
