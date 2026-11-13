-- Rendszer-hub (apps/hub): használati statisztika, kedvencek, agent-parancsok,
-- műveleti napló és a válaszidő-mérések.

-- ── Használat ───────────────────────────────────────────────────────────
-- Eszközönként egy sor (a webapp véletlen mvk_device_id-je  IP-cím nincs
-- tárolva). A kedvencek pillanatképe a legutóbbi állapot; a hub ebből
-- összesít (legkedveltebb vonalak, megállók, járművek, parkolók).
CREATE TABLE IF NOT EXISTS usage_device (
  device_id    text PRIMARY KEY,
  user_id      uuid REFERENCES app_user (id) ON DELETE SET NULL,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  platform     text,  -- ios | android | macos | windows | linux | other
  browser      text,
  standalone   boolean NOT NULL DEFAULT false, -- főképernyőre telepített PWA
  lang         text,
  screen       text,
  opens        int NOT NULL DEFAULT 0,
  favorites    jsonb,
  favorites_at timestamptz
);
CREATE INDEX IF NOT EXISTS usage_device_last_idx ON usage_device (last_seen DESC);
CREATE INDEX IF NOT EXISTS usage_device_user_idx ON usage_device (user_id) WHERE user_id IS NOT NULL;

-- Naponta eszközönként egy sor: aktív felhasználók (DAU/WAU/MAU), visszatérés,
-- nézetenkénti használat (views: {"map": 4, "timetable": 2, …}).
CREATE TABLE IF NOT EXISTS usage_day (
  day       date        NOT NULL,
  device_id text        NOT NULL,
  first_at  timestamptz NOT NULL,
  last_at   timestamptz NOT NULL,
  hits      int         NOT NULL DEFAULT 0,
  views     jsonb       NOT NULL DEFAULT '{}',
  PRIMARY KEY (day, device_id)
);
CREATE INDEX IF NOT EXISTS usage_day_device_idx ON usage_day (device_id, day DESC);

-- ── Token-agent parancsok ───────────────────────────────────────────────
-- A hub ide ír; az agent a következő /agent/status-szal (≤30 mp) felveszi,
-- végrehajtja, és /agent/ack-kal jelenti az eredményt.
CREATE TABLE IF NOT EXISTS agent_command (
  id           bigserial PRIMARY KEY,
  agent_id     text,        -- NULL: bármelyik agent veheti
  kind         text        NOT NULL, -- restart-app | send-token | restart-agent
  created_at   timestamptz NOT NULL DEFAULT now(),
  requested_by text,
  picked_at    timestamptz,
  picked_by    text,
  done_at      timestamptz,
  ok           boolean,
  note         text
);
CREATE INDEX IF NOT EXISTS agent_command_open_idx ON agent_command (id) WHERE picked_at IS NULL;

-- ── Műveleti napló ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hub_audit (
  id     bigserial PRIMARY KEY,
  at     timestamptz NOT NULL DEFAULT now(),
  action text        NOT NULL,
  target text,
  ok     boolean     NOT NULL DEFAULT true,
  detail jsonb,
  ip     text
);
CREATE INDEX IF NOT EXISTS hub_audit_at_idx ON hub_audit (at DESC);

-- ── Válaszidő-mérések (a hub 30 mp-enként méri a szolgáltatásokat) ────
CREATE TABLE IF NOT EXISTS hub_probe (
  at     timestamptz NOT NULL,
  target text        NOT NULL,
  ms     int,
  status int         NOT NULL,
  ok     boolean     NOT NULL
);
CREATE INDEX IF NOT EXISTS hub_probe_target_idx ON hub_probe (target, at DESC);
CREATE INDEX IF NOT EXISTS hub_probe_at_idx ON hub_probe (at);
