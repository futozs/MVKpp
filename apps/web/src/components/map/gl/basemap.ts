/**
 * Az alaptérkép stílusa a saját csempékből: Protomaps-rétegek magyar feliratokkal,
 * a nézet palettájával; 3D-hez épületek és finom domborzat-árnyék (rejtve, a 3D
 * kapcsolja be); a Domborzat nézetnek magassági színezés, szintvonal és csúcsok;
 * a Műholdnak légifotó a feliratok alatt. Csak típusokat importál a maplibre-gl-ből,
 * így teszt is futtathatja.
 */
import { layers as protomapsLayers } from "@protomaps/basemaps";
import type { ExpressionSpecification, FilterSpecification, LayerSpecification, SourceSpecification, StyleSpecification } from "maplibre-gl";
import type { Look } from "./looks";

/** a /tileset.json: melyik csempekészlet él most (a nevük verzió: a csempéik örökre gyorsítótárazhatók) */
export interface Tileset {
  vector: string;
  dem: string;
  /** [nyugat, dél, kelet, észak]  ezen kívül nincs csempe */
  bounds?: [number, number, number, number];
}

export const VECTOR_SOURCE = "protomaps";
export const DEM_SOURCE = "mvk-dem";
const SHADE_SOURCE = "mvk-dem-shade";
const IMAGERY_SOURCE = "mvk-imagery";
const CONTOUR_SOURCE = "mvk-contours";

export const BUILDINGS_3D = "mvk-buildings-3d";
export const HILLSHADE_3D = "mvk-hillshade-3d";
/** a fenti két réteg csak 3D-ben látszik */
export const LAYERS_3D = [BUILDINGS_3D, HILLSHADE_3D] as const;

/** a fontok és ikonok a saját tárhelyről; ha változnak, új verziókönyvtár kell (örökre gyorsítótárazva) */
export const ASSETS_PATH = "/map-assets/v1";
const VECTOR_MAXZOOM = 15;
const DEM_MAXZOOM = 11;
/** az épületek ettől a nagyítástól nőnek ki a földből (3D) */
const BUILDINGS_FROM_Z = 14;
const BUILDINGS_FULL_Z = 15.2;
/** magasság nélküli épület (a legtöbb ilyen): nagyjából kétszintes ház */
const DEFAULT_BUILDING_M = 8;

/** a saját megállóinkat rajzoljuk; a térkép buszmegálló- és állomásikonja csak duplázna */
const HIDDEN_POI_KINDS = ["bus_stop", "station"];

export interface StyleOptions {
  /** a csempék és fontok teljes címe kell (a MapLibre workerében nincs relatív alap) */
  origin: string;
  /** ArcGIS-kulcs a légifotóhoz; nélküle a kulcs nélküli Esri-végpont */
  esriKey?: string;
  /** a szintvonal-csempék címe (maplibre-contour), a Domborzat nézethez */
  contourTiles?: string;
}

export function demTiles(origin: string, ts: Tileset): string {
  return `${origin}/tiles/${ts.dem}/{z}/{x}/{y}.webp`;
}

function demSource(origin: string, ts: Tileset): SourceSpecification {
  return {
    type: "raster-dem",
    tiles: [demTiles(origin, ts)],
    encoding: "terrarium",
    tileSize: 512,
    maxzoom: DEM_MAXZOOM,
    ...(ts.bounds ? { bounds: ts.bounds } : {}),
    attribution: '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener">© Mapterhorn</a>',
  };
}

function imagerySource(esriKey: string | undefined): SourceSpecification {
  const tiles = esriKey
    ? `https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=${encodeURIComponent(esriKey)}`
    : "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  return {
    type: "raster",
    tiles: [tiles],
    tileSize: 256,
    maxzoom: 19,
    attribution: "Esri, Vantor, Earthstar Geographics",
  };
}

function withoutPoiKinds(layer: LayerSpecification, kinds: string[]): LayerSpecification {
  if (layer.id !== "pois" || layer.type !== "symbol") return layer;
  const hide: FilterSpecification = ["!", ["in", ["get", "kind"], ["literal", kinds]]];
  return { ...layer, filter: layer.filter ? ["all", layer.filter as ExpressionSpecification, hide] : hide };
}

function insertBefore(layers: LayerSpecification[], before: (l: LayerSpecification) => boolean, add: LayerSpecification[]): LayerSpecification[] {
  const at = layers.findIndex(before);
  const i = at >= 0 ? at : layers.length;
  return [...layers.slice(0, i), ...add, ...layers.slice(i)];
}

const isSymbol = (l: LayerSpecification) => l.type === "symbol";
/** az utak (alagutak) előtt: a domborzat-árnyék a felszín fölé, az utak alá kerül */
const isFirstRoad = (l: LayerSpecification) => l.id.startsWith("roads_tunnels");

function buildingsLayer(look: Look): LayerSpecification {
  const height: ExpressionSpecification = ["coalesce", ["get", "height"], DEFAULT_BUILDING_M];
  const [low, high] = look.buildings;
  return {
    id: BUILDINGS_3D,
    type: "fill-extrusion",
    source: VECTOR_SOURCE,
    "source-layer": "buildings",
    minzoom: BUILDINGS_FROM_Z,
    filter: ["in", ["get", "kind"], ["literal", ["building", "building_part"]]],
    layout: { visibility: "none" },
    paint: {
      "fill-extrusion-color": ["interpolate", ["linear"], height, 4, low, 40, high],
      // nagyításkor kinőnek a földből
      "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], BUILDINGS_FROM_Z, 0, BUILDINGS_FULL_Z, height],
      "fill-extrusion-base": ["interpolate", ["linear"], ["zoom"], BUILDINGS_FROM_Z, 0, BUILDINGS_FULL_Z, ["coalesce", ["get", "min_height"], 0]],
      "fill-extrusion-opacity": look.satellite ? 0.75 : 0.95,
    },
  };
}

/** A 3D-s finom árnyék: a terep maga nincs megvilágítva, enélkül a hegyek laposnak tűnnek. */
function subtleShade(look: Look): LayerSpecification {
  return {
    id: HILLSHADE_3D,
    type: "hillshade",
    source: SHADE_SOURCE,
    layout: { visibility: "none" },
    paint: {
      "hillshade-method": "igor",
      "hillshade-exaggeration": 0.5,
      // a kamera forgása a gyorsítótárazott terepképbe égne: a fény a térképhez kötött
      "hillshade-illumination-anchor": "map",
      "hillshade-shadow-color": [look.shade.shadow],
      "hillshade-highlight-color": [look.shade.highlight],
    },
  };
}

/** A Domborzat nézet rétegei a felszín fölött, az utak alatt: magassági színezés és többirányú árnyék. */
function topoGround(look: Look): LayerSpecification[] {
  return [
    {
      id: "mvk-relief",
      type: "color-relief",
      source: SHADE_SOURCE,
      paint: {
        "color-relief-opacity": 0.32,
        "color-relief-color": [
          "interpolate",
          ["linear"],
          ["elevation"],
          80,
          "#eef3dc",
          200,
          "#f3edd2",
          400,
          "#e9dab6",
          650,
          "#dac49b",
          950,
          "#c9ad86",
        ],
      },
    },
    {
      id: "mvk-hillshade",
      type: "hillshade",
      source: SHADE_SOURCE,
      paint: {
        "hillshade-method": "multidirectional",
        "hillshade-illumination-anchor": "map",
        "hillshade-illumination-direction": [225, 270, 315, 0],
        "hillshade-illumination-altitude": [40, 40, 40, 40],
        "hillshade-exaggeration": 0.45,
        "hillshade-shadow-color": [look.shade.shadow, look.shade.shadow, look.shade.shadow, look.shade.shadow],
        "hillshade-highlight-color": [look.shade.highlight, look.shade.highlight, look.shade.highlight, look.shade.highlight],
      },
    },
  ];
}

/** Szintvonalak (a feliratok alatt) és a csúcsok magassággal (a feliratok közé). */
function topoLines(): LayerSpecification[] {
  const major: FilterSpecification = [">", ["get", "level"], 0];
  return [
    {
      id: "mvk-contours",
      type: "line",
      source: CONTOUR_SOURCE,
      "source-layer": "contours",
      minzoom: 10,
      paint: {
        "line-color": "rgba(122, 92, 58, 0.55)",
        "line-width": ["case", major, 1, 0.5],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.35, 13, 0.8],
      },
    },
    {
      id: "mvk-contour-labels",
      type: "symbol",
      source: CONTOUR_SOURCE,
      "source-layer": "contours",
      minzoom: 12,
      filter: major,
      layout: {
        "symbol-placement": "line",
        "text-field": ["concat", ["number-format", ["get", "ele"], {}], " m"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 10,
        "text-padding": 12,
      },
      paint: { "text-color": "#8a6b45", "text-halo-color": "rgba(250, 247, 238, 0.9)", "text-halo-width": 1.2 },
    },
  ];
}

function peaksLayer(): LayerSpecification {
  const name: ExpressionSpecification = ["coalesce", ["get", "name:hu"], ["get", "name"], ""];
  return {
    id: "mvk-peaks",
    type: "symbol",
    source: VECTOR_SOURCE,
    "source-layer": "pois",
    minzoom: 13,
    filter: ["all", ["==", ["get", "kind"], "peak"], ["has", "elevation"]],
    layout: {
      "icon-image": "peak",
      "icon-size": 0.8,
      "text-field": ["format", name, { "font-scale": 1 }, "\n", {}, ["concat", ["to-string", ["round", ["get", "elevation"]]], " m"], { "font-scale": 0.85 }],
      "text-font": ["Noto Sans Italic"],
      "text-size": 11,
      "text-offset": [0, 0.9],
      "text-anchor": "top",
      "text-max-width": 8,
    },
    paint: { "text-color": "#5c4a33", "text-halo-color": "rgba(250, 247, 238, 0.95)", "text-halo-width": 1.4 },
  };
}

/** A nézet teljes stílusa. A terep (3D) futás közben kapcsolódik be, a stílus nem hozza magával. */
export function buildStyle(look: Look, ts: Tileset, opts: StyleOptions): StyleSpecification {
  const { origin } = opts;
  const sources: Record<string, SourceSpecification> = {
    [VECTOR_SOURCE]: {
      type: "vector",
      tiles: [`${origin}/tiles/${ts.vector}/{z}/{x}/{y}.mvt`],
      minzoom: 0,
      maxzoom: VECTOR_MAXZOOM,
      ...(ts.bounds ? { bounds: ts.bounds } : {}),
      attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> · <a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a>',
    },
    [DEM_SOURCE]: demSource(origin, ts),
    [SHADE_SOURCE]: demSource(origin, ts),
  };

  const hidden = look.topo ? [...HIDDEN_POI_KINDS, "peak"] : HIDDEN_POI_KINDS;
  let layers = protomapsLayers(VECTOR_SOURCE, look.flavor, { lang: "hu", labelsOnly: look.satellite }).map((l) => withoutPoiKinds(l, hidden));

  if (look.satellite) {
    sources[IMAGERY_SOURCE] = imagerySource(opts.esriKey);
    layers = [{ id: "mvk-imagery", type: "raster", source: IMAGERY_SOURCE, paint: { "raster-fade-duration": 150 } }, ...layers];
  }
  if (look.topo) {
    layers = insertBefore(layers, isFirstRoad, topoGround(look));
    if (opts.contourTiles) {
      sources[CONTOUR_SOURCE] = { type: "vector", tiles: [opts.contourTiles], maxzoom: DEM_MAXZOOM + 1, ...(ts.bounds ? { bounds: ts.bounds } : {}) };
      layers = insertBefore(layers, isSymbol, topoLines());
    }
    layers = [...layers, peaksLayer()];
  } else {
    layers = insertBefore(layers, look.satellite ? isSymbol : isFirstRoad, [subtleShade(look)]);
  }
  // az épületek a feliratok alá: a ház eltakarja az utcát, a nevet nem
  layers = insertBefore(layers, isSymbol, [buildingsLayer(look)]);

  return {
    version: 8,
    glyphs: `${origin}${ASSETS_PATH}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${origin}${ASSETS_PATH}/sprites/${look.sprite}`,
    sources,
    layers,
    light: { anchor: "map", position: [1.4, 210, 35], color: "#ffffff", intensity: look.dark ? 0.3 : 0.4 },
  };
}

/** Az első felirat-réteg: a saját vonalaink ez alá kerülnek (az utcanevek olvashatók maradnak). */
export function firstLabelLayer(style: StyleSpecification): string | undefined {
  return style.layers.find((l) => l.type === "symbol")?.id;
}
