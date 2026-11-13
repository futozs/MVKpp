/**
 * Útvonal-változatok egy vonal egy irányán belül: a leggyakoribb megállósor az
 * alap, a többi menet betűjelet kap, és leírást arról, MIBEN más (melyik
 * megállót érinti még, melyiket hagyja ki, honnan indul, meddig megy)  a
 * menetrendkönyvek „E = … érintésével” jelölése szerint.
 */
export type VariantTrip = { tripId: string; headsign: string; stops: string[] };
export type TripVariant = { code: string; label: string; trips: number };
export type VariantResult = { variants: TripVariant[]; codeOf: Map<string, string> };

type StopName = (stopId: string) => string;

/** „Szondi György utca” → „Szondi György utcáig” (a/e a toldalék előtt megnyúlik). */
export function untilName(name: string): string {
  const n = name.trim();
  if (/[\d.)/]$/.test(n)) return `${n}-ig`;
  if (/a$/.test(n)) return `${n.slice(0, -1)}áig`;
  if (/e$/.test(n)) return `${n.slice(0, -1)}éig`;
  return `${n}ig`;
}

const firstWord = (s: string) => s.trim().split(/[\s/.-]+/)[0]?.toLowerCase() ?? "";

/** A célfelirat azon részei („Centrum - Avas vk. - Avas kilátó”, „… (Egyetem)”), amelyek a másikban nincsenek. */
function extraSegments(headsign: string, other: string): string[] {
  const seg = (h: string) => h.split(/\s+-\s+|\s*[()]\s*/).map((x) => x.trim()).filter(Boolean);
  const theirs = new Set(seg(other).map((x) => x.toLowerCase()));
  return seg(headsign).filter((x) => !theirs.has(x.toLowerCase()));
}

/** A megállók közül az, amelyiket a célfelirat is kiemel (pl. „Avas vk.” → Avas városközpont); ennek híján az első. */
function keyName(names: string[], hints: string[]): string | null {
  if (!names.length) return null;
  for (const h of hints) {
    const w = firstWord(h);
    if (w.length < 3) continue;
    const hit = names.find((n) => {
      const f = firstWord(n);
      return f === w || (Math.min(f.length, w.length) >= 4 && (f.startsWith(w) || w.startsWith(f)));
    });
    if (hit) return hit;
  }
  return names[0];
}

const uniq = (xs: string[]) => [...new Set(xs)];

export function tripVariants(trips: readonly VariantTrip[], nameOf: StopName): VariantResult {
  const groups = new Map<string, { stops: string[]; trips: VariantTrip[] }>();
  for (const t of trips) {
    const key = t.stops.join(">");
    const g = groups.get(key) ?? groups.set(key, { stops: t.stops, trips: [] }).get(key)!;
    g.trips.push(t);
  }
  const list = [...groups.values()].sort((a, b) => b.trips.length - a.trips.length || b.stops.length - a.stops.length);
  const codeOf = new Map<string, string>();
  const variants: TripVariant[] = [];
  if (list.length < 2) return { variants, codeOf };
  const main = list[0];
  const mainSet = new Set(main.stops);
  const mainHead = mostCommon(main.trips.map((t) => t.headsign));
  const used = new Set<string>();

  for (const g of list.slice(1)) {
    const set = new Set(g.stops);
    const head = mostCommon(g.trips.map((t) => t.headsign));
    const common = g.stops.map((s, i) => (mainSet.has(s) ? i : -1)).filter((i) => i >= 0);
    const fc = common[0] ?? -1;
    const lc = common[common.length - 1] ?? -1;
    const parts: string[] = [];
    const keys: string[] = [];

    // eltérő kezdet: más megállóból indul (pl. a kocsiszín felől)
    const startsElsewhere = fc !== 0 && g.stops[0] !== main.stops[0];
    const startsLater = fc === 0 && main.stops.indexOf(g.stops[0]) > 0;
    if (startsElsewhere || startsLater) {
      parts.push(`${nameOf(g.stops[0])} felől indul`);
      keys.push(nameOf(g.stops[0]));
    }
    // kitérő: a közös szakaszon belül érintett plusz megállók
    const detour = fc >= 0 ? uniq(g.stops.slice(fc, lc + 1).filter((s) => !mainSet.has(s)).map(nameOf)) : [];
    if (detour.length) {
      const k = keyName(detour, extraSegments(head, mainHead));
      parts.unshift(`${k} érintésével${detour.length > 1 ? ` (+${detour.length} megálló)` : ""}`);
      if (k) keys.unshift(k);
    }
    // kihagyott megállók a közös szakaszon
    const i0 = fc >= 0 ? main.stops.indexOf(g.stops[fc]) : -1;
    const i1 = lc >= 0 ? main.stops.lastIndexOf(g.stops[lc]) : -1;
    const skipped = i0 >= 0 && i1 >= i0 ? uniq(main.stops.slice(i0, i1 + 1).filter((s) => !set.has(s)).map(nameOf)) : [];
    if (skipped.length) {
      const k = keyName(skipped, extraSegments(mainHead, head));
      parts.push(`${k} nélkül${skipped.length > 1 ? ` (−${skipped.length} megálló)` : ""}`);
      if (k) keys.push(k);
    }
    // eltérő vég: hamarabb véget ér, továbbmegy, vagy máshová megy
    const last = g.stops[g.stops.length - 1];
    const mainLast = main.stops[main.stops.length - 1];
    if (last !== mainLast) {
      const to = untilName(nameOf(last));
      parts.push(mainSet.has(last) ? `csak ${to}` : set.has(mainLast) ? `tovább ${to}` : `${to} megy`);
      keys.push(nameOf(last));
    }
    if (!parts.length) continue;
    const code = pickCode(keys, used);
    used.add(code);
    variants.push({ code, label: parts.join(" · "), trips: g.trips.length });
    for (const t of g.trips) codeOf.set(t.tripId, code);
  }
  return { variants, codeOf };
}

function mostCommon(xs: string[]): string {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

/** Emlékeztető betű: a kulcshelyek kezdőbetűje sorban (ha foglalt, a következő helyé / szóé, végül az ábécé szerint). */
function pickCode(keys: string[], used: Set<string>): string {
  for (const key of keys) {
    const c = key.trim()[0]?.toUpperCase();
    if (c && /\p{L}/u.test(c) && !used.has(c)) return c;
  }
  for (const key of keys) {
    for (const w of key.split(/[\s/.-]+/).filter(Boolean)) {
      const c = w[0]?.toUpperCase();
      if (c && /\p{L}/u.test(c) && !used.has(c)) return c;
    }
  }
  for (const c of "ABCDEFGHIJKLMNOPRSTUVZ") if (!used.has(c)) return c;
  return String(used.size + 1);
}
