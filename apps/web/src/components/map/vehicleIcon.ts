import type { LiveVehicle, TransitMode } from "@/types";
import { displayVehicleId } from "@/lib/modes";

/** A GTFS-szín csak hexa lehet  minden más (üres, szemét) a márkazöldre esik. */
const HEX_COLOR = /^[0-9a-f]{3,8}$/i;

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

/** A csempe alatti címke: vonatnál a vonatszám (a csempén csak a kategória), máshol a rendszám. */
export function vehicleIdText(v: Pick<LiveVehicle, "id" | "plate" | "trainNo" | "trainName">, mode: TransitMode | undefined): string | null {
  return mode === "rail" ? (v.trainNo ?? v.trainName ?? null) : displayVehicleId(v.id, v.plate);
}
