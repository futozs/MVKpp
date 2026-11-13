-- Értesítés-fajták egy táblában: a régi „érkezik a busz” mellé
--   leave     „indulj most”: a sétaidővel együtt (params.walkS), egy menetre vagy naponta
--   traffic   dugó a figyelt megállóhoz tartó busz előtt
--   transfer  veszélybe került átszállás (params: fromTrip, alightStopId, toTrip, walkS…)
-- A meglévő sorok „arrival” fajtájúak maradnak.
ALTER TABLE push_watch ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'arrival';
ALTER TABLE push_watch ADD COLUMN IF NOT EXISTS params jsonb;
CREATE INDEX IF NOT EXISTS push_watch_kind_idx ON push_watch (kind);
