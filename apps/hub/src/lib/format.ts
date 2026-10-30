/** Magyar formázók a hubhoz: méret, időtartam, relatív idő, számok. */
const nf = new Intl.NumberFormat("hu-HU");
const nf1 = new Intl.NumberFormat("hu-HU", { maximumFractionDigits: 1 });

export const num = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : nf.format(n));
export const num1 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : nf1.format(n));
export const pct = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : `${nf1.format(n)}%`);

export function bytes(b: number | null | undefined): string {
  if (b == null || !Number.isFinite(b)) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : nf1.format(v)} ${units[i]}`;
}

/** másodperc → „3 nap 4 ó”, „2 ó 15 p”, „45 mp” */
export function duration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "–";
  const s = Math.abs(Math.round(sec));
  const sign = sec < 0 ? "−" : "";
  if (s < 60) return `${sign}${s} mp`;
  if (s < 3600) return `${sign}${Math.floor(s / 60)} p`;
  if (s < 86400) return `${sign}${Math.floor(s / 3600)} ó ${Math.floor((s % 3600) / 60)} p`;
  return `${sign}${Math.floor(s / 86400)} nap ${Math.floor((s % 86400) / 3600)} ó`;
}

export const ms = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "–" : v >= 10_000 ? `${nf1.format(v / 1000)} s` : `${nf.format(Math.round(v))} ms`);

const toMs = (t: string | number | Date | null | undefined): number | null => {
  if (t == null) return null;
  const v = t instanceof Date ? t.getTime() : typeof t === "number" ? t : Date.parse(t);
  return Number.isFinite(v) ? v : null;
};

/** „most”, „3 perce”, „2 órája”, „5 napja” — jövőre: „3 perc múlva” */
export function ago(t: string | number | Date | null | undefined, now = Date.now()): string {
  const v = toMs(t);
  if (v == null) return "–";
  const d = Math.round((now - v) / 1000);
  const s = Math.abs(d);
  if (s < 45) return d < 0 ? "pillanatokon belül" : "most";
  const [n, past, future] = s < 3600 ? [Math.round(s / 60), "perce", "perc"] : s < 86400 ? [Math.round(s / 3600), "órája", "óra"] : [Math.round(s / 86400), "napja", "nap"];
  return d < 0 ? `${n} ${future} múlva` : `${n} ${past}`;
}

const dtf = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const df = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", year: "numeric", month: "short", day: "numeric" });
const tf = new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const dateTime = (t: string | number | Date | null | undefined) => {
  const v = toMs(t);
  return v == null ? "–" : dtf.format(v);
};
export const date = (t: string | number | Date | null | undefined) => {
  const v = toMs(t);
  return v == null ? "–" : df.format(v);
};
export const clock = (t: string | number | Date | null | undefined) => {
  const v = toMs(t);
  return v == null ? "–" : tf.format(v);
};
export const shortDay = (iso: string) => {
  const [, m, d] = iso.split("-");
  return `${Number(m)}.${Number(d)}.`;
};
