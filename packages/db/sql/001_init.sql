-- ═══════════════════════════════════════════════════════════════════════
-- MVK v3  adatbázis
--
--  · Minden idő timestamptz (UTC tárolás, Budapest megjelenítés).
--  · A nyers GPS (veh_ping) ÖRÖKRE megmarad: Timescale hypertable, 3 nap után
--    tömörítve (~10× kisebb). Ebből bármikor újraszámolható minden más, és
--    ebből megy a térképes idővonal.
--  · A stabil kulcsok szövegesek (vonalszám, megálló-azonosító, rendszám):
--    a GTFS naponta új trip_id-ket ad, ezek túlélik a feed-rotációt.
-- ═══════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ── Menetrend (GTFS) ────────────────────────────────────────────────────

-- Minden letöltött feed, az elutasítottak is (diagnosztikához). A zip maga
-- is itt van: egy múltbeli nap pontos menetrendje mindig visszaállítható.
CREATE TABLE gtfs_feed (
  id            serial PRIMARY KEY,
  version       text        NOT NULL,
  sha256        text        NOT NULL UNIQUE,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  start_date    date,
  end_date      date,
  first_service date,
  last_service  date,
  n_stops       int         NOT NULL,
  n_routes      int         NOT NULL,
  n_trips       int         NOT NULL,
  n_stop_times  int         NOT NULL,
  status        text        NOT NULL CHECK (status IN ('ok', 'rejected')),
  validation    jsonb       NOT NULL,
  zip           bytea       NOT NULL
);
CREATE INDEX gtfs_feed_status_idx ON gtfs_feed (status, version DESC);

-- Melyik menetrend volt ténylegesen érvényben egy napon (fallback esetén is).
CREATE TABLE service_day (
  service_date      date PRIMARY KEY,
  feed_id           int  REFERENCES gtfs_feed (id),
  feed_version      text NOT NULL,
  fallback_template date,
  fallback_reason   text,
  n_trips           int  NOT NULL,
  decided_at        timestamptz NOT NULL DEFAULT now()
);

-- A régi (v2) rendszer napi menetrend-archívuma: azokra a napokra, amelyek
-- feedje nincs meg, ebből szolgáljuk ki a menetrendkönyvet.
CREATE TABLE legacy_schedule_day (
  service_date date PRIMARY KEY,
  feed_version text  NOT NULL,
  n_trips      int   NOT NULL,
  payload      bytea NOT NULL, -- gzip JSON: { routes, tables }
  imported_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Stabil dimenziók ────────────────────────────────────────────────────

CREATE TABLE stop (
  stop_id    text PRIMARY KEY,
  code       text,
  name       text NOT NULL,
  lat        double precision NOT NULL,
  lon        double precision NOT NULL,
  geom       geography(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography) STORED,
  first_seen date NOT NULL,
  last_seen  date NOT NULL
);
CREATE INDEX stop_geom_idx ON stop USING gist (geom);

CREATE TABLE route (
  route_short   text PRIMARY KEY,
  gtfs_route_id text,
  long_name     text,
  kind          text NOT NULL DEFAULT 'BUS',
  color         text,
  text_color    text,
  first_seen    date NOT NULL,
  last_seen     date NOT NULL
);

CREATE TABLE vehicle (
  vehicle_id text PRIMARY KEY,
  label      text,
  kind       text,
  first_seen timestamptz NOT NULL,
  last_seen  timestamptz NOT NULL
);

CREATE TABLE calendar_day (
  service_date date PRIMARY KEY,
  dow          smallint NOT NULL,
  daytype      smallint NOT NULL, -- 0 munkanap · 1 szombat · 2 vasárnap/ünnep
  school       boolean  NOT NULL,
  holiday      text,
  note         text
);

-- ── Nyers GPS  végtelen megőrzés ───────────────────────────────────────

CREATE TABLE veh_ping (
  ts           timestamptz      NOT NULL,
  vehicle_id   text             NOT NULL,
  lat          double precision NOT NULL,
  lon          double precision NOT NULL,
  speed        real,           -- m/s
  bearing      smallint,
  rt_trip_id   text,           -- az MVK által küldött trip_id
  trip_id      text,           -- a feloldott (saját feed szerinti) menet
  route_short  text,
  service_date date
);
SELECT create_hypertable('veh_ping', by_range('ts', INTERVAL '1 day'));
CREATE UNIQUE INDEX veh_ping_uq ON veh_ping (vehicle_id, ts);
CREATE INDEX veh_ping_trip_idx ON veh_ping (trip_id, ts) WHERE trip_id IS NOT NULL;
ALTER TABLE veh_ping SET (timescaledb.compress, timescaledb.compress_segmentby = 'vehicle_id', timescaledb.compress_orderby = 'ts');
SELECT add_compression_policy('veh_ping', INTERVAL '3 days');

-- ── Menetek és megálló-események ────────────────────────────────────────

CREATE TABLE trip_run (
  run_id        bigserial PRIMARY KEY,
  run_key       text        NOT NULL UNIQUE, -- service_date|trip_id|vehicle_id
  service_date  date        NOT NULL,
  trip_id       text        NOT NULL,
  vehicle_id    text        NOT NULL,
  route_short   text        NOT NULL,
  route_id      text,
  direction     smallint    NOT NULL,
  pattern       text        NOT NULL,
  headsign      text,
  feed_version  text,
  sched_start_s int         NOT NULL,
  sched_end_s   int         NOT NULL,
  stops_total   smallint    NOT NULL,
  stops_seen    smallint    NOT NULL DEFAULT 0,
  opened_at     timestamptz NOT NULL,
  last_seen_at  timestamptz,
  actual_start  timestamptz,
  actual_end    timestamptz,
  start_delay_s int,
  end_delay_s   int,
  last_delay_s  int,
  last_stop_idx smallint,
  dist_m        int,
  max_speed     real,
  status        text        NOT NULL CHECK (status IN ('running', 'complete', 'partial', 'aborted')),
  close_reason  text,
  source        text        NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'replay', 'legacy')),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trip_run_day_route_idx ON trip_run (service_date, route_short);
CREATE INDEX trip_run_vehicle_idx ON trip_run (vehicle_id, service_date);
CREATE INDEX trip_run_day_trip_idx ON trip_run (service_date, trip_id);
CREATE INDEX trip_run_status_idx ON trip_run (service_date, status);
CREATE INDEX trip_run_pattern_idx ON trip_run (pattern, sched_start_s);

-- A rendszer legfontosabb ténytáblája. ts = érkezés a megállóba.
CREATE TABLE stop_event (
  ts              timestamptz NOT NULL,
  service_date    date        NOT NULL,
  run_key         text        NOT NULL,
  trip_id         text        NOT NULL,
  vehicle_id      text        NOT NULL,
  route_short     text        NOT NULL,
  stop_id         text        NOT NULL,
  stop_seq        smallint    NOT NULL,
  stop_idx        smallint    NOT NULL,
  is_first        boolean     NOT NULL,
  is_last         boolean     NOT NULL,
  sched_arr_s     int         NOT NULL,
  sched_dep_s     int         NOT NULL,
  dep_ts          timestamptz,
  delay_s         int         NOT NULL, -- első megállónál indulási, máshol érkezési késés
  dwell_s         int,
  headway_s       int,
  sched_headway_s int,
  src             smallint    NOT NULL -- 1 megállt · 2 áthaladt (interpolált) · 3 becsült végállomás · 9 v2-ből átvett
);
SELECT create_hypertable('stop_event', by_range('ts', INTERVAL '7 days'));
CREATE UNIQUE INDEX stop_event_uq ON stop_event (run_key, stop_idx, ts);
CREATE INDEX stop_event_stop_idx ON stop_event (stop_id, ts DESC);
CREATE INDEX stop_event_route_idx ON stop_event (route_short, ts DESC);
CREATE INDEX stop_event_trip_idx ON stop_event (service_date, trip_id);
CREATE INDEX stop_event_vehicle_idx ON stop_event (vehicle_id, ts DESC);
ALTER TABLE stop_event SET (timescaledb.compress, timescaledb.compress_segmentby = 'route_short', timescaledb.compress_orderby = 'ts');
SELECT add_compression_policy('stop_event', INTERVAL '45 days');

-- Megállóköz-menetidők: az útvonaltervező késés-előrejelzésének alapja.
CREATE TABLE segment_run (
  ts            timestamptz NOT NULL, -- indulás a kezdő megállóból
  service_date  date        NOT NULL,
  from_stop     text        NOT NULL,
  to_stop       text        NOT NULL,
  route_short   text        NOT NULL,
  run_key       text        NOT NULL,
  travel_s      int         NOT NULL,
  sched_s       int         NOT NULL,
  dwell_s       int,
  entry_delay_s int,
  tod_bucket    smallint    NOT NULL,
  daytype       smallint    NOT NULL,
  school        boolean     NOT NULL
);
SELECT create_hypertable('segment_run', by_range('ts', INTERVAL '7 days'));
CREATE UNIQUE INDEX segment_run_uq ON segment_run (run_key, from_stop, ts);
CREATE INDEX segment_run_pair_idx ON segment_run (from_stop, to_stop, ts DESC);
ALTER TABLE segment_run SET (timescaledb.compress, timescaledb.compress_segmentby = 'from_stop', timescaledb.compress_orderby = 'ts');
SELECT add_compression_policy('segment_run', INTERVAL '45 days');

-- ── Folyamatos aggregátumok (minden statisztika innen olvas) ────────────

-- Megálló × vonal × óra. A percentilisekhez a toolkit uddsketch-ét
-- használjuk, így tetszőleges időszakra összevonható (rollup).
CREATE MATERIALIZED VIEW stop_event_hourly
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket(INTERVAL '1 hour', ts) AS bucket,
       service_date,
       stop_id,
       route_short,
       count(*)                                          AS n,
       avg(delay_s)::real                                AS avg_delay_s,
       count(*) FILTER (WHERE delay_s BETWEEN -60 AND 300) AS n_ontime,
       count(*) FILTER (WHERE delay_s < -60)             AS n_early,
       count(*) FILTER (WHERE delay_s > 300)             AS n_late,
       percentile_agg(delay_s)                           AS delay_pct,
       avg(dwell_s)::real                                AS avg_dwell_s,
       avg(headway_s)::real                              AS avg_headway_s
  FROM stop_event
 WHERE src <> 3
 GROUP BY bucket, service_date, stop_id, route_short
WITH NO DATA;
SELECT add_continuous_aggregate_policy('stop_event_hourly',
  start_offset => INTERVAL '3 days', end_offset => INTERVAL '5 minutes', schedule_interval => INTERVAL '5 minutes');

-- Megállóköz × napszak (negyedóra) × naptípus, naponta.
CREATE MATERIALIZED VIEW segment_daily
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket(INTERVAL '1 day', ts) AS bucket,
       from_stop,
       to_stop,
       tod_bucket,
       daytype,
       school,
       count(*)                AS n,
       percentile_agg(travel_s) AS travel_pct,
       avg(sched_s)::real      AS avg_sched_s,
       avg(entry_delay_s)::real AS avg_entry_delay_s
  FROM segment_run
 GROUP BY bucket, from_stop, to_stop, tod_bucket, daytype, school
WITH NO DATA;
SELECT add_continuous_aggregate_policy('segment_daily',
  start_offset => INTERVAL '3 days', end_offset => INTERVAL '10 minutes', schedule_interval => INTERVAL '15 minutes');

-- ── Kimaradt menetek, üzemzavarok ───────────────────────────────────────

CREATE TABLE cancelled_trip (
  service_date date        NOT NULL,
  trip_id      text        NOT NULL,
  first_seen   timestamptz NOT NULL,
  last_seen    timestamptz NOT NULL,
  samples      int         NOT NULL DEFAULT 1,
  PRIMARY KEY (service_date, trip_id)
);

-- v3 üzemzavar: minden sorhoz bizonyíték tartozik, és csak LEZÁRT adatból
-- keletkezik (nem a folyamatban lévő napból, mint a régi detektornál).
CREATE TABLE incident (
  id           bigserial PRIMARY KEY,
  service_date date        NOT NULL,
  kind         text        NOT NULL, -- cancelled | missed | breakdown | long_stop | detour
  source       text        NOT NULL, -- mvk = hivatalos MVK-adat · detected = saját észlelés
  confidence   smallint    NOT NULL,
  route_short  text,
  trip_id      text,
  vehicle_id   text,
  stop_id      text,
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  lat          double precision,
  lon          double precision,
  title        text        NOT NULL,
  detail       text,
  evidence     jsonb       NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX incident_uq ON incident (service_date, kind, coalesce(trip_id, ''), coalesce(vehicle_id, ''), started_at);
CREATE INDEX incident_day_idx ON incident (service_date DESC, kind);
CREATE INDEX incident_vehicle_idx ON incident (vehicle_id, service_date DESC);

-- ── Rendszám-előrejelzés (önjutalmazó) ──────────────────────────────────

CREATE TABLE vehicle_prediction (
  id                bigserial PRIMARY KEY,
  service_date      date        NOT NULL,
  trip_id           text        NOT NULL,
  route_short       text        NOT NULL,
  sched_start_s     int         NOT NULL,
  horizon_min       smallint    NOT NULL, -- 30 / 15 / 5 perccel az indulás előtt
  made_at           timestamptz NOT NULL,
  predicted_vehicle text        NOT NULL,
  confidence        real        NOT NULL,
  method            text        NOT NULL,
  features          jsonb       NOT NULL DEFAULT '{}',
  actual_vehicle    text,
  correct           boolean,
  resolved_at       timestamptz,
  UNIQUE (service_date, trip_id, horizon_min)
);
CREATE INDEX vehicle_prediction_open_idx ON vehicle_prediction (service_date) WHERE correct IS NULL;

-- A modell jelzéseinek súlyai: találatnál nő, tévedésnél csökken.
CREATE TABLE vehicle_model_weight (
  signal     text PRIMARY KEY,
  weight     real        NOT NULL,
  hits       int         NOT NULL DEFAULT 0,
  misses     int         NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Fiók, szinkron (passkey) ────────────────────────────────────────────

CREATE TABLE app_user (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext      NOT NULL UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  legacy_account_id int UNIQUE
);

CREATE TABLE passkey (
  credential_id text PRIMARY KEY, -- base64url
  user_id       uuid        NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  public_key    bytea       NOT NULL,
  counter       bigint      NOT NULL DEFAULT 0,
  transports    text,
  device_type   text,
  backed_up     boolean     NOT NULL DEFAULT false,
  device_name   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE INDEX passkey_user_idx ON passkey (user_id);

CREATE TABLE user_session (
  token_hash   text PRIMARY KEY, -- SHA-256; a nyers tokent csak a kliens ismeri
  user_id      uuid        NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz,
  user_agent   text
);
CREATE INDEX user_session_user_idx ON user_session (user_id);

-- Kulcsonkénti, kétirányú szinkron: minden localStorage-kulcs külön sor,
-- az újabb nyer (updated_at). Így két eszköz egyszerre is használható.
CREATE TABLE user_state (
  user_id    uuid        NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  key        text        NOT NULL,
  value      jsonb,
  deleted    boolean     NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL,
  device_id  text,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX user_state_updated_idx ON user_state (user_id, updated_at);

-- A v2 /account/backup végpont kompatibilitásához (az iOS app hívhatja).
CREATE TABLE legacy_backup (
  user_id    uuid PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
  payload    bytea       NOT NULL,
  bytes      int         NOT NULL,
  updated_at timestamptz NOT NULL
);

-- ── Push értesítések ────────────────────────────────────────────────────

CREATE TABLE push_subscription (
  id              serial PRIMARY KEY,
  endpoint        text        NOT NULL UNIQUE,
  p256dh          text        NOT NULL,
  auth            text        NOT NULL,
  user_id         uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  enabled         boolean     NOT NULL DEFAULT true,
  dnd_start_min   smallint,
  dnd_end_min     smallint,
  last_success_at timestamptz,
  fail_count      int         NOT NULL DEFAULT 0,
  user_agent      text
);

-- Egy eszköz egy megállóra TÖBB figyelést is tarthat (a régi séma egyet
-- engedett, a második felülírta az elsőt). A v2-kompatibilis API a
-- 'default' slotot használja, így ott a régi viselkedés megmarad.
CREATE TABLE push_watch (
  id              serial PRIMARY KEY,
  subscription_id int         NOT NULL REFERENCES push_subscription (id) ON DELETE CASCADE,
  slot            text        NOT NULL DEFAULT 'default',
  stop_id         text        NOT NULL,
  stop_name       text        NOT NULL,
  threshold_min   smallint    NOT NULL DEFAULT 5,
  route_shorts    text[],
  trip_id         text,
  sched_min       smallint, -- ismétlődő: menetrendi óra:perc éjfél óta
  is_departure    boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, stop_id, slot)
);
CREATE INDEX push_watch_stop_idx ON push_watch (stop_id);

-- Kézbesítési napló: menetenként pontosan egy értesítés, újrapróbálással.
CREATE TABLE push_delivery (
  id           bigserial PRIMARY KEY,
  watch_id     int         NOT NULL REFERENCES push_watch (id) ON DELETE CASCADE,
  service_date date        NOT NULL,
  trip_id      text        NOT NULL,
  kind         text        NOT NULL, -- arrival | cancelled
  status       text        NOT NULL, -- queued | sent | failed | gone | skipped
  attempts     smallint    NOT NULL DEFAULT 0,
  last_error   text,
  payload      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  UNIQUE (watch_id, service_date, trip_id, kind)
);
CREATE INDEX push_delivery_recent_idx ON push_delivery (created_at DESC);

-- ── Token, üzemeltetés ──────────────────────────────────────────────────

CREATE TABLE mvk_token (
  id              serial PRIMARY KEY,
  jwt_enc         text        NOT NULL, -- AES-256-GCM, kulcs: APP_SECRET
  installation_id text,
  iat             timestamptz,
  exp             timestamptz NOT NULL,
  source          text        NOT NULL, -- agent | renew | manual | import
  agent_id        text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  rejected_at     timestamptz
);
CREATE INDEX mvk_token_exp_idx ON mvk_token (exp DESC);

CREATE TABLE agent_heartbeat (
  agent_id     text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL,
  info         jsonb       NOT NULL DEFAULT '{}'
);

CREATE TABLE weather_hour (
  hour     timestamptz PRIMARY KEY,
  temp_c   real,
  feels_c  real,
  wind_kmh real,
  wmo_code smallint
);

CREATE TABLE feed_health (
  service_date date PRIMARY KEY,
  polls_ok     int NOT NULL DEFAULT 0,
  polls_fail   int NOT NULL DEFAULT 0,
  pings_kept   int NOT NULL DEFAULT 0,
  vehicles_max int NOT NULL DEFAULT 0
);

CREATE TABLE job_state (
  job           text PRIMARY KEY,
  last_ok_at    timestamptz,
  last_error    text,
  last_error_at timestamptz,
  info          jsonb NOT NULL DEFAULT '{}'
);
