-- MÁV+ OTP2: a Volán és a vasút a megyében (lásd docs/MAVPLUSZ_OTP2.md).
--
-- A regionális menetrend szolgáltatási naponként egy GTFS-zip az OTP2-ből,
-- ugyanabban a táblában, mint az MVK feedjei, csak `source = 'regional'`.
-- A tényadatok (veh_ping, stop_event, trip_run…) ugyanazok a táblák: a
-- regionális azonosítók előtagosak (`hkir:`, `1:`), az MVK-iak nem.

ALTER TABLE gtfs_feed ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'mvk';
-- a regionális feed egy szolgáltatási napra szól
ALTER TABLE gtfs_feed ADD COLUMN IF NOT EXISTS service_date date;
CREATE INDEX IF NOT EXISTS gtfs_feed_source_idx ON gtfs_feed (source, status, version DESC);
CREATE INDEX IF NOT EXISTS gtfs_feed_regional_day_idx ON gtfs_feed (service_date, fetched_at DESC) WHERE source = 'regional';

ALTER TABLE service_day ADD COLUMN IF NOT EXISTS regional_feed_id int REFERENCES gtfs_feed (id);
ALTER TABLE service_day ADD COLUMN IF NOT EXISTS regional_trips int;

-- Dimenziók: vágány / kocsiállás, állomás, kiírt név (a route_short a kulcs, máshol a vonal-azonosító)
ALTER TABLE stop ADD COLUMN IF NOT EXISTS parent_station text;
ALTER TABLE stop ADD COLUMN IF NOT EXISTS platform text;
ALTER TABLE stop ADD COLUMN IF NOT EXISTS mode text;
ALTER TABLE route ADD COLUMN IF NOT EXISTS short_name text;
ALTER TABLE route ADD COLUMN IF NOT EXISTS operator text;

-- A menet kiírt neve (vasútnál a vonatszám: a statisztika vonatszám szerint is csoportosít),
-- és hogy a jelei honnan jöttek (mvk = natív, otp2 = MÁV+).
ALTER TABLE trip_run ADD COLUMN IF NOT EXISTS trip_short text;
ALTER TABLE trip_run ADD COLUMN IF NOT EXISTS rt_source text;
CREATE INDEX IF NOT EXISTS trip_run_short_idx ON trip_run (trip_short, service_date) WHERE trip_short IS NOT NULL;

-- Az OTP2-minták (nyomvonal, megállók, vonal) gyorsítótára: naponta csak az újakat kérjük le.
CREATE TABLE IF NOT EXISTS otp_pattern (
  code       text PRIMARY KEY,
  data       jsonb       NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

-- Forrásonkénti egészség naponta (mvk, otp2-mvk = árnyék-összevetés, otp2 = regionális)
CREATE TABLE IF NOT EXISTS source_health (
  service_date date        NOT NULL,
  source       text        NOT NULL,
  polls_ok     int         NOT NULL DEFAULT 0,
  polls_fail   int         NOT NULL DEFAULT 0,
  vehicles_max int         NOT NULL DEFAULT 0,
  lag_p50_s    int,
  lag_p95_s    int,
  coverage     real,
  fallback_s   int         NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (service_date, source)
);

-- Hivatalos megjegyzések menetenként (vasút: késés oka, kocsiösszeállítás, pótlóbusz) — a statisztikához
CREATE TABLE IF NOT EXISTS transit_notice (
  service_date date        NOT NULL,
  trip_id      text        NOT NULL,
  route_short  text,
  train_no     text,
  text         text        NOT NULL,
  kind         text        NOT NULL CHECK (kind IN ('cause', 'composition', 'replacement', 'other')),
  first_seen   timestamptz NOT NULL,
  last_seen    timestamptz NOT NULL,
  PRIMARY KEY (service_date, trip_id, text)
);
CREATE INDEX IF NOT EXISTS transit_notice_kind_idx ON transit_notice (kind, service_date);

-- Élő vágány-adat (vasútállomás, autóbusz-állomás): a vágányváltás és a vágányhasználat statisztikájához
CREATE TABLE IF NOT EXISTS transit_platform (
  service_date   date        NOT NULL,
  trip_id        text        NOT NULL,
  stop_id        text        NOT NULL,
  platform       text        NOT NULL,
  sched_platform text,
  first_seen     timestamptz NOT NULL,
  last_seen      timestamptz NOT NULL,
  PRIMARY KEY (service_date, trip_id, stop_id)
);
CREATE INDEX IF NOT EXISTS transit_platform_stop_idx ON transit_platform (stop_id, service_date);
