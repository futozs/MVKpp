import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/apiBase";
import { serverNow } from "@/lib/realtime";
import { escapeHtml } from "./vehicleIcon";
import { trafficColor } from "./trafficColor";

/** a forgalom-réteg frissítése (ms) */
const TRAFFIC_POLL_MS = 30_000;

export type TrafficSegment = { from: string; to: string; routes: string[]; path: [number, number][]; ratio: number; excessS: number; n: number; stuck: number; level: number; lastTs: number };

/** Élő forgalom: a most torlódott szakaszok (félpercenként frissül); kikapcsolva üres. */
export function useLiveTraffic(enabled: boolean): TrafficSegment[] {
  const [segments, setSegments] = useState<TrafficSegment[]>([]);
  useEffect(() => {
    setSegments([]);
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/engine/traffic/live`, { cache: "no-store" });
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { segments: TrafficSegment[] };
        if (alive) setSegments(data.segments);
      } catch {
        /* a következő kör újrapróbálja */
      }
    };
    void load();
    const t = setInterval(load, TRAFFIC_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [enabled]);
  return segments;
}

/** A dugó-szakasz buborékja: mennyire lassú, és miből tudjuk. */
export function trafficPopupHtml(seg: TrafficSegment): string {
  const mins = Math.floor(seg.excessS / 60);
  const secs = String(seg.excessS % 60).padStart(2, "0");
  const ago = Math.max(0, Math.round((serverNow() - seg.lastTs) / 60));
  const evidence = [seg.n ? `${seg.n} átért busz` : "", seg.stuck ? `${seg.stuck} most bent ragadt` : ""].filter(Boolean).join(", ");
  const level = seg.level >= 0.75 ? "Beállt" : seg.level >= 0.4 ? "Torlódik" : "Lassul";
  return `
    <div style="min-width:200px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="width:10px;height:10px;border-radius:999px;background:${trafficColor(seg.level)}"></span>
        <strong style="font-size:13px">${level} a forgalom</strong>
      </div>
      <div style="font-size:12.5px;font-weight:600">${escapeHtml(seg.from)} → ${escapeHtml(seg.to)}</div>
      <div style="margin-top:4px;font-size:12px;color:hsl(var(--muted-foreground))">
        <b style="color:hsl(var(--foreground));font-family:var(--font-mono)">${String(seg.ratio).replace(".", ",")}×</b> lassabb a szokásosnál
        (<span style="font-family:var(--font-mono)">+${mins}:${secs}</span>)
      </div>
      <div style="margin-top:4px;font-size:11px;color:hsl(var(--muted-foreground))">${escapeHtml(evidence)} · ${ago ? `${ago} perce` : "most"} · ${escapeHtml(seg.routes.slice(0, 6).join(", "))}</div>
    </div>`;
}
