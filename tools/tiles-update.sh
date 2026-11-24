#!/usr/bin/env bash
#
# A térkép saját csempéi: a legfrissebb Protomaps-alaptérkép (OSM-adat) és a Mapterhorn-
# domborzat kivágata a data/tiles alá, PMTiles-archívumként. A `tiles` konténer (go-pmtiles)
# szolgálja ki őket, a /tileset.json a data/tiles/current.json alapján mondja meg a böngészőnek,
# melyik készlet él. A csempék címében a készlet neve van, ezért örökre gyorsítótárazhatók;
# frissítéskor új név, új cím  a régi archívum egy körig még megmarad (offline kliensek).
#
#   tools/tiles-update.sh            # havonta (cron), a repó gyökeréből
#   TILES_BBOX=19.8,47.6,22.3,48.7 tools/tiles-update.sh   # kisebb terület (pl. fejlesztéshez)
#
# Ha van helyi `pmtiles` (brew install pmtiles), azt használja, különben a Docker-képet.
set -euo pipefail

cd "$(dirname "$0")/.."
DIR="data/tiles"
# Magyarország + a buszos lekérdezési terület (Kassa környéke): a vonatok országosan futnak
BBOX="${TILES_BBOX:-16.1,45.7,22.95,49.05}"
MAXZOOM=15
DEM_MAXZOOM=11
BUILDS="https://build-metadata.protomaps.dev/builds.json"
BUILD_BASE="https://build.protomaps.com"
DEM_URL="https://download.mapterhorn.com/planet.pmtiles"
DEM_NAME="dem-20260911"
IMAGE="protomaps/go-pmtiles:v1.31.2"

mkdir -p "$DIR"

pmtiles() {
  if type -P pmtiles >/dev/null 2>&1; then
    (cd "$DIR" && command pmtiles "$@")
  else
    # a kép distroless és rootként futna: a saját felhasználónkkal, hogy a fájlokat utána mozgathassuk
    docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/$DIR":/data -w /data "$IMAGE" "$@"
  fi
}

current_field() {
  [ -f "$DIR/current.json" ] || return 0
  grep -o "\"$1\": *\"[^\"]*\"" "$DIR/current.json" | sed 's/.*"\([^"]*\)"$/\1/'
}

write_current() {
  local w s e n
  IFS=, read -r w s e n <<<"$BBOX"
  printf '{"vector":"%s","dem":"%s","bounds":[%s,%s,%s,%s]}\n' "$1" "$2" "$w" "$s" "$e" "$n" >"$DIR/.current.json.tmp"
  mv "$DIR/.current.json.tmp" "$DIR/current.json"
}

# A domborzat ritkán változik (a Mapterhorn-bolygó 2026-09-11-es): csak ha még nincs meg.
if [ ! -f "$DIR/$DEM_NAME.pmtiles" ]; then
  echo "domborzat: $DEM_NAME ($BBOX, z0-$DEM_MAXZOOM)"
  pmtiles extract "$DEM_URL" ".tmp-$DEM_NAME.pmtiles" --bbox="$BBOX" --maxzoom="$DEM_MAXZOOM" --download-threads=8
  mv "$DIR/.tmp-$DEM_NAME.pmtiles" "$DIR/$DEM_NAME.pmtiles"
fi

# A legfrissebb 4.x séma szerinti build (a stílusunk erre készült; az 5.x-re váltás kézi munka).
# A buildek nem naponta jönnek, és ~egy hétig maradnak meg: a listából választunk, nem találgatunk.
latest=$(curl -fsS "$BUILDS" | tr '{' '\n' | grep '"version": *"4\.' | grep -o '"key": *"[0-9]*\.pmtiles"' | tail -1 | grep -o '[0-9]*\.pmtiles' || true)
if [ -z "$latest" ]; then
  echo "nincs 4.x Protomaps-build a listában ($BUILDS)" >&2
  exit 1
fi
name="mvk-${latest%.pmtiles}"
current=$(current_field vector)

if [ "$current" = "$name" ] && [ -f "$DIR/$name.pmtiles" ]; then
  echo "alaptérkép naprakész: $name"
  [ "$(current_field dem)" = "$DEM_NAME" ] || write_current "$name" "$DEM_NAME"
  exit 0
fi

echo "alaptérkép: $latest → $name ($BBOX, z0-$MAXZOOM)"
pmtiles extract "$BUILD_BASE/$latest" ".tmp-$name.pmtiles" --bbox="$BBOX" --maxzoom="$MAXZOOM" --download-threads=8
pmtiles verify ".tmp-$name.pmtiles"
mv "$DIR/.tmp-$name.pmtiles" "$DIR/$name.pmtiles"
write_current "$name" "$DEM_NAME"
echo "él: $name"

# A mostani és az előző készlet marad (a régi címen még kérhet egy offline kliens), a régebbiek mennek.
ls -1t "$DIR"/mvk-*.pmtiles | tail -n +3 | while read -r old; do
  echo "törlés: $old"
  rm -f "$old"
done
