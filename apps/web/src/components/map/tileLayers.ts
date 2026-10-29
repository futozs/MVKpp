/** A térkép választható alaptérképei (a Térkép vezérlő listája). */
export interface TileLayerOption {
  id: string;
  name: string;
  /** rövid név a kis választóhoz */
  short: string;
  note: string;
  url: string;
  labelsUrl?: string;
  attribution: string;
  maxNativeZoom: number;
  swatch: string;
  filter?: string;
}

const OSM_ATTRIB =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> közreműködők';
const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export const TILE_LAYERS: TileLayerOption[] = [
  {
    id: "osm",
    name: "Utcatérkép",
    short: "Utca",
    note: "OpenStreetMap",
    url: OSM_URL,
    attribution: OSM_ATTRIB,
    maxNativeZoom: 19,
    swatch: "#E8E0D8",
  },
  {
    id: "dark",
    name: "Sötét",
    short: "Sötét",
    note: "Sötétített OpenStreetMap",
    url: OSM_URL,
    attribution: OSM_ATTRIB,
    maxNativeZoom: 19,
    swatch: "#20241F",
    filter:
      "invert(1) hue-rotate(180deg) brightness(0.86) contrast(0.92) saturate(0.65)",
  },
  {
    id: "light",
    name: "Halvány",
    short: "Halvány",
    note: "Kifakított OpenStreetMap",
    url: OSM_URL,
    attribution: OSM_ATTRIB,
    maxNativeZoom: 19,
    swatch: "#DEDEDC",
    filter: "grayscale(0.85) brightness(1.06) contrast(0.9)",
  },
  {
    id: "satellite",
    name: "Műhold",
    short: "Műhold",
    note: "Esri World Imagery",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    labelsUrl:
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    attribution:
      '&copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics',
    maxNativeZoom: 19,
    swatch: "#3F5B3C",
  },
  {
    id: "topo",
    name: "Domborzat",
    short: "Terep",
    note: "OpenTopoMap",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution:
      'Csempe: <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), adat: &copy; OpenStreetMap',
    maxNativeZoom: 17,
    swatch: "#CBD3B0",
  },
];
