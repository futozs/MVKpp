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
