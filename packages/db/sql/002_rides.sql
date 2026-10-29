-- Utazási napló: a „Felszálltam” gombbal / automatikus felismeréssel rögzített
-- utazások. Bejelentkezés nélkül a telefonon gyűlnek; belépéskor ide töltődnek fel.
CREATE TABLE ride (
  user_id    uuid        NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  ride_id    uuid        NOT NULL,
  boarded_at timestamptz NOT NULL,
  data       jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ride_id)
);
CREATE INDEX ride_user_time_idx ON ride (user_id, boarded_at DESC);
