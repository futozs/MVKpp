/** A hírek dátumai budapesti idő szerint, magyarul. */
const TZ = "Europe/Budapest";

const dayFmt = new Intl.DateTimeFormat("hu-HU", { timeZone: TZ, day: "numeric" });
const monthFmt = new Intl.DateTimeFormat("hu-HU", { timeZone: TZ, month: "short" });
const ymdFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const hmFmt = new Intl.DateTimeFormat("hu-HU", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const longDayFmt = new Intl.DateTimeFormat("hu-HU", { timeZone: TZ, month: "long", day: "numeric" });
const yearDayFmt = new Intl.DateTimeFormat("hu-HU", { timeZone: TZ, year: "numeric", month: "long", day: "numeric" });

const DAY_MS = 86_400_000;
const ymd = (ms: number) => ymdFmt.format(ms);

/** A lista dátumcímkéje: „30” / „okt”. */
export function dateTab(unix: number): { day: string; month: string } {
  const ms = unix * 1000;
  return { day: dayFmt.format(ms).replace(/\.$/, ""), month: monthFmt.format(ms).replace(/\.$/, "") };
}

/** „ma 13:34”, „tegnap 10:01”, „október 28. 09:57”; más évben az évvel, idő nélkül. */
export function publishedLabel(unix: number, nowMs = Date.now()): string {
  const ms = unix * 1000;
  const day = ymd(ms);
  const time = hmFmt.format(ms);
  if (day === ymd(nowMs)) return `ma ${time}`;
  if (day === ymd(nowMs - DAY_MS)) return `tegnap ${time}`;
  if (day.slice(0, 4) !== ymd(nowMs).slice(0, 4)) return yearDayFmt.format(ms);
  return `${longDayFmt.format(ms)} ${time}`;
}

/** A csupasz cím rövid alakja a hivatkozás szövegéhez: „mvkzrt.hu/…”. */
export function prettyUrl(href: string): string {
  try {
    const u = new URL(href);
    const host = u.hostname.replace(/^www\./, "");
    return u.pathname.length > 1 || u.search ? `${host}/…` : host;
  } catch {
    return href;
  }
}
