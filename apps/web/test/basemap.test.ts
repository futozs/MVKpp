import { describe, expect, it } from "vitest";
import type { LayerSpecification } from "maplibre-gl";
import { BUILDINGS_3D, buildStyle, DEM_SOURCE, firstLabelLayer, HILLSHADE_3D, type Tileset } from "../src/components/map/gl/basemap";
import { lookById, MAP_LOOKS } from "../src/components/map/gl/looks";
import { OVERLAY_SOURCES, overlayLayers } from "../src/components/map/gl/overlays";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

const TS: Tileset = { vector: "mvk-20261124", dem: "dem-20260911", bounds: [19.8, 47.6, 22.3, 48.7] };
const OPTS = { origin: "https://mvk.example" };
const ids = (layers: LayerSpecification[]) => layers.map((l) => l.id);

describe("buildStyle", () => {
  it("serves tiles, glyphs and sprites from our own origin with versioned paths", () => {
    const style = buildStyle(lookById("light"), TS, OPTS);
    const vector = style.sources.protomaps;
    expect(vector.type === "vector" && vector.tiles).toEqual(["https://mvk.example/tiles/mvk-20261124/{z}/{x}/{y}.mvt"]);
    expect(vector.type === "vector" && vector.bounds).toEqual(TS.bounds);
    const dem = style.sources[DEM_SOURCE];
    expect(dem).toMatchObject({ type: "raster-dem", encoding: "terrarium", tileSize: 512, maxzoom: 11 });
    expect(style.glyphs).toBe("https://mvk.example/map-assets/v1/fonts/{fontstack}/{range}.pbf");
    expect(style.sprite).toBe("https://mvk.example/map-assets/v1/sprites/grayscale");
    // a terep futás közben kapcsolódik be (3D), a stílus nem hozza magával
    expect(style.terrain).toBeUndefined();
  });

  it("passes the style-spec validator for every look", () => {
    for (const look of MAP_LOOKS) {
      const errors = validateStyleMin(buildStyle(look, TS, { ...OPTS, contourTiles: "dem-contour://{z}/{x}/{y}" }));
      expect(errors.map((e) => e.message)).toEqual([]);
    }
  });

  it("labels places in Hungarian", () => {
    const style = buildStyle(lookById("osm"), TS, OPTS);
    const place = style.layers.find((l) => l.id === "places_locality");
    expect(JSON.stringify(place?.type === "symbol" && place.layout?.["text-field"])).toContain('"name:hu"');
  });

  it("hides the basemap's own bus stops and stations (the app draws its stops)", () => {
    const pois = buildStyle(lookById("osm"), TS, OPTS).layers.find((l) => l.id === "pois");
    expect(JSON.stringify(pois?.type === "symbol" && pois.filter)).toContain('["!",["in",["get","kind"],["literal",["bus_stop","station"]]]]');
  });

  it("keeps the 3D-only layers hidden and the extruded buildings under the labels", () => {
    for (const look of MAP_LOOKS) {
      const style = buildStyle(look, TS, OPTS);
      const order = ids(style.layers);
      const buildings = style.layers.find((l) => l.id === BUILDINGS_3D);
      expect(buildings?.type).toBe("fill-extrusion");
      expect(buildings?.layout?.visibility).toBe("none");
      expect(order.indexOf(BUILDINGS_3D)).toBeLessThan(order.indexOf(firstLabelLayer(style)!));
      if (!look.topo) expect(style.layers.find((l) => l.id === HILLSHADE_3D)?.layout?.visibility).toBe("none");
    }
  });

  it("shades and colours the terrain map, and draws contours under the labels", () => {
    const style = buildStyle(lookById("topo"), TS, { ...OPTS, contourTiles: "dem-contour://{z}/{x}/{y}" });
    const order = ids(style.layers);
    expect(order).toContain("mvk-hillshade");
    expect(order).toContain("mvk-relief");
    expect(order.indexOf("mvk-hillshade")).toBeLessThan(order.indexOf("roads_minor"));
    expect(order.indexOf("mvk-contours")).toBeLessThan(order.indexOf(firstLabelLayer(style)!));
    expect(order).toContain("mvk-peaks");
  });

  it("puts the imagery under labels only for the satellite map", () => {
    const style = buildStyle(lookById("satellite"), TS, OPTS);
    expect(style.layers[0]).toMatchObject({ id: "mvk-imagery", type: "raster" });
    const vectorFills = style.layers.filter((l) => l.type === "fill" || l.type === "line");
    expect(vectorFills).toHaveLength(0);
  });

  it("falls back to the quiet map for an unknown or retired look id", () => {
    expect(lookById("retired-raster").id).toBe("light");
  });
});

describe("overlayLayers", () => {
  it("are valid on top of every map look (a bad expression would silently drop a layer)", () => {
    const c = { halo: "#090d0c", neutral: "#8a9a92", brand: "#1fb574", mine: "#5aa9f0" };
    const { lines, top } = overlayLayers(c, true, false);
    for (const look of MAP_LOOKS) {
      const base = buildStyle(look, TS, OPTS);
      const sources = { ...base.sources, ...Object.fromEntries(OVERLAY_SOURCES.map((id) => [id, { type: "geojson" as const, data: { type: "FeatureCollection" as const, features: [] } }])) };
      const errors = validateStyleMin({ ...base, sources, layers: [...base.layers, ...lines, ...top] });
      expect(errors.map((e) => e.message)).toEqual([]);
    }
  });
});
