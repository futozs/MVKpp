-- A szinkron letöltési kurzora a SZERVER írási idejét követi (synced_at), nem a
-- kliens óráját (updated_at). Különben egy offline szerkesztés, vagy egy késő
-- órájú telefon módosítása a többi eszközön soha nem jelent meg: a sor régebbi
-- időbélyeggel érkezett, mint amit azok már letöltöttek. Az updated_at marad a
-- „későbbi szerkesztés nyer” döntéshez.
ALTER TABLE user_state ADD COLUMN IF NOT EXISTS synced_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS user_state_synced_idx ON user_state (user_id, synced_at);
