-- Tanított modellek (most: a késés-előrejelző). A worker éjszakánként újratanít,
-- és csak az elfogadott (a mostani képletnél bizonyítottan jobb) modellt tölti be.
CREATE TABLE IF NOT EXISTS ml_model (
  id         bigserial   PRIMARY KEY,
  name       text        NOT NULL,
  trained_at timestamptz NOT NULL DEFAULT now(),
  accepted   boolean     NOT NULL,
  report     jsonb       NOT NULL,
  model      jsonb       NOT NULL
);
CREATE INDEX IF NOT EXISTS ml_model_name_idx ON ml_model (name, trained_at DESC);
