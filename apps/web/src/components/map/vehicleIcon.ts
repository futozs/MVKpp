import L from "leaflet";
import type { TransitMode } from "@/types";

/** A GTFS-szín csak hexa lehet — minden más (üres, szemét) a márkazöldre esik. */
const HEX_COLOR = /^[0-9a-f]{3,8}$/i;
const FALLBACK_BG = "1FB574";
const FALLBACK_FG = "FFFFFF";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeHex(color: string | null | undefined, fallback: string): string {
  const raw = (color ?? "").replace(/^#/, "");
  return HEX_COLOR.test(raw) ? raw : fallback;
}

/**
 * A térkép járműcsempéje (`.mvk-vehicle` az index.css-ben). Az élő réteg és
 * az idővonal ugyanezt használja, hogy a visszajátszás pontosan úgy nézzen
 * ki, mint az élő nézet.
 */
/**
 * A mód szerinti csempe: a Volán szögletesebb; a vonat lekerekített, csak a kategóriával
 * („IC”, „Sz”) — a vonatszám a címkében, ha a térkép azonosítókat mutat; a menetrendből
 * becsült helyzet szaggatott.
 */
export type VehicleIconOptions = { mode?: TransitMode; estimated?: boolean };

export function createVehicleIcon(
  routeShort: string,
  color: string | null | undefined,
  textColor: string | null | undefined,
  tracked: boolean,
  idText: string | null,
  opts: VehicleIconOptions = {},
): L.DivIcon {
  const bg = safeHex(color, FALLBACK_BG);
  const fg = safeHex(textColor, FALLBACK_FG);
  const rail = opts.mode === "rail";
  const label = escapeHtml(routeShort);
  const cls = ["mvk-vehicle", tracked ? "tracked" : "", opts.mode === "coach" ? "coach" : "", rail ? "rail" : "", opts.estimated ? "estimated" : ""].filter(Boolean).join(" ");
  return L.divIcon({
    className: "",
    iconSize: [27, 19],
    iconAnchor: [13, 10],
    html: `
        <div class="${cls}">
          <div class="tile" style="background:#${bg};color:#${fg}">${label}</div>
          ${idText ? `<div class="vid">${escapeHtml(idText)}</div>` : ""}
        </div>
      `,
  });
}
