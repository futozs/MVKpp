-- ═══════════════════════════════════════════════════════════════════════
-- MVK Menetadat-raktár — séma
--
-- Három réteg:
--   L0  veh_ping                              nyers GPS, 14 nap
--   L1  trip_run / stop_event / segment_run   levezetett tények, örökre
--   L2  agg_*                                 aggregátumok, minden UI innen olvas
--
-- Alapelvek:
--   · a ténytáblákban NINCS szöveges kulcs — InnoDB minden másodlagos indexbe
--     bemásolja az elsődlegest, egy VARCHAR kulcs megháromszorozná az indexeket
--   · a koordináták fok × 1e7 egészként (fele hely, mint DOUBLE, ~1 cm pontos)
--   · minden idő valódi UTC unix — a feed helyi idejét beérkezéskor korrigáljuk
--   · minden elsődleges kulcs tartalmazza a particionáló oszlopot (MySQL-előírás)
--   · particionált táblán nincs idegen kulcs — az integritást az app tartja
-- ═══════════════════════════════════════════════════════════════════════

-- ── DIMENZIÓK ──────────────────────────────────────────────────────────
-- Kicsik, stabilak, nem particionáltak. A GTFS-azonosítók itt ATTRIBÚTUMOK,
-- nem kulcsok, mert a feed 16 naponta rotál és átszámozhat.

CREATE TABLE IF NOT EXISTS dim_vehicle (
  vehicle_key  SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  vehicle_id   VARCHAR(16)  NOT NULL,
  kind         VARCHAR(8)   NOT NULL DEFAULT 'UNKNOWN',
  first_seen   DATETIME     NOT NULL,
  last_seen    DATETIME     NOT NULL,
  PRIMARY KEY (vehicle_key),
  UNIQUE KEY uq_vid (vehicle_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dim_route (
  route_key    SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  route_short  VARCHAR(16)  NOT NULL,
  gtfs_route_id VARCHAR(16) NULL,
  long_name    VARCHAR(128) NULL,
  kind         VARCHAR(8)   NOT NULL DEFAULT 'BUS',
  color        CHAR(6)      NULL,
  text_color   CHAR(6)      NULL,
  PRIMARY KEY (route_key),
  UNIQUE KEY uq_short (route_short)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dim_stop (
  stop_key      SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  gtfs_stop_id  VARCHAR(16)  NOT NULL,
  stop_code     VARCHAR(16)  NULL,
  name          VARCHAR(96)  NOT NULL,
  lat_e7        INT          NOT NULL,
  lon_e7        INT          NOT NULL,
  first_seen    DATETIME     NOT NULL,
  last_seen     DATETIME     NOT NULL,
  PRIMARY KEY (stop_key),
  UNIQUE KEY uq_gtfs (gtfs_stop_id),
  KEY ix_name (name(32)),
  KEY ix_geo (lat_e7, lon_e7)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Menetminta: ugyanaz a megállósorrend ugyanabban az irányban. Ez éli túl a
-- feed rotációját, nem a trip_id.
CREATE TABLE IF NOT EXISTS dim_pattern (
  pattern_key  MEDIUMINT UNSIGNED NOT NULL AUTO_INCREMENT,
  pattern_hash CHAR(16)     NOT NULL,
  route_key    SMALLINT UNSIGNED NOT NULL,
  direction    TINYINT UNSIGNED NOT NULL,
  n_stops      TINYINT UNSIGNED NOT NULL,
  headsign     VARCHAR(96)  NULL,
  first_seen   DATETIME     NOT NULL,
  last_seen    DATETIME     NOT NULL,
  PRIMARY KEY (pattern_key),
  UNIQUE KEY uq_hash (pattern_hash),
  KEY ix_route (route_key, direction)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Megállóköz: SZÁNDÉKOSAN vonalfüggetlen. Ha egy szakaszon öt vonal jár, mind
-- az öt ugyanabba a mintakészletbe mér — ötszörös mintaszám az előrejelzéshez.
CREATE TABLE IF NOT EXISTS dim_segment (
  segment_key   MEDIUMINT UNSIGNED NOT NULL AUTO_INCREMENT,
  from_stop_key SMALLINT UNSIGNED NOT NULL,
  to_stop_key   SMALLINT UNSIGNED NOT NULL,
  dist_m        MEDIUMINT UNSIGNED NULL,
  PRIMARY KEY (segment_key),
  UNIQUE KEY uq_pair (from_stop_key, to_stop_key),
  KEY ix_from (from_stop_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Naptár: ebből jön a „szeptember 1." hatás. Kézzel bővíthető (útlezárás,
-- rendezvény), és a modell ezt kapja meg jellemzőként.
CREATE TABLE IF NOT EXISTS dim_calendar (
  service_date DATE         NOT NULL,
  dow          TINYINT UNSIGNED NOT NULL,
  daytype      TINYINT UNSIGNED NOT NULL,
  school       TINYINT UNSIGNED NOT NULL,
  holiday_name VARCHAR(48)  NULL,
  event_note   VARCHAR(96)  NULL,
  PRIMARY KEY (service_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Feed-pillanatkép: enélkül egy év múlva nem rekonstruálható, mi volt a
-- menetrendi idő, és a „terv vs. valóság" elemzés visszamenőleg lehetetlen.
CREATE TABLE IF NOT EXISTS gtfs_snapshot (
  snapshot_id  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  feed_version VARCHAR(32)  NOT NULL,
  captured_at  DATETIME     NOT NULL,
  n_stops      SMALLINT UNSIGNED NOT NULL,
  n_routes     SMALLINT UNSIGNED NOT NULL,
  n_trips      MEDIUMINT UNSIGNED NOT NULL,
  archive_path VARCHAR(255) NULL,
  PRIMARY KEY (snapshot_id),
  UNIQUE KEY uq_ver (feed_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wx_hour (
  hour_ts      INT UNSIGNED NOT NULL,
  temp_c       DECIMAL(4,1) NULL,
  feels_c      DECIMAL(4,1) NULL,
  wind_kmh     DECIMAL(4,1) NULL,
  wmo_code     TINYINT UNSIGNED NULL,
  PRIMARY KEY (hour_ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── L0 · NYERS TELEMETRIA ──────────────────────────────────────────────
-- Az elsődleges kulcs SZÁNDÉKOSAN nem AUTO_INCREMENT: a (vehicle_key, feed_ts)
-- sorrend miatt InnoDB egymás mellé teszi egy jármű összes pontját, így a
-- „hol járt 24 órán át" kérdés egyetlen szekvenciális olvasás. Ugyanez a kulcs
-- a deduplikáció is: a jármű 18 mp-enként ad fixet, mi 3 mp-enként pollozunk,
-- az INSERT IGNORE a sorok 84%-át ingyen eldobja.

CREATE TABLE IF NOT EXISTS veh_ping (
  service_date DATE              NOT NULL,
  vehicle_key  SMALLINT UNSIGNED NOT NULL,
  feed_ts      INT UNSIGNED      NOT NULL,
  lat_e7       INT               NOT NULL,
  lon_e7       INT               NOT NULL,
  speed_dms    SMALLINT UNSIGNED NULL,
  bearing_deg  SMALLINT UNSIGNED NULL,
  route_key    SMALLINT UNSIGNED NULL,
  trip_hint    VARCHAR(40)       NULL,
  run_id       INT UNSIGNED      NULL,
  along_m      MEDIUMINT UNSIGNED NULL,
  off_route_m  SMALLINT UNSIGNED NULL,
  PRIMARY KEY (vehicle_key, feed_ts, service_date),
  KEY ix_run (run_id, feed_ts),
  KEY ix_unmatched (service_date, run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC
PARTITION BY RANGE COLUMNS (service_date) (
  PARTITION pmax VALUES LESS THAN (MAXVALUE)
);

-- ── L1 · LEVEZETETT TÉNYEK ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trip_run (
  run_id        INT UNSIGNED      NOT NULL AUTO_INCREMENT,
  service_date  DATE              NOT NULL,
  vehicle_key   SMALLINT UNSIGNED NOT NULL,
  route_key     SMALLINT UNSIGNED NOT NULL,
  direction     TINYINT UNSIGNED  NOT NULL,
  pattern_key   MEDIUMINT UNSIGNED NOT NULL,
  sched_start_s MEDIUMINT         NOT NULL,
  sched_end_s   MEDIUMINT         NOT NULL,
  actual_start  INT UNSIGNED      NULL,
  actual_end    INT UNSIGNED      NULL,
  start_delay_s SMALLINT          NULL,
  end_delay_s   SMALLINT          NULL,
  dist_m        MEDIUMINT UNSIGNED NULL,
  moving_s      MEDIUMINT UNSIGNED NULL,
  dwell_s       MEDIUMINT UNSIGNED NULL,
  max_speed_dms SMALLINT UNSIGNED NULL,
  stops_seen    TINYINT UNSIGNED  NOT NULL DEFAULT 0,
  stops_total   TINYINT UNSIGNED  NOT NULL,
  quality       TINYINT UNSIGNED  NOT NULL DEFAULT 0,
  status        VARCHAR(10)       NOT NULL DEFAULT 'running',
  gtfs_trip_id  VARCHAR(40)       NULL,
  updated_at    DATETIME          NOT NULL,
  PRIMARY KEY (run_id, service_date),
  UNIQUE KEY uq_slot (service_date, vehicle_key, pattern_key, sched_start_s),
  KEY ix_veh (vehicle_key, service_date, sched_start_s),
  KEY ix_route (route_key, service_date, sched_start_s),
  KEY ix_status (service_date, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
PARTITION BY RANGE COLUMNS (service_date) (
  PARTITION pmax VALUES LESS THAN (MAXVALUE)
);

-- A rendszer legfontosabb ténytáblája. A kulcs stop_key szerint rendez, mert a
-- legnehezebb lekérdezések megállószintűek („mennyire pontos ez a megálló",
-- „mekkora itt a követési idő") — azok így tartomány-olvasássá válnak.
CREATE TABLE IF NOT EXISTS stop_event (
  service_date DATE              NOT NULL,
  stop_key     SMALLINT UNSIGNED NOT NULL,
  sched_s      MEDIUMINT         NOT NULL,
  run_id       INT UNSIGNED      NOT NULL,
  stop_seq     TINYINT UNSIGNED  NOT NULL,
  route_key    SMALLINT UNSIGNED NOT NULL,
  vehicle_key  SMALLINT UNSIGNED NOT NULL,
  arr_ts       INT UNSIGNED      NULL,
  dep_ts       INT UNSIGNED      NULL,
  delay_s      SMALLINT          NULL,
  dwell_s      SMALLINT UNSIGNED NULL,
  headway_s    MEDIUMINT UNSIGNED NULL,
  sched_hw_s   MEDIUMINT UNSIGNED NULL,
  rt_pred_s    SMALLINT          NULL,
  src          TINYINT UNSIGNED  NOT NULL,
  PRIMARY KEY (service_date, stop_key, sched_s, run_id),
  KEY ix_run (run_id, stop_seq),
  KEY ix_route (route_key, service_date, sched_s),
  KEY ix_veh (vehicle_key, service_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
PARTITION BY RANGE COLUMNS (service_date) (
  PARTITION pmax VALUES LESS THAN (MAXVALUE)
);

-- Itt a szakasz van elöl, mert a domináns lekérdezés mindig ez: „add ide ennek
-- a szakasznak az összes mérését az elmúlt 120 napból" — profilépítéshez és
-- modelltanításhoz egyaránt. Így ez egyetlen összefüggő olvasás.
CREATE TABLE IF NOT EXISTS segment_run (
  segment_key   MEDIUMINT UNSIGNED NOT NULL,
  service_date  DATE              NOT NULL,
  dep_ts        INT UNSIGNED      NOT NULL,
  run_id        INT UNSIGNED      NOT NULL,
  route_key     SMALLINT UNSIGNED NOT NULL,
  travel_s      SMALLINT UNSIGNED NOT NULL,
  sched_s       SMALLINT UNSIGNED NOT NULL,
  dwell_s       SMALLINT UNSIGNED NULL,
  entry_delay_s SMALLINT          NULL,
  tod_bucket    TINYINT UNSIGNED  NOT NULL,
  daytype       TINYINT UNSIGNED  NOT NULL,
  school        TINYINT UNSIGNED  NOT NULL,
  PRIMARY KEY (segment_key, service_date, dep_ts, run_id),
  KEY ix_day (service_date, dep_ts),
  KEY ix_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
PARTITION BY RANGE COLUMNS (service_date) (
  PARTITION pmax VALUES LESS THAN (MAXVALUE)
);

-- ── L2 · AGGREGÁTUMOK ──────────────────────────────────────────────────
-- Minden UI-chart és minden előrejelzés kizárólag innen olvas.

CREATE TABLE IF NOT EXISTS agg_segment_profile (
  segment_key MEDIUMINT UNSIGNED NOT NULL,
  daytype     TINYINT UNSIGNED NOT NULL,
  school      TINYINT UNSIGNED NOT NULL,
  tod_bucket  TINYINT UNSIGNED NOT NULL,
  n           MEDIUMINT UNSIGNED NOT NULL,
  p50_s       SMALLINT UNSIGNED NULL,
  p85_s       SMALLINT UNSIGNED NULL,
  p95_s       SMALLINT UNSIGNED NULL,
  mean_s      SMALLINT UNSIGNED NULL,
  sd_s        SMALLINT UNSIGNED NULL,
  sched_s     SMALLINT UNSIGNED NULL,
  updated_at  DATETIME NOT NULL,
  PRIMARY KEY (segment_key, daytype, school, tod_bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- „Milyen vonalakon szokott ez a busz járni?" — a kulcs pontosan a kérdés alakja.
CREATE TABLE IF NOT EXISTS agg_vehicle_route (
  vehicle_key SMALLINT UNSIGNED NOT NULL,
  period_ym   MEDIUMINT UNSIGNED NOT NULL,
  route_key   SMALLINT UNSIGNED NOT NULL,
  runs        INT UNSIGNED NOT NULL,
  share_pct   TINYINT UNSIGNED NOT NULL,
  dist_km     MEDIUMINT UNSIGNED NOT NULL,
  service_s   INT UNSIGNED NOT NULL,
  days_active SMALLINT UNSIGNED NOT NULL,
  avg_delay_s SMALLINT NULL,
  p85_delay_s SMALLINT NULL,
  PRIMARY KEY (vehicle_key, period_ym, route_key),
  KEY ix_route (route_key, period_ym)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- "Melyik vonalra jósoltuk ezt a járművet, és eltalátuk-e?" — statisztikai
-- (nem valódi gépi tanulásos) becslés: az agg_vehicle_route korábbi
-- hónapjainak futásgyakorisága alapján, MINDEN ÚJ trip_run-nál (tehát
-- mielőtt a mai tényleges hozzárendelést felhasználnánk), egyetlen sorban
-- rögzítjük a jóslatot ÉS a beérkező tényt is — így utólag pontosan
-- lemérhető, hányszor volt igaza.
CREATE TABLE IF NOT EXISTS vehicle_route_prediction (
  pred_id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  vehicle_key         SMALLINT UNSIGNED NOT NULL,
  service_date        DATE NOT NULL,
  run_id              INT UNSIGNED NOT NULL,
  predicted_route_key SMALLINT UNSIGNED NULL,
  predicted_prob_pct  TINYINT UNSIGNED NULL,
  samples             MEDIUMINT UNSIGNED NOT NULL,
  actual_route_key    SMALLINT UNSIGNED NOT NULL,
  correct             TINYINT(1) NOT NULL,
  created_at          INT UNSIGNED NOT NULL,
  PRIMARY KEY (pred_id),
  UNIQUE KEY ux_run (run_id),
  KEY ix_vehicle_date (vehicle_key, service_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agg_vehicle_day (
  vehicle_key  SMALLINT UNSIGNED NOT NULL,
  service_date DATE NOT NULL,
  runs         SMALLINT UNSIGNED NOT NULL,
  routes_n     TINYINT UNSIGNED NOT NULL,
  dist_m       INT UNSIGNED NOT NULL,
  service_s    INT UNSIGNED NOT NULL,
  moving_s     INT UNSIGNED NOT NULL,
  dwell_s      INT UNSIGNED NOT NULL,
  max_speed_dms SMALLINT UNSIGNED NULL,
  avg_delay_s  SMALLINT NULL,
  p85_delay_s  SMALLINT NULL,
  first_ts     INT UNSIGNED NULL,
  last_ts      INT UNSIGNED NULL,
  depot_lat_e7 INT NULL,
  depot_lon_e7 INT NULL,
  gaps_n       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (vehicle_key, service_date),
  KEY ix_date (service_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agg_route_day (
  route_key    SMALLINT UNSIGNED NOT NULL,
  service_date DATE NOT NULL,
  direction    TINYINT UNSIGNED NOT NULL,
  runs         SMALLINT UNSIGNED NOT NULL,
  ghost_runs   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  events_n     MEDIUMINT UNSIGNED NOT NULL,
  otp_pct      TINYINT UNSIGNED NULL,
  early_pct    TINYINT UNSIGNED NULL,
  late_pct     TINYINT UNSIGNED NULL,
  avg_delay_s  SMALLINT NULL,
  p50_delay_s  SMALLINT NULL,
  p85_delay_s  SMALLINT NULL,
  p95_delay_s  SMALLINT NULL,
  bunching_n   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (route_key, service_date, direction),
  KEY ix_date (service_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agg_stop_hour (
  stop_key     SMALLINT UNSIGNED NOT NULL,
  service_date DATE NOT NULL,
  hour         TINYINT UNSIGNED NOT NULL,
  events_n     SMALLINT UNSIGNED NOT NULL,
  otp_pct      TINYINT UNSIGNED NULL,
  avg_delay_s  SMALLINT NULL,
  p85_delay_s  SMALLINT NULL,
  avg_dwell_s  SMALLINT UNSIGNED NULL,
  avg_headway_s MEDIUMINT UNSIGNED NULL,
  PRIMARY KEY (stop_key, service_date, hour),
  KEY ix_date (service_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── ÜZEMELTETÉS ────────────────────────────────────────────────────────

-- Feladatnapló: ettől idempotens az újraindítás (a worker onnan folytatja,
-- ahol abbahagyta) és ettől látszik a Hubban, hogy egészséges-e a feldolgozás.
CREATE TABLE IF NOT EXISTS job_run (
  job_id     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  job        VARCHAR(24)  NOT NULL,
  started_at DATETIME     NOT NULL,
  ended_at   DATETIME     NULL,
  window_from INT UNSIGNED NULL,
  window_to   INT UNSIGNED NULL,
  rows_in    INT UNSIGNED NOT NULL DEFAULT 0,
  rows_out   INT UNSIGNED NOT NULL DEFAULT 0,
  errors     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  ok         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  note       VARCHAR(255) NULL,
  PRIMARY KEY (job_id),
  KEY ix_job (job, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS feed_health (
  service_date  DATE NOT NULL,
  polls_ok      MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
  polls_fail    MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
  pings_kept    MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
  pings_dup     MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
  vehicles_max  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  trip_hint_ok  MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
  trip_hint_bad MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (service_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Minden kiadott előrejelzés + az utólagos tény. Ebből derül ki, hogy a
-- későbbi modell tényleg jobb-e a profilnál, és mennyivel.
CREATE TABLE IF NOT EXISTS prediction_log (
  pred_id      INT UNSIGNED NOT NULL AUTO_INCREMENT,
  made_at      INT UNSIGNED NOT NULL,
  from_stop_key SMALLINT UNSIGNED NOT NULL,
  to_stop_key  SMALLINT UNSIGNED NOT NULL,
  target_ts    INT UNSIGNED NOT NULL,
  method       VARCHAR(16)  NOT NULL,
  pred_p50_s   MEDIUMINT UNSIGNED NOT NULL,
  pred_p85_s   MEDIUMINT UNSIGNED NOT NULL,
  samples      MEDIUMINT UNSIGNED NOT NULL,
  actual_s     MEDIUMINT UNSIGNED NULL,
  PRIMARY KEY (pred_id),
  KEY ix_pair (from_stop_key, to_stop_key, made_at),
  KEY ix_open (actual_s, target_ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Böngésző push-feliratkozások (Web Push API). Egy eszköz/böngésző egy
-- sor — ehhez tartozik 0..N figyelt megálló a push_watch táblában. Lezárt
-- telefonon/bezárt lapnál is ide jut el az értesítés, mert az OS a saját
-- push-szolgáltatásán (FCM/APNs/stb.) ébreszti fel a service workert.
CREATE TABLE IF NOT EXISTS push_subscription (
  sub_id       INT UNSIGNED NOT NULL AUTO_INCREMENT,
  endpoint     VARCHAR(512) NOT NULL,
  p256dh       VARCHAR(255) NOT NULL,
  auth         VARCHAR(255) NOT NULL,
  created_at   INT UNSIGNED NOT NULL,
  -- "Ne zavarj" időszak, percben éjfél óta (0-1439). NULL = nincs beállítva,
  -- ilyenkor a push a nap minden szakában mehet. Az időszak átnyúlhat
  -- éjfélen (pl. 22:00-tól 07:00-ig) — ezt a kiértékelő oldal kezeli.
  dnd_start_min SMALLINT NULL,
  dnd_end_min   SMALLINT NULL,
  PRIMARY KEY (sub_id),
  UNIQUE KEY ux_endpoint (endpoint(255))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Egy figyelés: melyik feliratkozás, melyik megállóra, milyen küszöbbel és
-- (opcionálisan) mely járatszámokra szűkítve. A last_notified a legutóbb
-- riasztott menetek tripId-jeit tárolja vesszővel elválasztva — ez védi az
-- ismétlődő riasztást ugyanarra a menetre, amíg az be nem érkezik.
CREATE TABLE IF NOT EXISTS push_watch (
  watch_id      INT UNSIGNED NOT NULL AUTO_INCREMENT,
  sub_id        INT UNSIGNED NOT NULL,
  stop_id       VARCHAR(32)  NOT NULL,
  stop_name     VARCHAR(128) NOT NULL,
  threshold_min TINYINT UNSIGNED NOT NULL DEFAULT 5,
  route_shorts  VARCHAR(255) NULL,
  -- Ha megadott: csak ez a pontos menetrendi menet (pl. egy kiválasztott
  -- 16:43-as indulás a menetrend fülön) váltja ki a riasztást, a route_shorts
  -- szűrést felülírva — így nem minden aznapi 14-es indulására szól, csak arra
  -- az egyre, amit kiválasztottak.
  trip_id       VARCHAR(64)  NULL,
  -- Csak megjelenítési szöveghez kell: az indulási megállónál "indul", egy
  -- útközbeni megállónál "ér ide" a helyes ige a push-üzenetben.
  is_departure  TINYINT(1)   NOT NULL DEFAULT 0,
  -- "Ismétlődő" figyelés (menetrend fül, checkbox): a GTFS naponta ÚJ
  -- trip_id-t ad ugyanarra a menetrendi mintára, ezért itt nem a trip_id-re,
  -- hanem a route_shorts + ez a menetrendi óra:perc (0-1439, éjféltől
  -- számolva) alapján illesztünk — így minden napra szól, amikor ez a járat
  -- tényleg közlekedik, anélkül hogy előre le kellene kérdezni a GTFS
  -- naptárt (a napi élő érkezés-lista úgyis csak a ténylegesen közlekedő
  -- meneteket adja vissza).
  sched_min     SMALLINT     NULL,
  last_notified VARCHAR(512) NULL,
  updated_at    INT UNSIGNED NOT NULL,
  PRIMARY KEY (watch_id),
  UNIQUE KEY ux_sub_stop (sub_id, stop_id),
  KEY ix_stop (stop_id),
  CONSTRAINT fk_push_watch_sub FOREIGN KEY (sub_id)
    REFERENCES push_subscription(sub_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ═══════════════════════════════════════════════════════════════════════
-- FIÓK ÉS FELHŐS MENTÉS (jelszó nélküli — WebAuthn passkey)
--
-- Nincs jelszó: a hitelesítés a böngésző/eszköz saját passkey-mechanizmusa
-- (Touch ID, Windows Hello, telefon lezárási PIN, biztonsági kulcs stb.) — a
-- szerver soha nem lát és nem tárol semmilyen titkot, csak a nyilvános
-- kulcsot és egy számlálót minden regisztrált hitelesítőhöz (account_credential).
-- A ceremóniát a @simplewebauthn/server könyvtár végzi (account.ts).
--
-- Sikeres regisztráció/belépés után a szerver egy saját munkamenet-tokent ad
-- ki (account_session) — ezt küldi a kliens az X-Account-Session fejlécben a
-- mentési végpontokhoz, mert a WebAuthn maga nem ad hordozható tokent.
--
-- A mentés iránya szigorúan egyirányú AUTOMATÁBÓL: a kliens rendszeresen
-- felküldi a localStorage-ját, de a szerver soha nem küld le adatot magától
-- — letöltés csak a felhasználó kifejezett "Visszaállítás" kérésére történik
-- (lásd account.ts), így a helyi adat automatikusan sosem íródik felül.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS account (
  account_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email      VARCHAR(255) NOT NULL,
  created_at INT UNSIGNED NOT NULL,
  PRIMARY KEY (account_id),
  UNIQUE KEY ux_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Egy fiókhoz több passkey is tartozhat (telefon, laptop, biztonsági kulcs).
CREATE TABLE IF NOT EXISTS account_credential (
  credential_id VARCHAR(255) NOT NULL, -- base64url WebAuthn credential ID
  account_id    INT UNSIGNED NOT NULL,
  public_key    VARBINARY(512) NOT NULL,
  -- Visszajátszás-védelem: minden hitelesítésnél nőnie kell (vagy 0 marad
  -- resident key + support nélkül) — ha visszafelé lépne, az klónozott
  -- hitelesítőre utalna.
  counter       BIGINT UNSIGNED NOT NULL DEFAULT 0,
  transports    VARCHAR(128) NULL,
  device_type   VARCHAR(16) NULL,
  backed_up     TINYINT(1) NOT NULL DEFAULT 0,
  device_name   VARCHAR(64) NULL,
  created_at    INT UNSIGNED NOT NULL,
  last_used_at  INT UNSIGNED NULL,
  PRIMARY KEY (credential_id),
  KEY ix_account (account_id),
  CONSTRAINT fk_account_credential_account FOREIGN KEY (account_id)
    REFERENCES account(account_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Bejelentkezés utáni munkamenet — a nyers tokent csak a kliens ismeri, itt
-- csak a hash-e van (ugyanaz az elv, mint a régebbi push-feliratkozásoknál).
CREATE TABLE IF NOT EXISTS account_session (
  session_hash CHAR(64)     NOT NULL, -- SHA-256 a munkamenet-tokenről
  account_id   INT UNSIGNED NOT NULL,
  created_at   INT UNSIGNED NOT NULL,
  expires_at   INT UNSIGNED NOT NULL,
  PRIMARY KEY (session_hash),
  KEY ix_account (account_id),
  CONSTRAINT fk_account_session_account FOREIGN KEY (account_id)
    REFERENCES account(account_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Egy fiókhoz mindig csak a LEGUTÓBBI mentés él — nem verziózott archívum,
-- csak biztonsági másolat adatvesztés (törölt/eltűnt localStorage) ellen.
CREATE TABLE IF NOT EXISTS account_backup (
  account_id INT UNSIGNED NOT NULL,
  payload    LONGBLOB     NOT NULL,
  bytes      INT UNSIGNED NOT NULL,
  updated_at INT UNSIGNED NOT NULL,
  PRIMARY KEY (account_id),
  CONSTRAINT fk_account_backup_account FOREIGN KEY (account_id)
    REFERENCES account(account_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ═══════════════════════════════════════════════════════════════════════
-- ÜZEMZAVAROK ÉS FLOTTA-RENDELKEZÉSRE ÁLLÁS
--
-- A cél nem az, hogy minden GPS-kiesést meghibásodásnak kiáltsunk ki — az
-- használhatatlan zajt adna. Ezért minden észlelés KONFIDENCIÁT kap, és négy
-- megkülönböztető jel csökkenti: a korridor többi járműve is áll-e (dugó),
-- folytatódik-e hamarosan a jeladás (adathiány), a szokásos műszakvég
-- környékén történt-e (normál bevonás), és állt-e közben a gyűjtés.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vehicle_incident (
  incident_id   INT UNSIGNED      NOT NULL AUTO_INCREMENT,
  vehicle_key   SMALLINT UNSIGNED NOT NULL,
  service_date  DATE              NOT NULL,
  -- mid_trip_stop = menet közben elnémult · stuck = helyben áll ·
  -- early_end = korai bevonás · absence = napokig kiesett a flottából
  kind          VARCHAR(16)       NOT NULL,
  started_ts    INT UNSIGNED      NOT NULL,
  ended_ts      INT UNSIGNED      NULL,
  duration_s    MEDIUMINT UNSIGNED NULL,
  run_id        INT UNSIGNED      NULL,
  route_key     SMALLINT UNSIGNED NULL,
  stop_key      SMALLINT UNSIGNED NULL,
  lat_e7        INT               NULL,
  lon_e7        INT               NULL,
  -- Hol tartott a menetben (0–100%): a 90% fölötti megszakadás jóval
  -- valószínűbben normál befejezés, mint meghibásodás.
  progress_pct  TINYINT UNSIGNED  NULL,
  severity      TINYINT UNSIGNED  NOT NULL DEFAULT 1,
  confidence    TINYINT UNSIGNED  NOT NULL DEFAULT 50,
  -- Hány másik jármű állt egyidejűleg ugyanazon a korridoron: ha több,
  -- az forgalmi torlódás, nem a jármű hibája.
  peers_stuck   TINYINT UNSIGNED  NOT NULL DEFAULT 0,
  -- Hány üzemi napot hiányzott (csak `absence` esetén, lezáráskor).
  absent_days   SMALLINT UNSIGNED NULL,
  resolution    VARCHAR(48)       NULL,
  note          VARCHAR(160)      NULL,
  detected_at   DATETIME          NOT NULL,
  PRIMARY KEY (incident_id),
  -- Ugyanaz az esemény ne keletkezzen újra minden feldolgozási körben.
  UNIQUE KEY uq_event (vehicle_key, kind, started_ts),
  KEY ix_vehicle (vehicle_key, service_date),
  KEY ix_open (ended_ts, kind),
  KEY ix_date (service_date, kind),
  KEY ix_route (route_key, service_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Napi flotta-jelenlét. Ebből jön a „mikor tűnt el és mikor jött vissza"
-- kérdés, és ez adja a rendelkezésre állási mutatót is.
CREATE TABLE IF NOT EXISTS vehicle_presence (
  vehicle_key   SMALLINT UNSIGNED NOT NULL,
  service_date  DATE              NOT NULL,
  runs          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  service_s     INT UNSIGNED      NOT NULL DEFAULT 0,
  incidents_n   TINYINT UNSIGNED  NOT NULL DEFAULT 0,
  -- 0 = aznap egyáltalán nem láttuk
  active        TINYINT UNSIGNED  NOT NULL DEFAULT 0,
  PRIMARY KEY (vehicle_key, service_date),
  KEY ix_date (service_date, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── L3 · MENETREND-ARCHÍVUM ────────────────────────────────────────────
-- A GTFS feed mindig csak a KÖVETKEZŐ pár hetet ismeri: ami kifut belőle,
-- azt semmi nem őrzi meg. Enélkül egy múltbeli napra nem lehet megmondani,
-- egyáltalán milyen menetrend volt érvényes. Ezért a gateway minden feed-
-- frissítéskor elrakja az érvényességi tartomány összes napjának menetrendjét.
--
-- A napi menetrend napról napra szinte azonos, ezért TARTALOM-HASH szerint
-- deduplikálunk: az összes hétköznap ugyanarra a blobra mutat, így egy év
-- archívuma is néhány tucat blob marad.
CREATE TABLE IF NOT EXISTS sched_blob (
  blob_hash  CHAR(40)           NOT NULL,
  bytes      MEDIUMINT UNSIGNED NOT NULL,
  -- gzip-elt JSON: { routes: [...], tables: { "<routeId>|<dir>": {...} } }
  payload    LONGBLOB           NOT NULL,
  created_at DATETIME           NOT NULL,
  PRIMARY KEY (blob_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sched_day (
  service_date DATE               NOT NULL,
  feed_version VARCHAR(24)        NOT NULL,
  n_routes     SMALLINT UNSIGNED  NOT NULL,
  n_trips      MEDIUMINT UNSIGNED NOT NULL,
  blob_hash    CHAR(40)           NOT NULL,
  captured_at  DATETIME           NOT NULL,
  PRIMARY KEY (service_date),
  KEY ix_blob (blob_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Melyik jármű teljesítette az adott menetet. A gateway 0–24-ben mintavételezi
-- a pozíciófeedet; ez a napló a `trip_run`-tól függetlenül is megvan, mert nem
-- igényli a statisztikai worker mintaillesztését.
CREATE TABLE IF NOT EXISTS trip_vehicle_log (
  service_date DATE               NOT NULL,
  trip_id      VARCHAR(40)        NOT NULL,
  vehicle_id   VARCHAR(16)        NOT NULL,
  first_seen   INT UNSIGNED       NOT NULL,
  last_seen    INT UNSIGNED       NOT NULL,
  samples      MEDIUMINT UNSIGNED NOT NULL,
  PRIMARY KEY (service_date, trip_id, vehicle_id),
  KEY ix_day (service_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Kihúzott (törölt) menetek napló. Az MVK `list-cancelled-trips` végpontja
-- KIZÁRÓLAG a mai napra válaszol, és semmi nem őrzi meg — enélkül visszalapozva
-- a menetrendkönyv nem tudná megmondani, mely menetek maradtak ki egy múltbeli
-- napon. A gateway percenként mintázza a listát, és amit lát, azt itt végleg
-- megőrzi.
CREATE TABLE IF NOT EXISTS cancelled_trip_log (
  service_date DATE               NOT NULL,
  trip_id      VARCHAR(40)        NOT NULL,
  first_seen   INT UNSIGNED       NOT NULL,
  last_seen    INT UNSIGNED       NOT NULL,
  samples      MEDIUMINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (service_date, trip_id),
  KEY ix_day (service_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
