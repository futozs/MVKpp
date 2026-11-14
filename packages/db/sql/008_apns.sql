-- Natív iOS-értesítés (APNs).
-- Az iPhone ugyanolyan push-feliratkozás, mint egy böngésző: a végpontja
-- `apns:<sandbox|production>:<hex eszköztoken>`, és nincsenek Web Push-kulcsai.
ALTER TABLE push_subscription ALTER COLUMN p256dh DROP NOT NULL;
ALTER TABLE push_subscription ALTER COLUMN auth DROP NOT NULL;

-- Élő tevékenység (Live Activity) a követett menethez: az ActivityKit push-tokenje
-- a menettel. A worker a menet haladásakor frissítést, a végén „end”-et küld.
CREATE TABLE IF NOT EXISTS live_activity_token (
  token          text PRIMARY KEY,
  env            text        NOT NULL, -- sandbox | production
  trip_id        text        NOT NULL,
  vehicle_id     text,
  stop_id        text,
  device_id      text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- a felhasználó befejezte (DELETE): a worker még egy „end”-et küld, aztán törli
  end_requested  boolean     NOT NULL DEFAULT false,
  last_sent_at   timestamptz,
  last_state     jsonb,
  fail_count     int         NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS live_activity_token_device_idx ON live_activity_token (device_id);
