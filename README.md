# MVK++

**Valós idejű közlekedési app Miskolcra.** Minden busz és villamos élőben a térképen, másodpercre pontos megállófigyelő, késés-előrejelzés, útvonaltervező, utazásnapló és részletes statisztika a teljes hálózatról. Telefonra telepíthető webapp (PWA), push-értesítésekkel.

> Nem hivatalos projekt, az MVK Zrt.-hez nem kapcsolódik. Az adatok az MVK és a MÁV+ nyilvános utastájékoztató forrásaiból jönnek.

---

## Mire képes

### Forgalmi térkép

- Az összes kint lévő jármű élőben, **folyamatos mozgással**: a jelző nem ugrál a GPS-pontok között, és soha nem ugrik vissza. Egy tanított modell becsli, hol jár a busz két jel között, és megállóknál, kereszteződésekben inkább kivár, mint hogy előreszaladjon.
- Egy járműre koppintva: vonal, rendszám, késés, a menet hátralévő megállói várható időkkel, és a következő menete.
- **Követés** módban a kamera a busszal megy; **3D nézetben** domborzattal, épületekkel, a jármű mögül.
- **Idővonal**: bármelyik múltbeli nap visszajátszható, percről percre. A nyers GPS-adat nem törlődik, így hónapokkal később is visszanézhető, ki hol járt.
- Forgalomszínezés a vonalakon (hol lassú most a haladás), szűrés vonalra, járműtípusra, késésre és a közeledben lévőkre, MVK-hírek a térképről elérve, a hírben említett vonalak egy koppintással kiszűrve.

### Megállófigyelő

- Több megálló egyszerre, kártyákon. A változás azonnal megérkezik (WebSocket): beért, elindult, nőtt a késés.
- Minden érkezésnél: hol jár most a busz, mennyit késik vagy siet, és **melyik rendszámú jármű jön** — akkor is, ha a menet még el sem indult.
- **Késés-előrejelzés megállónként**: „ide várhatóan +3 perccel ér, legrosszabb esetben +5”.
- **Elérem?** — a gyaloglási időd alapján megmondja, eléred-e, és szól, mikor indulj.
- **Késve indulás**: ha a busz még az előző menetén van, előre jelzi, hogy ez a menet csúszni fog.
- **Szokásos utad**: az utazásnaplóból felismeri a rendszeres útjaidat, és a megfelelő időben elöl mutatja őket.
- A vasútállomásokon vágány, vonatszám és viszonylat.

### Menetrend

- Vonalankénti és megállónkénti menetrend, mellette a **ténylegesen lezajlott** indulások és érkezések naplója — megállónként, másodpercre.
- Egy menet kiválasztva: hol tart most, és melyik megállónál mennyit késett.
- **Mai zavarok**: kimaradt menetek, hivatalos MVK-törlések és észlelt üzemzavarok egy helyen, a közeledben lévők elöl.

### Útvonaltervező

- Gyors, saját RAPTOR-alapú tervező, élő késésekkel számolva.
- **Átszállási esély**: a valós késésadatokból kiszámolja, mekkora eséllyel éred el a csatlakozást; az átszállás figyelhető, és szól, ha veszélybe kerül.
- **Múltbeli tervezés**: egy korábbi napra azt mutatja, ami ténylegesen történt, nem azt, ami a menetrendben állt.
- Volán és vasút is bevonható, módonként ki-be kapcsolható.

### Felszálltam / Utazásaim

- A követett buszra „Felszálltam”, vagy az app magától felismeri a GPS-ből, hogy együtt mozogsz egy busszal.
- Utazás közben élő késés, várható és legkésőbbi érkezés minden további megállóra; a busz a telefonod helyzetét követi, és látod, van-e előtted dugó.
- **Körbeutazás** a hurok-végállomásokon: ha a busz tovább megy, az utazás folytatódik.
- Utólag is felvehető egy utazás a menetrendből, ha az app nem látta.
- Összesítés: megtett km, utazási idő, begyűjtött rendszámok, vonalak.

### Parkoló

- Ki áll most melyik végállomáson, ki van a kocsiszínben, és mikor indul legközelebb — buszra és villamosra.
- **Forda-tábla**: a teljes flotta napja egy idővonalon — a lefutott menetek, és hogy ki melyik menetet viszi még ma.
- 14 napos kiállási előzmény járművenként.

### Statisztika

- **Hálózat**: csúcsidők, lassú szakaszok, pontosság napszakonként.
- **Vonalak, megállók, járművek**: késés-eloszlás, menetidők, járművenként a futott km és a vonalak.
- **Hőtérkép**: a város és az egyes vonalak szakaszonként, hol mennyit lassul a forgalom.
- **Üzemzavarok** bizonyítékokkal, csak lezárt napokra — nincsenek „kamu” zavarok.
- Az előrejelző modellek mért pontossága nyilvánosan látható.

### Kijelző

A `/kijelzo` oldal utastájékoztató tévére vagy tabletre: 1–3 megálló egymás mellett, nagy betűkkel, élőben — irodába, aulába, kollégiumba.

### Értesítések és fiók

- Push-értesítés, ha közeledik a busz, ha késik, ha dugó van az útvonalán, vagy ha indulnod kell — kézbesítési naplóval.
- Fiók **passkey-vel** (jelszó nélkül); a kedvencek, beállítások és utazások azonnal szinkronizálnak az eszközeid között.

### Volán és vasút

Borsod-Abaúj-Zemplén Volánbusz-járatai és vonatai a MÁV+ adataiból: térkép, figyelő, menetrend, tervező, utazásnapló, statisztika, push.

---

## Ami a háttérben dolgozik

- **Folyamatos menet-illesztés**: minden GPS-jelet a menetrendhez illeszt, így tudható, melyik jármű melyik menetet viszi, mikor ért be és indult el egy megállóból.
- **Rendszám-előrejelzés** órákra előre, forda-tervből és tanult láncokból; hurok-végállomásokon gyakorlatilag biztos (60 nap adatán 99,4%).
- **Saját gradient boosting modellek** a késés- és a mozgásbecsléshez. Minden éjjel újratanulnak, és egy modell csak akkor kerül élesbe, ha a visszatartott napokon jobban teljesít, mint a képletes becslés. A késésmodell átlagos hibája így 18%-kal kisebb, a felső becslés kb. 85%-ban tart.
- **Önvédő adatbetöltés**: ha az MVK hibás vagy üres menetrendet ad ki, az app az utolsó jót használja; ha az MVK élő adata kiesik, a MÁV+ forrására vált át.

---

## Technológia

TypeScript monorepo (Bun workspace) · Next.js 16 + React 19 · Leaflet és MapLibre GL · Node worker WebSocket-hubbal · PostgreSQL 17 + TimescaleDB + PostGIS · Redis-gyorsítótár · pg-boss · Web Push · WebAuthn passkey · Docker Compose + Caddy
