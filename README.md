# MVK++

**Valós idejű közlekedési app Miskolcra és Borsod-Abaúj-Zemplénre.** Az összes MVK-busz és -villamos, a Volán-buszok és a vonatok élőben a térképen. Mellette másodpercre pontos megállófigyelő, saját késés- és rendszám-előrejelzés, útvonaltervező átszállási eséllyel, utazásnapló, és a teljes hálózatról gyűjtött statisztika, hónapokra visszamenőleg. Telefonra telepíthető webapp, push-értesítésekkel és jelszó nélküli fiókkal.

> Nem hivatalos projekt, az MVK Zrt.-hez és a MÁV-csoporthoz nem kapcsolódik. Az adatok az MVK és a MÁV+ nyilvános utastájékoztató forrásaiból jönnek.

**Tartalom:**
[Forgalmi térkép](#forgalmi-térkép) ·
[Megállófigyelő](#megállófigyelő) ·
[Menetrend](#menetrend) ·
[Útvonaltervező](#útvonaltervező) ·
[Felszálltam és Utazásaim](#felszálltam-és-utazásaim) ·
[Parkoló](#parkoló) ·
[Statisztika](#statisztika) ·
[Kijelző](#kijelző) ·
[Értesítések](#értesítések) ·
[Fiók és szinkron](#fiók-és-szinkron) ·
[Volán és vasút](#volán-és-vasút) ·
[Telepíthető app](#telepíthető-app) ·
[A háttérben](#a-háttérben) ·
[Üzemeltetés](#üzemeltetői-vezérlőpult) ·
[Technológia](#technológia)

---

## Forgalmi térkép

A nyitóképernyő: minden kint lévő jármű a térképen, élőben, a vonal színével és számával.

### Folyamatos, sosem visszaugró mozgás

A járművek nem ugrálnak GPS-jelről GPS-jelre, hanem folyamatosan haladnak az útvonalukon. Két jel között egy, a valós menetekből tanított modell becsli, hol jár a busz. A jelző **soha nem ugrik vissza**. Ha a becslés előreszaladna, például egy megállóban vagy egy piros lámpánál, a jelző lassít és megvárja a valódi buszt. Az egyenes szakaszokon a jelző és a busz együtt fordul ki a sarkon.

### Jármű kiválasztása és követése

Egy járműre koppintva megnyílik a kártyája:

- vonal, irány, rendszám (vonatnál vonatszám, Volánnál a rendszám),
- mennyit késik vagy siet, milyen gyorsan megy, és hol jár éppen,
- a menet hátralévő megállói menetrendi és várható idővel; a már elhagyottak halványan, a következő kiemelve, fölötte egy sáv mutatja, hol tart a menet,
- vonatnál vágány, kocsiállás, és a MÁV megjegyzései, például a késés oka.

**Követés** módban a térkép a járművet a képernyő látható részének közepén tartja. Ha elhúzod a térképet, a követés szünetel, egy gombbal folytatható. Telefonon a kártya alul, asztali gépen jobb oldalt, teljes magasságban jelenik meg.

### 3D nézet

Egy gombbal 3D-s városnézetre vált: domborzat, épületek, és követéskor üldözőkamera, amely a jármű mögül, annak haladási irányában néz előre. A választás eszközönként megmarad.

### Alaptérképek és rétegek

| Alaptérkép | Réteg |
|---|---|
| Utcatérkép · Halvány · Sötét · Műhold · Domborzat | **Forgalom (dugók)**: a most torlódott szakaszok, félpercenként frissítve, a buszok tényleges menetidejéből. A szakaszra koppintva látszik, mennyire lassú, és miből tudjuk. |
| | **Megállók**, vagy **csak a figyelt megállók** |
| | **Járatok nyomvonala** a kiválasztott vonalakra |
| | **Rendszám** felirat a járműveken |
| | **Többi busz követéskor**: utazás közben halványan a többi jármű is látszik |

### Keresés és szűrés

- **Keresés** megállóra (az MVK-megálló a táblán látható kódjával), MVK-buszra a rendszám számjegyeire, Volán-buszra a teljes rendszámra, vonatra a vonatszámra.
- **Szűrők**: vonal, kiemelt rendszámok (legfeljebb 12), járműtípus (busz, villamos, Volán, vonat), Volán-üzem, vasúti kategória, késés (pontos / 5+ perc késés), mozgás (mozgó / álló), távolság tőled (500 m / 1,5 km / 5 km). A panel alján a szűrésnek megfelelő járművek listája.

### Idővonal: bármelyik múltbeli nap visszajátszása

Az idővonalon kiválasztasz egy napot, és a csúszkával vagy a lejátszás gombbal végignézed, ki hol járt aznap, percről percre. A nyers GPS-adat nem törlődik, így ez hónapokkal később is működik. A szűrők az idővonalon is érvényesek.

### MVK-hírek

A térkép sarkában lévő gombbal megnyílnak az MVK hírei: terelések, menetrend-változások, pótlóbuszok. A cikkben említett vonalak („34-es”, „1-es villamos”) kattintható csempék, és egy koppintással csak azt a vonalat mutatják a térképen. Az új hírek jelölést kapnak; hogy melyiket olvastad már, az eszközeid között szinkronizálódik.

### A fejlécben

- **Élő állapot**: kapcsolódva vagy, és milyen friss a legutóbbi járműadat. Ha az adat elavul, a fejléc jelzi.
- **Időjárás** Miskolcon: hőmérséklet, égkép, hőérzet és szél.

---

## Megállófigyelő

A kiválasztott megállók indulásai kártyákon. Telefonon lapozható, asztali gépen egymás mellett. Minden változás azonnal megjelenik, frissítés nélkül: a busz beért, elindult, nőtt a késése, kihúzták a menetet.

### Mit mutat egy indulás

- **Visszaszámlálás** és a menetrendi idő.
- **Késés** színnel és számmal: a mért késés, ha a busz már úton van.
- **Hol jár most**: egy sáv mutatja, hány megállóra van, és hol tart. Erre koppintva a térkép rááll a buszra és követi.
- **Melyik busz jön**: az élő rendszám. Ha a menet még el sem indult, a **várható rendszám** `~` jellel, szaggatott keretben. Ahol a busz a végállomáson visszafordul, ott `~` nélkül, mert azt már biztosan tudjuk.
- **Kihúzott menet**: ha az MVK törölte a menetet, áthúzva látszik, mellette pedig az, hogy mikor jön helyette a következő ugyanazzal a vonallal.

### Előrejelzések a sorokban

- **Késés-előrejelzés megállónként**: „ide várhatóan +3 perccel ér, legrosszabb esetben +5”. A becslés a busz mostani késéséből és az elmúlt 8 hét szakaszidejeiből készül.
- **Elérem?**: a helyzetedből kiszámolja, mennyi a séta a megállóig, és minden indulásra kimondja a verdiktet: *ráérsz*, *indulj most*, *fuss*, vagy *lekésed*. A **Szólj** gombbal push-értesítést kapsz, amikor el kell indulnod, a sétaidővel együtt számolva.
- **Indulási idők**: minden indulás mellett az az időpont, amikorra el kell indulnod hozzá.
- **Késve indulás**: ha a menet busza még az előző menetén késik, előre szól, hogy ez a menet is csúszni fog, még mielőtt az MVK kihúzná.
- **Dugó a busz előtt**: ha az ide tartó busz előtt beállt a forgalom, mennyi pluszidőt hoz.

### A következő busz doboza

A kártya tetején a legközelebbi indulás kiemelve: melyik jármű, milyen gyorsan megy, hol jár most, és egy gomb a térképes követéshez.

### Nemcsak megálló

A figyelőre háromféle kártya tehető:

- **Megálló**: az összes vonal indulásai.
- **Viszonylat** (A → B): csak azok a menetek, amelyek mindkét helyen megállnak, például Miskolc-Tiszai → Füzesabony. Mutatja az indulást vágánnyal és késéssel, az érkezést, a menetidőt és a MÁV megjegyzéseit.
- **Vonatszám**: egy adott vonat minden nap, például az 5139-es. A mai példányt mutatja, vagy ha az már elment, a holnapit: hol jár, mennyit késik és miért, a hátralévő megállók vágánnyal.

### Szokásos utad

Az utazásnaplóból felismeri a rendszeres útjaidat: ugyanaz a vonal, ugyanaz a megálló, hasonló időpont, a hét napjaira is figyelve („minden munkanap”, „szerdánként és csütörtökönként”). A szokásos idő előtt másfél órával megjelenik a figyelő tetején a mai legközelebbi indulással.

### Megállónkénti értesítések

- **Érkezik a busz**: push-értesítés, ennyi perccel az érkezés előtt.
- **Dugóriasztás**: ha az ide tartó busz előtt beáll a forgalom, értesítést kapsz a várható pluszidővel.

### Minden ki-be kapcsolható

A Beállításokban a figyelő minden funkciója külön kapcsolható, és a választás minden eszközödre átmegy:

| Kapcsoló | Mit csinál |
|---|---|
| Elérem? — indulj most | a helyzetedből mikor indulj, és a Szólj gomb |
| Indulási idők a sorokban | minden indulás mellett, mikor kell elindulnod |
| Késve indulás előrejelzése | ha a busz még az előző menetén késik |
| Dugó a busz előtt | a beállt forgalom miatti pluszidő |
| „Legrosszabb esetben” becslés | a várható legnagyobb késés a megállónál |
| Rendszám-előrejelzés | a várható rendszám, mielőtt a busz élőben megjelenne |
| Kihúzott menet helyett | mikor jön a törölt menet helyett a következő |
| A következő busz doboza | jármű, sebesség, hol jár, követés |
| „Szokásos utad” kártya | a rendszeres út a figyelő tetején |
| Számlálók a füleken | a fülek jelvényei (pl. élő kimaradó menetek) |

---

## Menetrend

- Vonal, irány és nap szerint a teljes menetrend, a betűjelek magyarázatával. Kereshető vonalra és végállomásra. Mód szerint szűrhető (MVK, Volán, vasút), és a választás szinkronizálódik.
- **A menet tényleges futása**: egy menetre koppintva megállónként látszik a menetrendi és a ténylegesen mért idő, és hogy hol mennyit késett. Ma élőben, múltbeli napon a naplóból. Ha a jármű a végállomás előtt elnémult, a beérkezés becsült, és ezt jelzi is.
- **Kihúzott menetek** megjelölve: „Az MVK kihúzta ezt a menetet, ezen a napon nem közlekedett.”
- **Egy menet figyelése**: egyszeri értesítés egy kiválasztott menetre, ennyi perccel az indulása előtt, csak arra a napra.
- **Mai zavarok**: egy helyen a nap összes kiesése. Benne vannak a hivatalos MVK-törlések, a valószínűleg kimaradó menetek, és a hamarosan induló menetek, amelyeknek a busza még az előző menetén késik, ezért késve indulhatnak. A közeledben lévők elöl, a kieső menetek óránként is.

---

## Útvonaltervező

Saját, RAPTOR-algoritmusra épülő tervező, amely élő késésekkel számol.

- **Honnan, hová**: megálló név szerint, ékezet nélkül is kereshető; az irány egy gombbal megfordítható.
- **Mikor**: indulási vagy érkezési idő és nap. Az „érkezzek X-ig” tervnél figyel arra is, hogy a várható csúszás még beleférjen.
- **Mivel**: az MVK mindig benne van, a Volán és a vonat bepipálható. Ha nincs találat, javasolja, mit érdemes még bepipálni.
- **Az eredmény** függőleges idővonalon: járatszakaszok, gyaloglás, átszállások, megállók. Minden szakasznál a várható késés. Élő tervnél az eredmény a háttérben csendben frissül.
- **Átszállási esély**: a valós késésadatokból kiszámolja, mekkora eséllyel éred el a csatlakozást.
- **Figyeld az átszállást**: ha útközben elszáll az esély, mert az első busz késik vagy a csatlakozás korábban megy, push-értesítés jön a következő lehetőséggel.

### Három időpont, háromféle válasz

| Időpont | Mit kapsz |
|---|---|
| **Most** | ahol a jármű már úton van, az élő késésével számol |
| **Jövő** | a várható késést a korábbi, azonos napszakos mérésekből becsüli |
| **Múlt** | a járművek mért adataiból megmutatja, **mi történt valójában**: melyik busz futott, mikor indult és érkezett, elérted volna-e a csatlakozást |

### Igazolás

Múltbeli útnál egy gombbal másolható összefoglaló készül: nap, útvonal, menetrend szerint és valójában, a járművek rendszáma. Bemutatható például a munkahelyen vagy az iskolában, ha a busz miatt késtél. Ha egy útról nincs mérés, ezt kimondja, és nem állít mást.

---

## Felszálltam és Utazásaim

Utazásnapló, amely nagyrészt magától vezeti magát.

### Felszállás

- Egy követett buszra a **Felszálltam** gombbal.
- Vagy automatikusan: ha a térkép nyitva van és a helymeghatározás be van kapcsolva, az app felismeri, hogy együtt mozogsz egy busszal, és megkérdezi: *„Éppen erre a buszra szálltál fel?”*
- Felszálláskor mindig te mondod meg: **hol szálltál fel**, **hol szállsz le**, és fordulóhurkos végállomásnál, hogy **körbeutazol-e**. Az app nem találgat (a megállólistában csak az látszik, hol jár most a busz). Utazás közben bármikor átírható.

### Utazás közben

- A térkép a buszt követi, a többi jármű halványan látszik.
- Minden további megállóra élő késés, várható és legkésőbbi érkezés.
- A busz jelzője a **telefonod GPS-ét** követi, így pontosabb, mint a busz saját jelzése.
- Látod, ha dugó van előtted, és mennyit hoz.
- A kijelölt leszállóhelynél az utazás **magától lezárul** — akkor is, ha a telefon a zsebedben van, és csak később nyitod meg.
- **Leszálltam** / **Korábban**: ha előbb szálltál le, a már elhagyott megállók közül választhatsz. Ha a telefon percek óta messze van a busztól, az app csak megkérdezi, leszálltál-e — magától nem zárja le.

### Ha bezárod az appot

A webapp a háttérben nem tud követni, ezért amikor újra megnyitod, a menet adataiból zárja le az utat a választott megállónál (körbeutazásnál a következő menet megadott megállójánál), a busz tényleges idejével és késésével.

### Körbeutazás

Hurok-végállomásokon a busz megfordul és ugyanaz a jármű viszi tovább a következő menetet. A körbeutazást **előre jelzed** (*„Körbeutazok”*), és megadod, hol szállsz le a következő menetből: a végállomáson az app megmutatja, mikor indul tovább a busz, és indulásakor magától folytatja az utazást — a telefon helyétől függetlenül, zsebre tett, lezárt telefonnal is.

- Ha az utazás a végállomáson ért véget, ott egy **Körbeutazok** gomb élőben folytatja a busz következő menetével.
- Az Utazásaim listájában bármelyik fordulóhurkos vonalon tett út utólag is **meghosszabbítható körbeutazásként** — ha rosszul zárult le (nem a végállomáson), az is odáig egészül ki.

### Utólag felvett és javított utak

- **Utazás hozzáadása** a menetrendből, ha az app nem látta: nap → vonal → indulás → fel- és leszállás. Ha a rendszer nem látta a buszt, a rendszám beírható. A végállomásról tovább utazás is felvehető. A késést utólag is kiszámolja a busz mért idejeiből (ahol a fel- vagy leszállás megállójában nem volt mérés, a legközelebbi mért megállóéból); a régebbi utaknál a hiányzó késést magától pótolja.
- **Javítás**: egy lezárt utazásnál utólag kijavítható, hol szálltál fel és le. A választáskor a megállók mellett a busz tényleges ideje látszik, hogy könnyebb legyen felidézni.

### Összesítés

A Figyelő **Utaim** fülén:

- **Késés miatt a buszon, pluszban**: életed során mennyivel ültél tovább a buszon a menetrendnél (az utak végén mennyivel nagyobb volt a késés, mint felszálláskor), és mennyit vártál a megállóban a késő buszra.
- Utazások, megtett km, utazási idő, pontosság (±1 percen belül jött-e a busz), begyűjtött rendszámok és **megállók**.
- Hol szállsz fel és le a legtöbbször, leggyakoribb útjaid, mikor utazol (óra és nap szerint), kedvenc vonalaid átlagos késéssel, rekordjaid.
- Minden utazásnál látszik a késés (és ha az út közben nőtt, mennyivel); körbeutazások egy sorban.

Az utazások a telefonon gyűlnek, bejelentkezve a felhőbe is mentődnek.

---

## Parkoló

Ki hol áll most, és mi lesz vele.

- **A flotta most** négy nagy számban és egy arányos sávon: bevetésen, végállomáson parkol, kocsiszínben, jel nélkül.
- **Végállomások**: ki áll ott, mióta, és mikor indul legközelebb. A szaggatott keret előrejelzést jelent, a teli keret azt, hogy az MVK már kiadta neki a menetet. Rendezhető kiállás szerint, aszerint, ki áll legrégebben, vagy hol állnak a legtöbben.
- **Kocsiszín**: az ott álló járművek aszerint csoportosítva, hogyan kerültek oda: beállt menettel érkezett, egy órája néma, vagy ma még nem volt kint.
- **Elnémult járművek**: menet közben eltűnt jelű buszok; egy borostyán sáv mutatja, mennyi idő van még az egyórás határig, amely után kocsiszínbe soroljuk.
- **Jármű-lap**: most hol van, késés, GPS-állapot, utolsó menet, hogyan került ide, és 14 napos kiállási előzmény.
- **Forda-tábla**: a teljes flotta napja egy idővonalon, vonalanként csoportosítva. Benne vannak a lefutott menetek, és hogy ki melyik menetet viszi még ma.
- Busz és villamos egyaránt; a Volán-buszok és vonatok a megyei állomásokon bekapcsolhatók. A **kedvenc parkolók** elöl állnak, és szinkronizálódnak.

---

## Statisztika

Minden busz minden megállójáról gyűjtött mérésekből, hónapokra visszamenőleg.

| Nézet | Mit mutat |
|---|---|
| **Áttekintés** | a mai gyűjtés: nyers GPS-pontok, megálló-események, menetek, szakaszmérések, a feed elérhetősége, csúcs-járműszám; az előrejelző modellek pontossága |
| **Hálózat** | mikor és hol késnek a járatok, naptípus szerint (munkanap, szombat, vasárnap/ünnep); óránkénti késés, reggeli és esti csúcs, a leglassabb szakaszok |
| **Vonalak** | 7 / 30 / 90 napra: átlagos késés, menetrendtartás, kiesett menetek, torlódás; napi grafikonok a késésről, a menetrendtartásról és a teljesített/kiesett menetekről |
| **Megállók** | átlagos késés, menetrendtartás, átlagos állásidő, legforgalmasabb óra; óránkénti érkezések, késés és pontosság; kedvenc megállók csillaggal |
| **Járművek** | egy jármű bármelyik napja: megtett út, üzemidő, csúcssebesség, átlagos késés, a napi nyomvonal térképen, a nap menetei idővonalon és részletesen, milyen vonalakon jár, üzemzavar-előélet; léptetés a közlekedési napjai között |
| **Hőtérkép** | **Vonal**: a vonal megállói × a nap órái. „Késés” módban mennyit késik ott a busz, „Hol szedi fel” módban mennyit nőtt a késés az előző megállóhoz képest, vagyis melyik szakasz a bűnös. **Város**: a teljes hálózat összes megállóköze a térképen, a vonalvastagság a forgalomhoz igazodik, a nap óráról órára lejátszható. |
| **Üzemzavarok** | két, élesen elválasztott forrás: a **hivatalos** MVK-törlések és az **észlelt** zavarok (menet közben 30+ percre elnémult jármű, nem ismert térerő-hiányos szakaszon), bizonyítékkal és megbízhatósággal; mellette élőben a most valószínűleg kimaradó menetek |
| **Vasút és Volán** | pontosság a megyében: megállónkénti érkezések, vonatonként a végállomáson mért késés, a MÁV által közölt késésokok, vágány- és kocsiállás-változások |

### Az előrejelzések elszámoltatása

Az app nem csak jósol, a tippjeit vissza is méri, és az eredményt nyilvánosan megmutatja:

- **Rendszám-előrejelzés**: napi találati arány, és bizonyosság-sávonként a tényleges találat („a 80%-os tippnek kb. 80%-ban kell bejönnie”), vonalanként, napszak szerint, menetenként, és hogy melyik jelzés mennyire pontos.
- **Késés-előrejelzés**: melyik becslés fut éppen (a tanított modell vagy a képlet), és a legutóbbi tanítás visszamérése a modell által sosem látott tesztnapokon.

---

## Kijelző

A `/kijelzo` oldal utastájékoztató tévére vagy tabletre: irodába, aulába, kollégiumba, üzletbe.

- 1–3 megálló egymás mellett (álló képernyőn egymás alatt), teljes képernyőn, élőben.
- Minden oszlop tetején kiemelve a következő busz: hol jár, melyik jármű jön. Alatta a többi indulás késéssel, vasútnál vágánnyal, a változást kiemelve.
- A betűméret a képernyőhöz igazodik, messziről is olvasható.
- A megállók a címben (`/kijelzo?m=SP1,SP2`) is megadhatók, így a kijelző újraindítás után is ugyanazt mutatja. A Figyelőből egy gombbal indítható.

---

## Értesítések

Push-értesítés zárt telefonra is, kattintásra az app a megfelelő megállónál nyílik meg.

| Értesítés | Mikor jön |
|---|---|
| **Érkezik a busz** | a figyelt megállóba ennyi perccel az érkezés előtt; ha a busz késve indul, előre szól |
| **Indulj most** | az Elérem? alapján, amikor a sétaidővel együtt el kell indulnod |
| **Dugó** | ha a megálló felé tartó busz előtt beállt a forgalom |
| **Átszállás** | ha a tervezett csatlakozás veszélybe kerül, a következő lehetőséggel |
| **Egy menet** | egy kiválasztott menetre, ennyi perccel az indulása előtt |

- **Ne zavarj időszak**: kezdő és záró időponttal.
- **Kézbesítési napló**: az eszköz legutóbbi értesítései, mi ment ki, mi nem, és miért.
- Ha az értesítés nem kérhető, az app elmondja, miért: a böngésző letiltotta, vagy iPhone-on csak a kezdőképernyőre tett app kaphat értesítést.

---

## Fiók és szinkron

- Belépés **passkey-vel** (ujjlenyomat, arc, eszköz-PIN), jelszó nélkül. Több passkey is hozzáadható egy fiókhoz.
- Fiók nélkül is minden működik, az adatok ilyenkor az eszközön maradnak.
- Bejelentkezve minden beállítás, kedvenc, figyelt megálló és utazás **kétirányú szinkronnal** megy az eszközeid között. A másik eszközön tett változás azonnal megérkezik, és egy sáv jelzi, hogy egy kattintással betölthető.
- A felhőben lévő állapot egy gombbal visszaállítható. Kijelentkezéskor a felhőben mentett adat megmarad.

---

## Volán és vasút

A MÁV+ adataiból Borsod-Abaúj-Zemplén Volánbusz-járatai és vonatai is benne vannak, ugyanazokon a felületeken, mint az MVK:

- **Térkép**: Volán-buszok rendszámmal, vonatok vonatszámmal; szűrés üzemre és vasúti kategóriára.
- **Figyelő**: vasútállomás vágánnyal, autóbusz-állomás kocsiállással, élőben (a változás kiemelve). Mellette a MÁV megjegyzései: késés oka, kocsiösszeállítás, pótlóbusz. Viszonylat- és vonatszám-kártyák.
- **Menetrend, tervező, utazásnapló, statisztika, push**: minden ugyanúgy, mint az MVK-nál.
- Első induláskor egy rövid bemutató kérdezi meg, kell-e. A Volán és a vasút módonként kikapcsolható, és ez minden eszközre átmegy.

---

## Telepíthető app

- A kezdőképernyőre tehető, és saját ablakban, böngészősáv nélkül fut. Az app felajánlja a telepítést.
- Az app váza és a már látott térképcsempék gyorsítótárban maradnak, így gyenge térerőn is gyorsan indul.
- Az értesítésekből és a megosztott hivatkozásokból (`/?stop=SP12`) közvetlenül a megfelelő megállóhoz nyílik.
- Telefonra tervezve, 44 px-es, ujjal biztosan eltalálható vezérlőkkel; asztali gépen több oszlopban.

---

## A háttérben

### Folyamatos menet-illesztés

Minden GPS-jelet a menetrendhez illeszt: melyik jármű melyik menetet viszi, mikor ért be és mikor indult el az egyes megállókból. Az indulás a végállomás elhagyásakor azonnal kiderül, a menet a végállomásra érve azonnal lezárul. Ha a busz a végállomás előtt elnémul, a beérkezést becsüli, de ezt a statisztikából kizárja.

### Rendszám-előrejelzés

Minden kint lévő buszra, órákra előre: a forda-tervből és a korábbi napokon tanult láncokból, önjavító súlyokkal. Hurok-végállomásokon, rövid fordulóidővel 60 nap adatán 99,4%-ban ugyanaz a busz viszi a következő menetet, ezért ott biztosként mutatja.

### Saját tanított modellek

A késés- és a mozgásbecslés saját gradient boosting modellekkel készül. Ezek minden éjjel újratanulnak a friss adatokon. Egy modell csak akkor kerül élesbe, ha a sosem látott tesztnapokon jobban teljesít, mint a képletes becslés, mégpedig napszakonként és előretekintési távolságonként külön mérve. Ahol nem jobb, ott a képlet marad.

- A késésmodell átlagos hibája 18%-kal kisebb a képletesnél. A „legrosszabb esetben” felső becslés kb. 85%-ban tart.
- A mozgásmodell nem az átlagos hibát minimalizálja, hanem azt, ami a képernyőn zavaró: mennyi ideig látszik rossz helyen a jármű. Ezért inkább kivár, mint hogy előreszaladjon.

### Önvédő adatbetöltés

- Minden letöltött menetrendet ellenőriz. Ha az MVK üres vagy csonka menetrendet ad ki, a régi marad érvényben. Ha egy napra nincs menetrend, a legutóbbi jó menetrend leghasonlóbb naptípusú napját használja.
- Ha az MVK élő adata kiesik, a járművek a MÁV+ forrásából jönnek tovább, és a helyreállás után visszavált.
- Üzemzavar csak lezárt napra és bizonyítékkal kerül a statisztikába; az ismert térerő-hiányos szakaszokon elnémuló buszokat kiszűri.

---

## Üzemeltetői vezérlőpult

Egy külön, csak a belső hálózatról elérhető vezérlőpult az egész rendszerhez:

- **Áttekintés** egy mondatban és riasztásokkal (adatforrás, konténerek, lemez, mentés, elérhetőség).
- **Szolgáltatások**: konténerenként CPU, memória, hálózat, lemez; újraindítás, leállítás, indítás.
- **Válaszidők**: kívülről mért elérhetőség, belülről útvonalanként p50 / p95 / p99 és hibaarány.
- **Élő naplók** szintre és szövegre szűrve, letölthetően.
- **Adatforrások**: az MVK forrása most (natív vagy MÁV+ tartalék), átváltások, menetrend-verziók, újratöltés.
- **Feladatok**: ütemezett feladatok, a tanított modellek és az előrejelző állapota; bármelyik feladat azonnal indítható.
- **Használat**: aktív eszközök napi, heti és havi bontásban, platform, telepített app aránya, és a legnépszerűbb vonalak, megállók, járművek.
- **Mentés és visszaállítás** egy gombbal, és naponta automatikusan.

---

## Technológia

| Réteg | Mi |
|---|---|
| Felület | Next.js 16, React 19, Tailwind, Leaflet (2D térkép), MapLibre GL (3D) |
| Élő motor | Node + TypeScript worker: adatgyűjtés 2,5 mp-enként, menet-illesztés, WebSocket-hub, push-sor (pg-boss), RAPTOR-tervező, saját GBDT-modellek |
| Adat | PostgreSQL 17 + TimescaleDB + PostGIS; kétszintű gyorsítótár (memória + Redis) |
| Fiók, értesítés | WebAuthn passkey, Web Push |
| Üzem | Docker Compose, Caddy (HTTPS), Bun workspace monorepo |
