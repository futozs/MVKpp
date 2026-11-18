import type { BoardSnapshot, BoardVehicle } from "@mvk/core";

/** egész perc, előjellel: „+7 perc”, „−3 perc” */
export function minutesText(sec: number): string {
  const m = Math.max(1, Math.round(Math.abs(sec) / 60));
  return `${sec < 0 ? "−" : "+"}${m} perc`;
}

/** perc:mp, előjellel: „+6:51” (a rangsor pontos értéke) */
export function clockText(sec: number): string {
  const a = Math.abs(Math.round(sec));
  return `${sec < 0 ? "−" : "+"}${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}`;
}

/** Hol jár most a jármű, egy sorban. */
export function whereText(v: BoardVehicle): string {
  if (!v.at) return v.stopsDone <= 1 ? "Még a kiinduló megállóban" : "A végállomásnál";
  if (!v.at.from) return `${v.at.to} felé indul`;
  return `${v.at.from} → ${v.at.to}`;
}

export type Cause = { tone: "late" | "jam" | "early" | "muted"; text: string };

/**
 * Honnan jön a késés (vagy a sietés): késve / korán indult, és hol szedte fel
 * útközben. Mindkettő igaz lehet, ezért lista.
 */
export function causes(v: BoardVehicle): Cause[] {
  const out: Cause[] = [];
  const start = v.startDelayS ?? 0;
  if (start >= 120) out.push({ tone: "late", text: `Késve indult, ${minutesText(start)}` });
  else if (start <= -60) out.push({ tone: "early", text: `Korán indult, ${minutesText(start)}` });
  const p = v.pickup;
  if (p) {
    const where = p.from === p.to ? p.from : `${p.from} → ${p.to}`;
    const jam = p.jam ? ", dugóban" : "";
    out.push({ tone: p.jam ? "jam" : "late", text: p.ongoing ? `Most veszít időt: ${where}, ${minutesText(p.gainS)}${jam}` : `Itt szedte fel: ${where}, ${minutesText(p.gainS)}${jam}` });
  }
  if (!out.length && v.delayS >= 180) out.push({ tone: "muted", text: "Apránként gyűlt össze, nem egy helyen" });
  return out;
}

type Status = { tone: "ok" | "warn" | "bad" | "off"; title: string; detail: string };

export function tramStatus(t: BoardSnapshot["tram"]): Status {
  const where = t.stalled
    .slice(0, 3)
    .map((s) => `${s.at} (${Math.round(s.stallS / 60)} perce)`)
    .join(", ");
  const repl = `${t.replacementRunning} pótlóbusz úton, ${t.replacementPlanned ? "a mai menetrend szerint" : "a mai menetrendben nem szerepelt"}`;
  switch (t.state) {
    case "halted":
      return { tone: "bad", title: "Áll a villamosforgalom", detail: `${t.stalled.length} szerelvény nem mozdul: ${where}.${t.replacementRunning ? ` ${repl}.` : ""}` };
    case "replaced":
      return { tone: "bad", title: "Villamospótló busz jár", detail: `${repl}. ${t.running ? `${t.running} villamos közlekedik.` : "Villamos most nem közlekedik."}` };
    case "thin":
      return { tone: "warn", title: "Kevés villamos jár", detail: `${t.running} van úton, a menetrend szerint ${t.scheduled} kellene.` };
    case "late":
      return {
        tone: "warn",
        title: "Akadozik a villamos",
        detail: t.stalled.length ? `Hosszan áll: ${where}.` : `A villamosok jellemzően ${minutesText(t.medianDelayS ?? 0)} késéssel járnak.`,
      };
    case "off":
      return { tone: "off", title: "Most nem jár villamos", detail: "A menetrend szerint egy villamos sincs úton." };
    default:
      return {
        tone: "ok",
        title: "Rendben jár a villamos",
        detail: `${t.running} szerelvény úton${t.medianDelayS != null && Math.abs(t.medianDelayS) >= 60 ? `, jellemzően ${minutesText(t.medianDelayS)}` : ", menetrend szerint"}.`,
      };
  }
}

export function busStatus(b: BoardSnapshot["bus"]): Status {
  const late = `${b.running} busz úton, ${b.late} késik 5 percnél többet`;
  switch (b.state) {
    case "collapsed":
      return { tone: "bad", title: "Beállt a gerinchálózat", detail: `${late}. Több fő útvonalon áll a forgalom.` };
    case "jammed":
      return { tone: "bad", title: "Torlódik a gerinc", detail: `${late}.` };
    case "slow":
      return { tone: "warn", title: "Lassul a forgalom", detail: `${late}.` };
    default:
      return b.running
        ? { tone: "ok", title: "Rendben halad a busz", detail: `${b.running} busz úton, ${b.late ? `${b.late} késik 5 percnél többet` : "egyik sem késik 5 percnél többet"}.` }
        : { tone: "off", title: "Most nem jár busz", detail: "Egy busz sincs úton." };
  }
}
