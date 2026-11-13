import type { LiveVehicle } from "@/types";
import { boardVehicle } from "@/components/ride/RideLayer";
import { displayVehicleId } from "@/lib/modes";
import { vehicleDelay } from "./filter/filterState";
import { escapeHtml, safeHex } from "./vehicleIcon";

/** A jármű buborékja (megnyitáskor készül, így mindig a friss adatot mutatja). A 2D és a 3D térkép közös. */
export function vehiclePopupHtml(raw: LiveVehicle, actions = true): string {
  // A feed szövegei HTML-be kerülnek: escape-elve (egy „<” vagy „&” a célállomásban ne törje szét).
  const v = {
    ...raw,
    routeShort: escapeHtml(raw.routeShort ?? ""),
    headsign: escapeHtml(raw.headsign ?? ""),
    id: escapeHtml(raw.id),
    tripId: raw.tripId ? escapeHtml(raw.tripId) : raw.tripId,
    routeColor: safeHex(raw.routeColor, "1FB574"),
    routeText: safeHex(raw.routeText, "FFFFFF"),
  };
  const speed = v.speed != null ? `${Math.round(v.speed * 3.6)} km/h` : null;
  const rail = raw.mode === "rail";
  // vonatnál a vonatszám (és a név), máshol a rendszám — a Volán-azonosító előtag nélkül
  const idTitle = rail ? "Vonat" : "Rendszám";
  const idText = rail ? escapeHtml(`${raw.trainNo ?? ""}${raw.trainName ? ` ${raw.trainName}` : ""}`.trim() || "—") : escapeHtml(displayVehicleId(raw.id, raw.plate));
  const delay = vehicleDelay(raw);
  const mav = raw.delaySec != null && raw.mode !== "bus" && raw.mode !== "tram" ? " (MÁV)" : "";
  const delayMin = delay == null ? 0 : Math.round(Math.abs(delay) / 60);
  const delayLine =
    delay == null
      ? null
      : Math.abs(delay) < 60
        ? { text: `Pontos${mav}`, tone: "--ontime" }
        : delay > 0
          ? { text: `${delayMin} perc késés${mav}`, tone: "--late" }
          : { text: `${delayMin} perccel korábban${mav}`, tone: "--early" };
  const meta = [`${idTitle} ${idText}`, speed, raw.estimated ? "menetrendből becsült helyzet" : null].filter(Boolean).join(" · ");
  const btn =
    "display:block;width:100%;padding:9px 6px;border-radius:9px;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;";
  return `
        <div style="min-width:220px;max-width:260px">
          <div style="display:flex;align-items:center;gap:9px;padding-right:14px">
            <span style="display:inline-flex;flex-shrink:0;align-items:center;justify-content:center;min-width:40px;height:26px;padding:0 8px;border-radius:${rail ? "999px" : "8px"};font-weight:800;font-size:14px;background:#${v.routeColor || "1FB574"};color:#${v.routeText || "FFFFFF"}">${v.routeShort}</span>
            <strong style="font-size:13.5px;line-height:1.25">${v.headsign || "Járat"}</strong>
          </div>
          ${delayLine ? `<div style="margin-top:12px;font-size:17px;font-weight:700;letter-spacing:-0.01em;color:hsl(var(${delayLine.tone}))">${delayLine.text}</div>` : ""}
          <div style="margin-top:${delayLine ? "2px" : "12px"};font-size:12px;color:hsl(var(--muted-foreground));font-variant-numeric:tabular-nums">${meta}</div>
          ${
            v.tripId && actions
              ? `<div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:6px">
                   <button type="button" data-trip="${v.tripId}" data-veh="${v.id}"
                      style="${btn}border:1px solid hsl(var(--border));background:hsl(var(--secondary));color:hsl(var(--foreground))">Követés</button>
                   <button type="button" data-board="${v.tripId}" data-veh="${v.id}"
                      style="${btn}border:0;background:hsl(var(--primary));color:hsl(var(--primary-foreground))">Felszálltam</button>
                 </div>`
              : ""
          }
        </div>
      `;
}

/**
 * A megnyitott buborék gombjai: „Követés” a menetkövetést indítja, „Felszálltam”
 * az utazást (a térkép ezután a buszt követi). `current` a jármű friss adata.
 */
export function wireVehiclePopup(
  el: HTMLElement | null | undefined,
  current: () => LiveVehicle,
  onFocusTrip: (tripId: string, vehicleId?: string) => void,
  close: () => void,
): void {
  const follow = el?.querySelector("[data-trip]");
  follow?.addEventListener("click", (ev) => {
    ev.preventDefault();
    const tId = follow.getAttribute("data-trip");
    const vId = follow.getAttribute("data-veh");
    if (tId) onFocusTrip(tId, vId || undefined);
  });
  const board = el?.querySelector("[data-board]");
  board?.addEventListener("click", (ev) => {
    ev.preventDefault();
    const cur = current();
    if (!cur.tripId) return;
    boardVehicle({ tripId: cur.tripId, vehicleId: cur.id, route: cur.routeShort, color: cur.routeColor, text: cur.routeText, headsign: cur.headsign }, "manual");
    close();
  });
}
