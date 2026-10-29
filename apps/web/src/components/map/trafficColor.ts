/**
 * A forgalom-réteg színe a torlódás szintjéből (0 … 1): citromsárga (lassul)
 * → narancs → piros → sötétvörös (teljesen beállt).
 */
type Hsl = [number, number, number];
const STOPS: [number, Hsl][] = [
  [0, [56, 100, 60]],
  [0.35, [38, 100, 54]],
  [0.65, [16, 95, 52]],
  [0.85, [2, 88, 46]],
  [1, [-8, 82, 32]],
];

export function trafficColor(level: number): string {
  const v = Math.min(1, Math.max(0, level));
  for (let i = 1; i < STOPS.length; i++) {
    const [x1, c1] = STOPS[i];
    if (v > x1) continue;
    const [x0, c0] = STOPS[i - 1];
    const t = (v - x0) / (x1 - x0);
    const h = c0[0] + (c1[0] - c0[0]) * t;
    return `hsl(${((h % 360) + 360) % 360} ${c0[1] + (c1[1] - c0[1]) * t}% ${c0[2] + (c1[2] - c0[2]) * t}%)`;
  }
  return `hsl(352 82% 32%)`;
}
