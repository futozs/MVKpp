/**
 * Egymáshoz közeli jelölők címkéinek függőleges szétosztása: a címkék
 * legalább `gap` távolságra kerülnek egymástól, egy-egy összeérő csoport a
 * valódi helyeinek átlaga köré, és a [min, max] sávon belül marad. Bemenet és
 * kimenet a megadott sorrendben (a valódi y szerint rendezett bemenet kell).
 */
export function spreadLabels(ys: number[], gap: number, min: number, max: number): number[] {
  type Group = { sum: number; n: number; top: number };
  const place = (g: Group) => {
    const span = (g.n - 1) * gap;
    g.top = Math.min(Math.max(g.sum / g.n - span / 2, min), Math.max(min, max - span));
  };
  const groups: Group[] = [];
  for (const y of ys) {
    const g: Group = { sum: y, n: 1, top: y };
    place(g);
    groups.push(g);
    // amíg az új csoport az előzőbe lóg, összevonjuk és újra középre tesszük
    while (groups.length > 1) {
      const last = groups[groups.length - 1];
      const prev = groups[groups.length - 2];
      if (prev.top + prev.n * gap <= last.top) break;
      groups.pop();
      prev.sum += last.sum;
      prev.n += last.n;
      place(prev);
    }
  }
  return groups.flatMap((g) => Array.from({ length: g.n }, (_, i) => g.top + i * gap));
}
