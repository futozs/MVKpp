/**
 * A hőtérképek színskálája (másodpercben mért késés / időveszteség).
 * Divergens: előresietés kék → pontos zöld → sárga → narancs → piros.
 * A végpontok a téma jelentés-színeivel egyeznek (--early, --ontime, --late).
 */

type Hsl = [number, number, number];

const DELAY_STOPS: [number, Hsl][] = [
  [-180, [208, 83, 62]],
  [-30, [170, 45, 34]],
  [45, [153, 52, 40]],
  [120, [52, 88, 52]],
  [240, [30, 92, 54]],
  [420, [9, 86, 56]],
  [720, [0, 82, 40]],
];

/** Időveszteség egy szakaszon (mp): 0 körül zöld, 2 perc felett piros. */
const LOSS_STOPS: [number, Hsl][] = [
  [-45, [208, 83, 62]],
  [0, [153, 52, 40]],
  [25, [70, 70, 46]],
  [50, [45, 90, 52]],
  [90, [25, 92, 54]],
  [150, [9, 86, 56]],
  [240, [0, 82, 40]],
];

function lerp(stops: [number, Hsl][], v: number): Hsl {
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [x1, c1] = stops[i];
    if (v > x1) continue;
    const [x0, c0] = stops[i - 1];
    const t = (v - x0) / (x1 - x0);
    return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
  }
  return stops[stops.length - 1][1];
}

const css = ([h, s, l]: Hsl, a = 1) => `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}% / ${a})`;

export type HeatMetric = "delay" | "gain" | "loss";

export function heatColor(metric: HeatMetric, sec: number, alpha = 1): string {
  return css(lerp(metric === "delay" ? DELAY_STOPS : LOSS_STOPS, sec), alpha);
}

/** A jelmagyarázat lépcsői (mp). */
export const LEGEND: Record<HeatMetric, number[]> = {
  delay: [-120, 0, 60, 180, 300, 600],
  gain: [-30, 0, 30, 60, 120, 210],
  loss: [-30, 0, 30, 60, 120, 210],
};

/** ±m:ss, a pontos (±30 mp) „0” */
export function fmtSec(sec: number | null | undefined): string {
  if (sec == null) return "";
  if (Math.abs(sec) < 30) return "±0";
  const a = Math.abs(Math.round(sec));
  return `${sec > 0 ? "+" : "−"}${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}`;
}

export const hourLabel = (h: number) => `${String(h % 24).padStart(2, "0")}–${String((h + 1) % 24).padStart(2, "0")}`;
