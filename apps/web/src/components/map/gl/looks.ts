/**
 * A térkép választható nézetei (a Térkép vezérlő listája). Mind ugyanazokból a saját
 * vektorcsempékből (Protomaps, OSM-adat) épül; a színeket egy-egy rövid paletta adja,
 * amit a Protomaps-stílus minden elemére szétterítünk. A Sötét az app saját zöldes
 * sötét felületéhez illik, a Halvány csendes háttér, hogy a vonalszínek vigyék a szót.
 * Függőség nélküli (a Protomaps-csomagon kívül), hogy teszt is futtathassa.
 */
import { namedFlavor, type Flavor } from "@protomaps/basemaps";
import type { SkySpecification } from "maplibre-gl";

export type LookId = "light" | "osm" | "dark" | "satellite" | "topo";

export interface Look {
  id: LookId;
  name: string;
  /** rövid név a kis választóhoz */
  short: string;
  note: string;
  /** a választó mintája: háttér és egy jellemző második szín */
  swatch: [string, string];
  /** a Protomaps-sprite neve (ikonok) */
  sprite: "light" | "dark" | "grayscale";
  flavor: Flavor;
  /** műholdkép az alap helyett; a vektorból csak a feliratok maradnak */
  satellite?: boolean;
  /** domborzati nézet: erős árnyékolás, magassági színezés, szintvonalak, csúcsok */
  topo?: boolean;
  dark: boolean;
  /** 3D: az épületek színe alacsonytól magasig */
  buildings: [string, string];
  /** 3D: a domborzat nagyítása (1 = valós)  a Bükk és az Avas így jobban kiadja magát */
  exaggeration: number;
  sky: SkySpecification;
  /** a domborzat árnyéka 3D-ben (a terep maga nincs megvilágítva) */
  shade: { shadow: string; highlight: string };
}

/** Egy nézet színei; ebből lesz a Protomaps-stílus teljes színkészlete. */
interface Palette {
  background: string;
  earth: string;
  water: string;
  park: string;
  parkStrong: string;
  wood: string;
  woodStrong: string;
  landuse: string;
  buildings: string;
  casing: string;
  /** kis utak kis nagyításnál (halványabb) és közelről */
  minorFar: string;
  minor: string;
  major: string;
  highway: string;
  tunnel: string;
  rail: string;
  boundary: string;
  label: string;
  labelMuted: string;
  labelStrong: string;
  labelHalo: string;
}

function flavorFrom(base: Flavor, p: Palette, extra: Partial<Flavor> = {}): Flavor {
  return {
    ...base,
    background: p.background,
    earth: p.earth,
    park_a: p.park,
    park_b: p.parkStrong,
    hospital: p.landuse,
    industrial: p.landuse,
    school: p.landuse,
    wood_a: p.wood,
    wood_b: p.woodStrong,
    pedestrian: p.landuse,
    scrub_a: p.wood,
    scrub_b: p.woodStrong,
    glacier: p.earth,
    sand: p.earth,
    beach: p.earth,
    aerodrome: p.landuse,
    runway: p.minor,
    water: p.water,
    zoo: p.park,
    military: p.landuse,
    tunnel_other_casing: p.casing,
    tunnel_minor_casing: p.casing,
    tunnel_link_casing: p.casing,
    tunnel_major_casing: p.casing,
    tunnel_highway_casing: p.casing,
    tunnel_other: p.tunnel,
    tunnel_minor: p.tunnel,
    tunnel_link: p.tunnel,
    tunnel_major: p.tunnel,
    tunnel_highway: p.tunnel,
    pier: p.minor,
    buildings: p.buildings,
    minor_service_casing: p.casing,
    minor_casing: p.casing,
    link_casing: p.casing,
    major_casing_late: p.casing,
    highway_casing_late: p.casing,
    other: p.minorFar,
    minor_service: p.minorFar,
    minor_a: p.minorFar,
    minor_b: p.minor,
    link: p.major,
    major_casing_early: p.casing,
    major: p.major,
    highway_casing_early: p.casing,
    highway: p.highway,
    railway: p.rail,
    boundaries: p.boundary,
    bridges_other_casing: p.casing,
    bridges_minor_casing: p.casing,
    bridges_link_casing: p.casing,
    bridges_major_casing: p.casing,
    bridges_highway_casing: p.casing,
    bridges_other: p.minorFar,
    bridges_minor: p.minor,
    bridges_link: p.major,
    bridges_major: p.major,
    bridges_highway: p.highway,
    roads_label_minor: p.labelMuted,
    roads_label_minor_halo: p.labelHalo,
    roads_label_major: p.label,
    roads_label_major_halo: p.labelHalo,
    ocean_label: p.label,
    subplace_label: p.labelMuted,
    subplace_label_halo: p.labelHalo,
    city_label: p.labelStrong,
    city_label_halo: p.labelHalo,
    state_label: p.labelMuted,
    state_label_halo: p.labelHalo,
    country_label: p.label,
    address_label: p.labelMuted,
    address_label_halo: p.labelHalo,
    ...extra,
  };
}

const LIGHT_SKY: SkySpecification = {
  "sky-color": "#9cc8ec",
  "horizon-color": "#e6eef4",
  "fog-color": "#eef1f0",
  "sky-horizon-blend": 0.6,
  "horizon-fog-blend": 0.5,
  "fog-ground-blend": 0.8,
};

const DARK_SKY: SkySpecification = {
  "sky-color": "#08121a",
  "horizon-color": "#17282a",
  "fog-color": "#0a0f0d",
  "sky-horizon-blend": 0.7,
  "horizon-fog-blend": 0.6,
  "fog-ground-blend": 0.75,
};

const STREET: Palette = {
  background: "#d9ddd7",
  earth: "#efebe3",
  water: "#a9d3e3",
  park: "#d6e8d2",
  parkStrong: "#b5dab5",
  wood: "#d3e5cd",
  woodStrong: "#aed4a6",
  landuse: "#e9e4db",
  buildings: "#ddd6cb",
  casing: "#d9d2c6",
  minorFar: "#f7f5f0",
  minor: "#ffffff",
  major: "#ffffff",
  highway: "#fffaf0",
  tunnel: "#ebe7df",
  rail: "#a7aeab",
  boundary: "#b3a8b8",
  label: "#6d6862",
  labelMuted: "#8e8882",
  labelStrong: "#36332e",
  labelHalo: "#fbf9f5",
};

const LOOKS: Look[] = [
  {
    id: "light",
    name: "Halvány",
    short: "Halvány",
    note: "Csendes háttér, a vonalak színei dominálnak",
    swatch: ["#eef1ee", "#c4d4da"],
    sprite: "grayscale",
    flavor: flavorFrom(namedFlavor("grayscale"), {
      background: "#dfe3e0",
      earth: "#eef1ee",
      water: "#c6d5db",
      park: "#e3ebe3",
      parkStrong: "#d5e4d7",
      wood: "#e1e9df",
      woodStrong: "#d3e2d1",
      landuse: "#e8ebe8",
      buildings: "#e1e5e2",
      casing: "#d6dcd8",
      minorFar: "#f7f8f7",
      minor: "#ffffff",
      major: "#ffffff",
      highway: "#fbfcfb",
      tunnel: "#e8ebe8",
      rail: "#b7bfbb",
      boundary: "#a7b1ac",
      label: "#78827d",
      labelMuted: "#929b97",
      labelStrong: "#434c48",
      labelHalo: "#f3f5f3",
    }),
    dark: false,
    buildings: ["#eceeec", "#c9cfcb"],
    exaggeration: 1.3,
    sky: { ...LIGHT_SKY, "sky-color": "#d3e0ea", "horizon-color": "#f1f3f2", "fog-color": "#f1f3f1" },
    shade: { shadow: "rgba(60, 72, 68, 0.16)", highlight: "rgba(255, 255, 255, 0.10)" },
  },
  {
    id: "osm",
    name: "Utcatérkép",
    short: "Utca",
    note: "Részletes, színes várostérkép",
    swatch: ["#efebe3", "#b5dab5"],
    sprite: "light",
    flavor: flavorFrom(namedFlavor("light"), STREET),
    dark: false,
    buildings: ["#ebe5dc", "#c2b8aa"],
    exaggeration: 1.3,
    sky: LIGHT_SKY,
    shade: { shadow: "rgba(80, 64, 44, 0.18)", highlight: "rgba(255, 255, 255, 0.12)" },
  },
  {
    id: "dark",
    name: "Sötét",
    short: "Sötét",
    note: "Az app sötét felületéhez hangolva",
    swatch: ["#0f1513", "#2c3733"],
    sprite: "dark",
    flavor: flavorFrom(
      namedFlavor("dark"),
      {
        background: "#070a09",
        earth: "#0f1513",
        water: "#0f1d23",
        park: "#122019",
        parkStrong: "#15291f",
        wood: "#111c16",
        woodStrong: "#13241b",
        landuse: "#121816",
        buildings: "#19201d",
        casing: "#0a0e0d",
        minorFar: "#1a221f",
        minor: "#222b28",
        major: "#2c3733",
        highway: "#39453f",
        tunnel: "#161d1a",
        rail: "#2f3935",
        boundary: "#3f4b46",
        label: "#83938c",
        labelMuted: "#63716b",
        labelStrong: "#c5d1cb",
        labelHalo: "#0a0f0d",
      },
      {
        landcover: {
          barren: "#141816",
          farmland: "#121915",
          forest: "#101d16",
          glacier: "#171c1a",
          grassland: "#111a15",
          scrub: "#131a16",
          urban_area: "#131917",
        },
      },
    ),
    dark: true,
    buildings: ["#1a221f", "#34413b"],
    exaggeration: 1.3,
    sky: DARK_SKY,
    shade: { shadow: "rgba(0, 0, 0, 0.45)", highlight: "rgba(150, 190, 170, 0.06)" },
  },
  {
    id: "satellite",
    name: "Műhold",
    short: "Műhold",
    note: "Légifotó, rajta a nevek",
    swatch: ["#3f5b3c", "#7d7a5c"],
    sprite: "dark",
    flavor: flavorFrom(namedFlavor("dark"), {
      background: "#1b2219",
      earth: "#1b2219",
      water: "#1b2a33",
      park: "#1b2219",
      parkStrong: "#1b2219",
      wood: "#1b2219",
      woodStrong: "#1b2219",
      landuse: "#1b2219",
      buildings: "#1b2219",
      casing: "#000000",
      minorFar: "#ffffff",
      minor: "#ffffff",
      major: "#ffffff",
      highway: "#ffffff",
      tunnel: "#ffffff",
      rail: "#ffffff",
      boundary: "#ffffff",
      label: "#f2f2ec",
      labelMuted: "#e4e4dc",
      labelStrong: "#ffffff",
      labelHalo: "rgba(0, 0, 0, 0.78)",
    }),
    satellite: true,
    dark: true,
    buildings: ["#e9e4da", "#b9b0a2"],
    exaggeration: 1.4,
    sky: { ...LIGHT_SKY, "fog-color": "#c9d3d9" },
    shade: { shadow: "rgba(0, 0, 0, 0.12)", highlight: "rgba(255, 255, 255, 0.04)" },
  },
  {
    id: "topo",
    name: "Domborzat",
    short: "Terep",
    note: "Szintvonalak, csúcsok, árnyékolt hegyek",
    swatch: ["#f1eee4", "#a9cf9a"],
    sprite: "light",
    flavor: flavorFrom(
      namedFlavor("light"),
      { ...STREET, earth: "#f3f0e6", wood: "#cfe4c4", woodStrong: "#a9cf9a", park: "#d6e9cf", parkStrong: "#b6d9ac" },
      {
        landcover: {
          barren: "#f1ead8",
          farmland: "#eef0dc",
          forest: "#cfe3c3",
          glacier: "#ffffff",
          grassland: "#e3eed3",
          scrub: "#e2e9cc",
          urban_area: "#e9e5dc",
        },
      },
    ),
    topo: true,
    dark: false,
    buildings: ["#ebe5dc", "#c2b8aa"],
    exaggeration: 1.5,
    sky: LIGHT_SKY,
    shade: { shadow: "rgba(72, 56, 38, 0.30)", highlight: "rgba(255, 252, 240, 0.25)" },
  },
];

export const MAP_LOOKS: readonly Look[] = LOOKS;

/** Ismeretlen (régi, eltűnt) azonosítóra a Halvány: a régi beállítások is értelmesen nyílnak. */
export function lookById(id: string): Look {
  return LOOKS.find((l) => l.id === id) ?? LOOKS[0];
}
