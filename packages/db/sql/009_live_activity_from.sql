-- Az iOS-utazás Live Activity-je: a felszállás megállója is, hogy a haladás és a
-- hátralévő megállók a felszállástól a leszállóhelyig számítsanak, ahogy az app mutatja.
ALTER TABLE live_activity_token ADD COLUMN IF NOT EXISTS from_stop_id text;
