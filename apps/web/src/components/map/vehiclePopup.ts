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
  const speed = v.speed != null ? `${Math.round(v.speed * 3.6)} km/h` : "—";
  const rail = raw.mode === "rail";
  // vonatnál a vonatszám (és a név), máshol a rendszám — a Volán-azonosító előtag nélkül
  const idTitle = rail ? "Vonat" : "Rendszám";
  const idText = rail ? escapeHtml(`${raw.trainNo ?? ""}${raw.trainName ? ` ${raw.trainName}` : ""}`.trim() || "—") : escapeHtml(displayVehicleId(raw.id, raw.plate));
  const delay = vehicleDelay(raw);
  const delayText =
    delay == null ? null : Math.abs(delay) < 60 ? "pontos" : `${delay > 0 ? "+" : "−"}${Math.round(Math.abs(delay) / 60)} perc${raw.delaySec != null && raw.mode !== "bus" && raw.mode !== "tram" ? " (MÁV)" : ""}`;
  return `
        <div style="min-width:210px">
          <div style="display:flex;align-items:center;gap:9px;margin-bottom:10px">
            <span style="display:inline-flex;align-items:center;justify-content:center;min-width:40px;height:26px;padding:0 8px;border-radius:${rail ? "999px" : "8px"};font-weight:800;font-size:14px;background:#${v.routeColor || "1FB574"};color:#${v.routeText || "FFFFFF"}">${v.routeShort}</span>
            <strong style="font-size:13px">${v.headsign || "Járat"}</strong>
          </div>
          <div style="border-radius:10px;background:hsl(var(--primary)/0.09);border:1px solid hsl(var(--primary)/0.25);padding:9px 11px;margin-bottom:8px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:hsl(var(--muted-foreground))">${idTitle}</div>
            <div style="font-family:var(--font-mono);font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;color:hsl(var(--foreground))">${idText}</div>
          </div>
          <div style="font-family:var(--font-mono);font-size:12px;color:hsl(var(--muted-foreground));display:grid;gap:3px">
            <div>Sebesség <strong style="color:hsl(var(--foreground))">${speed}</strong></div>
            ${delayText ? `<div>Késés <strong style="color:hsl(var(--foreground))">${delayText}</strong></div>` : ""}
            ${raw.estimated ? `<div>Helyzet <strong style="color:hsl(var(--foreground))">menetrendből becsült</strong></div>` : ""}
          </div>
          ${
            v.tripId && actions
              ? `<div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:6px">
                   <a href="#" data-trip="${v.tripId}" data-veh="${v.id}"
                      style="display:block;text-align:center;padding:8px 6px;border-radius:8px;border:1px solid hsl(var(--border));background:hsl(var(--secondary));color:hsl(var(--foreground));font-size:12px;font-weight:700;text-decoration:none">Követés</a>
                   <a href="#" data-board="${v.tripId}" data-veh="${v.id}"
                      style="display:block;text-align:center;padding:8px 6px;border-radius:8px;background:hsl(var(--primary));color:hsl(var(--primary-foreground));font-size:12px;font-weight:700;text-decoration:none">Felszálltam</a>
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
  const follow = el?.querySelector("a[data-trip]");
  follow?.addEventListener("click", (ev) => {
    ev.preventDefault();
    const tId = follow.getAttribute("data-trip");
    const vId = follow.getAttribute("data-veh");
    if (tId) onFocusTrip(tId, vId || undefined);
  });
  const board = el?.querySelector("a[data-board]");
  board?.addEventListener("click", (ev) => {
    ev.preventDefault();
    const cur = current();
    if (!cur.tripId) return;
    boardVehicle({ tripId: cur.tripId, vehicleId: cur.id, route: cur.routeShort, color: cur.routeColor, text: cur.routeText, headsign: cur.headsign }, "manual");
    close();
  });
}
