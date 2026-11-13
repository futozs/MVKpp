/**
 * A 3D térkép stílusa: OpenFreeMap vektorcsempék (ingyenes, kulcs nélkül, OSM-adat)
 * kihúzott épületekkel, domborzattal (AWS Open Data terepcsempék) és éggel. Az
 * alaptérkép-választó minden elemének van 3D-s párja; a feliratok magyarul.
 * Csak típusokat importál a maplibre-gl-ből, így teszt is futtathatja.
 */
import type { ExpressionSpecification, LayerSpecification, SkySpecification, SourceSpecification, StyleSpecification } from "maplibre-gl";

const OFM_STYLES = "https://tiles.openfreemap.org/styles/";
const TERRAIN_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const ESRI_IMAGERY = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

export const BUILDINGS_LAYER = "mvk-buildings";
const TERRAIN_SOURCE = "mvk-terrain";
const HILLSHADE_SOURCE = "mvk-hillshade";
const IMAGERY_SOURCE = "mvk-imagery";

/** az épületek ettől a nagyítástól nőnek ki a földből, és ennél állnak teljes magasságban */
const BUILDINGS_FROM_Z = 13;
const BUILDINGS_FULL_Z = 14.5;

type BaseStyle = "liberty" | "positron" | "dark";

export interface Theme3D {
  base: BaseStyle;
  /** műholdkép a vektoros alap helyett (a feliratok maradnak) */
  satellite?: boolean;
  hillshade: boolean;
  /** a domborzat nagyítása (1 = valós)  a Bükk és az Avas így jobban kiadja magát */
  exaggeration: number;
  /** az épületek színe alacsonytól magasig */
  buildings: [string, string, string];
  buildingOpacity: number;
  sky: SkySpecification;
}

const LIGHT_SKY: SkySpecification = {
  "sky-color": "#8fc1ec",
  "horizon-color": "#e4edf5",
  "fog-color": "#eef1f2",
  "sky-horizon-blend": 0.6,
  "horizon-fog-blend": 0.5,
  "fog-ground-blend": 0.75,
};

const THEMES: Record<string, Theme3D> = {
  osm: { base: "liberty", hillshade: false, exaggeration: 1.3, buildings: ["hsl(38, 16%, 89%)", "hsl(34, 11%, 81%)", "hsl(30, 9%, 72%)"], buildingOpacity: 0.92, sky: LIGHT_SKY },
  topo: { base: "liberty", hillshade: true, exaggeration: 1.7, buildings: ["hsl(38, 16%, 89%)", "hsl(34, 11%, 81%)", "hsl(30, 9%, 72%)"], buildingOpacity: 0.88, sky: LIGHT_SKY },
  light: {
    base: "positron",
    hillshade: false,
    exaggeration: 1.3,
    buildings: ["hsl(220, 10%, 95%)", "hsl(220, 7%, 88%)", "hsl(220, 6%, 80%)"],
    buildingOpacity: 0.92,
    sky: { ...LIGHT_SKY, "sky-color": "#d5e1ec", "horizon-color": "#f1f3f2", "fog-color": "#f2f3f0" },
  },
  dark: {
    base: "dark",
    hillshade: false,
    exaggeration: 1.3,
    buildings: ["hsl(200, 10%, 16%)", "hsl(200, 12%, 22%)", "hsl(200, 14%, 30%)"],
    buildingOpacity: 0.95,
    sky: { "sky-color": "#0a1422", "horizon-color": "#1d3046", "fog-color": "#0d1013", "sky-horizon-blend": 0.7, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.7 },
  },
  satellite: {
    base: "positron",
    satellite: true,
    hillshade: false,
    exaggeration: 1.4,
    buildings: ["hsl(40, 14%, 86%)", "hsl(36, 10%, 78%)", "hsl(32, 8%, 70%)"],
    buildingOpacity: 0.7,
    sky: { ...LIGHT_SKY, "fog-color": "#c9d3d9" },
  },
};

export function theme3d(tileLayerId: string): Theme3D {
  return THEMES[tileLayerId] ?? THEMES.osm;
}

/** A 2D alaptérkép 3D-s stílusa (letöltés + átalakítás). */
export async function load3DStyle(tileLayerId: string, signal?: AbortSignal): Promise<StyleSpecification> {
  const theme = theme3d(tileLayerId);
  const res = await fetch(`${OFM_STYLES}${theme.base}`, { signal });
  if (!res.ok) throw new Error(`OpenFreeMap stílus: HTTP ${res.status}`);
  return build3DStyle((await res.json()) as StyleSpecification, theme);
}

/** magyar név, ha van; különben a helyi (OSM `name`)  a stílus angol / latin átírást tenne ki */
const HU_NAME: ExpressionSpecification = ["coalesce", ["get", "name:hu"], ["get", "name"]];

function isBuilding(layer: LayerSpecification): boolean {
  return "source-layer" in layer && layer["source-layer"] === "building";
}

function hungarianLabels(layer: LayerSpecification): LayerSpecification {
  if (layer.type !== "symbol" || !layer.layout?.["text-field"]) return layer;
  const field = JSON.stringify(layer.layout["text-field"]);
  if (!field.includes("name:latin") && !field.includes("name_en")) return layer;
  return { ...layer, layout: { ...layer.layout, "text-field": HU_NAME } };
}

/** műholdképen a feliratok világosak, sötét szegéllyel */
function satelliteLabel(layer: LayerSpecification): LayerSpecification {
  if (layer.type !== "symbol") return layer;
  return { ...layer, paint: { ...layer.paint, "text-color": "#ffffff", "text-halo-color": "rgba(0,0,0,0.75)", "text-halo-width": 1.4 } };
}

function buildingsLayer(theme: Theme3D): LayerSpecification {
  const [low, mid, high] = theme.buildings;
  return {
    id: BUILDINGS_LAYER,
    type: "fill-extrusion",
    source: "openmaptiles",
    "source-layer": "building",
    minzoom: BUILDINGS_FROM_Z,
    filter: ["!", ["has", "hide_3d"]],
    paint: {
      "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 0], 0, low, 20, mid, 60, high],
      // nagyításkor kinőnek a földből
      "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], BUILDINGS_FROM_Z, 0, BUILDINGS_FULL_Z, ["coalesce", ["get", "render_height"], 0]],
      "fill-extrusion-base": ["interpolate", ["linear"], ["zoom"], BUILDINGS_FROM_Z, 0, BUILDINGS_FULL_Z, ["coalesce", ["get", "render_min_height"], 0]],
      "fill-extrusion-opacity": theme.buildingOpacity,
    },
  };
}

function hillshadeLayer(): LayerSpecification {
  return {
    id: "mvk-hillshade",
    type: "hillshade",
    source: HILLSHADE_SOURCE,
    paint: { "hillshade-exaggeration": 0.35, "hillshade-shadow-color": "rgba(60,50,40,0.45)", "hillshade-highlight-color": "rgba(255,255,255,0.25)" },
  };
}

function demSource(): SourceSpecification {
  return {
    type: "raster-dem",
    tiles: [TERRAIN_TILES],
    encoding: "terrarium",
    tileSize: 256,
    maxzoom: 15,
    attribution: "Terep: Mapzen, AWS Open Data",
  };
}

/** Az OpenFreeMap stílusa 3D-sítve: saját épületréteg, magyar feliratok, domborzat, ég. */
export function build3DStyle(base: StyleSpecification, theme: Theme3D): StyleSpecification {
  let layers = base.layers.filter((l) => !isBuilding(l)).map(hungarianLabels);
  const sources: Record<string, SourceSpecification> = {
    ...base.sources,
    [TERRAIN_SOURCE]: demSource(),
  };
  if (theme.satellite) {
    sources[IMAGERY_SOURCE] = { type: "raster", tiles: [ESRI_IMAGERY], tileSize: 256, maxzoom: 19, attribution: "© Esri, Maxar, Earthstar Geographics" };
    layers = [{ id: "mvk-imagery", type: "raster", source: IMAGERY_SOURCE }, ...layers.filter((l) => l.type === "symbol").map(satelliteLabel)];
  }
  if (theme.hillshade) {
    sources[HILLSHADE_SOURCE] = demSource();
    // a domborzat árnyéka a felszínborítás fölé, az utak alá
    const roads = layers.findIndex((l) => "source-layer" in l && l["source-layer"] === "transportation");
    const at = roads >= 0 ? roads : layers.length;
    layers = [...layers.slice(0, at), hillshadeLayer(), ...layers.slice(at)];
  }
  // az épületek a feliratok alá kerülnek
  const firstSymbol = layers.findIndex((l) => l.type === "symbol");
  const at = firstSymbol >= 0 ? firstSymbol : layers.length;
  layers = [...layers.slice(0, at), buildingsLayer(theme), ...layers.slice(at)];
  return {
    ...base,
    sources,
    layers,
    terrain: { source: TERRAIN_SOURCE, exaggeration: theme.exaggeration },
    sky: theme.sky,
    light: { anchor: "map", position: [1.4, 210, 35], color: "#ffffff", intensity: 0.4 },
  };
}
