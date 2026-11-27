import type { AdventNow, DayVerdict, TripVerdict } from "@mvk/core/advent/day";
import { hmOfUnix } from "@mvk/core/time";

export const hm = (unix: number | null | undefined) => (unix == null ? "–" : hmOfUnix(unix));

/** késés percben, előjellel: „+3”, „−2”, „0” */
export function signedMin(s: number | null | undefined): string {
  if (s == null) return "–";
  const m = Math.round(s / 60);
  if (m === 0) return "0";
  return m > 0 ? `+${m}` : `−${Math.abs(m)}`;
}

/** a késés színe a megszokott jelentéssel: piros késik, kék siet, zöld pontos */
export function delayTone(s: number | null | undefined): string {
  if (s == null) return "text-muted-foreground";
  if (s >= 300) return "text-late";
  if (s >= 120) return "text-nosignal";
  if (s <= -60) return "text-early";
  return "text-ontime";
}

export const km = (m: number) =>
  (m / 1000).toLocaleString("hu-HU", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  });

export const TONE_BOX: Record<AdventNow["tone"], string> = {
  live: "border-advent-gold/45 bg-advent-gold/[0.09]",
  ok: "border-border bg-card",
  off: "border-border bg-card",
  warn: "border-nosignal/45 bg-nosignal/[0.08]",
  bad: "border-late/55 bg-late/10",
};
export const TONE_TEXT: Record<AdventNow["tone"], string> = {
  live: "text-advent-gold",
  ok: "text-foreground",
  off: "text-muted-foreground",
  warn: "text-nosignal",
  bad: "text-late",
};

export const TRIP_LABEL: Record<TripVerdict, string> = {
  done: "kész",
  running: "úton",
  turned: "rövidített",
  lost: "jel nélkül",
  upcoming: "",
  due: "indul",
  late_dep: "késik",
  not_departed: "nem indult",
  missed: "elmaradt",
  no_data: "nincs adat",
  cancelled: "törölve",
};

export const VERDICT: Record<DayVerdict, { label: string; cell: string; dot: string }> = {
  future: {
    label: "Lesz",
    cell: "border-border/60 bg-transparent text-muted-foreground",
    dot: "bg-muted-foreground/30",
  },
  none: {
    label: "Nem jár",
    cell: "border-border/40 bg-transparent text-muted-foreground/60",
    dot: "bg-transparent",
  },
  live: {
    label: "Ma",
    cell: "border-advent-gold bg-advent-gold/15 text-advent-ink",
    dot: "bg-advent-gold",
  },
  perfect: {
    label: "Hibátlan",
    cell: "border-advent-gold/50 bg-advent-gold/25 text-advent-ink",
    dot: "bg-advent-gold",
  },
  ok: {
    label: "Rendben",
    cell: "border-ontime/40 bg-ontime/15 text-foreground",
    dot: "bg-ontime",
  },
  late: {
    label: "Késős",
    cell: "border-nosignal/45 bg-nosignal/15 text-foreground",
    dot: "bg-nosignal",
  },
  partial: {
    label: "Félbemaradt",
    cell: "border-late/45 bg-late/15 text-foreground",
    dot: "bg-late",
  },
  down: {
    label: "Lerobbant",
    cell: "border-late bg-late/30 text-foreground",
    dot: "bg-late",
  },
  nodata: {
    label: "Nincs adat",
    cell: "border-border bg-muted/40 text-muted-foreground",
    dot: "bg-muted-foreground",
  },
};

/** „2026-12-06” → „dec. 6.” */
export function shortDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  const months = ["jan.", "febr.", "márc.", "ápr.", "máj.", "jún.", "júl.", "aug.", "szept.", "okt.", "nov.", "dec."];
  return `${months[m - 1]} ${d}.`;
}

const DOW = ["H", "K", "Sze", "Cs", "P", "Szo", "V"];
export function dowShort(iso: string): string {
  const js = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return DOW[(js + 6) % 7];
}

/** „T1022” → „10:22” */
export const slotTime = (key: string) => `${key.slice(1, 3)}:${key.slice(3, 5)}`;
