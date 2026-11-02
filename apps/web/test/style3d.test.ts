import { describe, expect, it } from "vitest";
import type { StyleSpecification } from "maplibre-gl";
import { BUILDINGS_LAYER, build3DStyle, theme3d } from "../src/components/map/map3d/style3d";

/** egy OpenFreeMap-stílus lényeges részei (a valódiból kivonatolva) */
function baseStyle(): StyleSpecification {
  return {
    version: 8,
    sources: { openmaptiles: { type: "vector", url: "https://tiles.openfreemap.org/planet" } },
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#f8f4f0" } },
      { id: "landuse", type: "fill", source: "openmaptiles", "source-layer": "landuse" },
      { id: "road", type: "line", source: "openmaptiles", "source-layer": "transportation" },
      { id: "building", type: "fill", source: "openmaptiles", "source-layer": "building" },
      { id: "building-3d", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building" },
      {
        id: "place",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "place",
        layout: { "text-field": ["case", ["has", "name:nonlatin"], ["get", "name:latin"], ["coalesce", ["get", "name_en"], ["get", "name"]]] },
      },
      { id: "shield", type: "symbol", source: "openmaptiles", "source-layer": "transportation_name", layout: { "text-field": ["get", "ref"] } },
    ],
  };
}

describe("build3DStyle", () => {
  it("replaces the style's buildings with one extrusion layer below the labels", () => {
    const style = build3DStyle(baseStyle(), theme3d("osm"));
    const ids = style.layers.map((l) => l.id);
    expect(ids).not.toContain("building");
    expect(ids).not.toContain("building-3d");
    expect(ids.indexOf(BUILDINGS_LAYER)).toBe(ids.indexOf("place") - 1);
    expect(style.layers.find((l) => l.id === BUILDINGS_LAYER)?.type).toBe("fill-extrusion");
  });

  it("shows Hungarian names but leaves route shields alone", () => {
    const style = build3DStyle(baseStyle(), theme3d("osm"));
    const place = style.layers.find((l) => l.id === "place");
    const shield = style.layers.find((l) => l.id === "shield");
    expect(place?.type === "symbol" && place.layout?.["text-field"]).toEqual(["coalesce", ["get", "name:hu"], ["get", "name"]]);
    expect(shield?.type === "symbol" && shield.layout?.["text-field"]).toEqual(["get", "ref"]);
  });

  it("adds terrain, sky and a map-anchored light", () => {
    const style = build3DStyle(baseStyle(), theme3d("dark"));
    expect(style.terrain?.source).toBeDefined();
    expect(style.sources[style.terrain!.source]).toMatchObject({ type: "raster-dem", encoding: "terrarium" });
    expect(style.sky?.["sky-color"]).toBeDefined();
    expect(style.light?.anchor).toBe("map");
  });

  it("puts hillshade under the roads for the terrain map", () => {
    const ids = build3DStyle(baseStyle(), theme3d("topo")).layers.map((l) => l.id);
    expect(ids.indexOf("mvk-hillshade")).toBe(ids.indexOf("road") - 1);
  });

  it("keeps only labels over the imagery for the satellite map", () => {
    const style = build3DStyle(baseStyle(), theme3d("satellite"));
    expect(style.layers[0].id).toBe("mvk-imagery");
    const types = new Set(style.layers.slice(1).map((l) => l.type));
    expect([...types].sort()).toEqual(["fill-extrusion", "symbol"]);
  });

  it("falls back to the street theme for an unknown base map", () => {
    expect(theme3d("nope")).toBe(theme3d("osm"));
  });
});
