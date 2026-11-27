-- ═══════════════════════════════════════════════════════════════════════
-- Adventi villamos
--
--  · advent_ping: a szerelvény (2026-ban a 202) MINDEN GPS-jele, évadon kívül
--    is, örökre, nem tömörítve. Benne minden, amit az MVK a jelhez küldött
--    (címke, trip_id, vonal), mert ezek később nem állíthatók vissza.
--  · advent_presence: percenként, az évad üzemideje körül: jött-e adat az
--    MVK-tól, látszott-e a villamos. Ebből dől el utólag, hogy a csend a
--    villamosé volt (nem küldött jelet), vagy a mienk (nem jött adat).
--  · advent_day: a lezárt nap összegzése. A pontokból bármikor újraszámolható;
--    az `algo` mutatja, melyik számítás készítette.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE advent_ping (
  ts           timestamptz      NOT NULL,
  vehicle_id   text             NOT NULL,
  lat          double precision NOT NULL,
  lon          double precision NOT NULL,
  speed        real,
  bearing      smallint,
  service_date date             NOT NULL,
  season       smallint,
  polled_at    timestamptz      NOT NULL,
  source       text             NOT NULL CHECK (source IN ('mvk', 'otp2')),
  label        text,
  rt_trip_id   text,
  rt_route     text,
  route_short  text,
  headsign     text,
  -- a feed hibás pillanata (pl. 2026-09-15: az egész flotta egy meneten): tároljuk, de nem számolunk vele
  glitch       boolean          NOT NULL DEFAULT false,
  PRIMARY KEY (vehicle_id, ts)
);
CREATE INDEX advent_ping_day_idx ON advent_ping (service_date, ts);

CREATE TABLE advent_presence (
  minute       timestamptz NOT NULL PRIMARY KEY,
  service_date date        NOT NULL,
  polls_ok     smallint    NOT NULL,
  polls_fail   smallint    NOT NULL,
  seen_polls   smallint    NOT NULL,
  trams        smallint    NOT NULL,
  fix_age_s    int
);
CREATE INDEX advent_presence_day_idx ON advent_presence (service_date);

CREATE TABLE advent_day (
  service_date date        PRIMARY KEY,
  season       smallint    NOT NULL,
  verdict      text        NOT NULL,
  summary      jsonb       NOT NULL,
  final        boolean     NOT NULL DEFAULT false,
  algo         text        NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now()
);

-- A v2-import a Tatrákat (202, 203) busznak vette fel, pedig az 1-es villamoson járnak.
UPDATE vehicle SET kind = 'TRAM' WHERE vehicle_id IN ('202', '203');
