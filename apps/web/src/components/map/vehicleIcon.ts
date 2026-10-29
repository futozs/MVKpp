import L from "leaflet";

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
export function createVehicleIcon(
  routeShort: string,
  color: string | null | undefined,
  textColor: string | null | undefined,
  tracked: boolean,
  idText: string | null,
): L.DivIcon {
  const bg = safeHex(color, FALLBACK_BG);
  const fg = safeHex(textColor, FALLBACK_FG);
  return L.divIcon({
    className: "",
    iconSize: [27, 19],
    iconAnchor: [13, 10],
    html: `
        <div class="mvk-vehicle ${tracked ? "tracked" : ""}">
          <div class="tile" style="background:#${bg};color:#${fg}">${escapeHtml(routeShort)}</div>
          ${idText ? `<div class="vid">${escapeHtml(idText)}</div>` : ""}
        </div>
      `,
  });
}
