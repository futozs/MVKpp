import type { BoardSnapshot, BoardVehicle, TramVerdict } from "@mvk/core";
import { withHungarianSuffix } from "@/lib/utils";

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

/** határozott névelő a név elé: „a Tiszai”, „az Újgyőri” */
const article = (name: string) => (/^[aáeéiíoóöőuúüű]/i.test(name) ? "Az" : "A");

/** „a 609-es”, „az 501-es”: névelő és toldalék a pályaszám elé-mögé */
export function vehicleRef(id: string): string {
  return `${/^[15]/.test(id) ? "az" : "a"} ${withHungarianSuffix(id)}`;
}

const cap = (s: string) => `${s[0]?.toUpperCase() ?? ""}${s.slice(1)}`;
const between = (a: string, b: string) => (a === b ? `${a} megállónál` : `${a} és ${b} között`);

/** Mi történik a villamosvonalon: a vonal-elemző következtetése mondatokban. */
export function verdictText(v: TramVerdict): { title: string; text: string } {
  switch (v.kind) {
    case "whole-line":
      return {
        title: "Az egész vonal áll",
        text: "Mindkét irányban, sok helyen egyszerre állnak a villamosok. Ez áramkimaradásra vagy felsővezeték-hibára utal, nem egy helyi akadályra.",
      };
    case "both-ways":
      return v.samePlace
        ? {
            title: "Mindkét irány ugyanott áll",
            text: `${v.places[0]} környékén mindkét oldalon feltorlódtak a villamosok. Ez a pályát mindkét irányban elzáró akadályra utal: baleset, a síneken álló jármű, vagy felsővezeték-hiba.`,
          }
        : {
            title: "Mindkét irányban áll egy-egy sor",
            text: `Más-más helyen: ${v.places.join(", ")}. Két külön akadály, vagy egy nagyobb forgalmi zavar.`,
          };
    case "one-way": {
      const head = vehicleRef(v.head);
      const other = v.otherOk && v.otherToward ? ` A másik irány (${v.otherToward} felé) halad, a baj csak a ${v.toward} felé tartó oldalon van.` : "";
      return {
        title: `Áll a sor ${v.toward} felé`,
        text: `${cap(head)} villamos áll elöl ${between(v.fromStop, v.toStop)}, ${Math.max(1, Math.round(v.sinceS / 60))} perce${v.behind ? `; mögötte ${v.behind} villamos rekedt` : ""}. Vagy ő hibásodott meg, vagy közvetlenül előtte van az akadály: baleset, a síneken álló autó, pályahiba.${other}`,
      };
    }
    case "queue":
      return {
        title: `Torlódnak a villamosok ${v.toward} felé`,
        text: `${cap(between(v.fromStop, v.toStop))} lassan, egymás után araszolnak, elöl ${vehicleRef(v.head)}. Ez torlódásra utal a pályán (forgalmas kereszteződés, dugó a közúttal közös szakaszon), nem teljes leállásra.`,
      };
    default:
      return { title: "Halad a vonal", text: "Egyik irányban sem áll sor, a villamosok mennek." };
  }
}

type Status = { tone: "ok" | "warn" | "bad" | "off"; title: string; detail: string };

export function tramStatus(t: BoardSnapshot["tram"]): Status {
  const where = t.stalled
    .slice(0, 3)
    .map((s) => `${s.at} (${Math.round(s.stallS / 60)} perce)`)
    .join(", ");
  const repl = `${t.replacementRunning} pótlóbusz úton, ${t.replacementPlanned ? "a menetrend szerint" : "a mai menetrendben nem szerepelt"}`;
  const span = t.trouble ? (t.trouble.from === t.trouble.to ? t.trouble.from : `${t.trouble.from} és ${t.trouble.to} között`) : null;
  const zone = t.trouble ? ` ${article(t.trouble.toward)} ${t.trouble.toward} felé tartók ${span} szedték fel a késést.` : "";
  const worst = t.maxDelayS != null && t.maxDelayS >= 60 ? ` A legnagyobb késés ${minutesText(t.maxDelayS)}.` : "";
  switch (t.state) {
    case "halted": {
      const v = t.analysis.verdict;
      const lead =
        v.kind === "one-way"
          ? `${cap(vehicleRef(v.head))} villamos áll elöl ${between(v.fromStop, v.toStop)}${v.behind ? `, mögötte ${v.behind} villamos` : ""}, ${v.toward} felé.`
          : v.kind === "ok" || v.kind === "queue"
            ? `${t.stalled.length} szerelvény nem halad: ${where}.`
            : verdictText(v).text;
      return { tone: "bad", title: "Áll a villamosforgalom", detail: `${lead}${t.replacementRunning ? ` ${repl}.` : ""}` };
    }
    case "collapsed": {
      // ha már minden villamos halad, a zavar elmúlt: a késés maradt meg
      const moving = t.analysis.verdict.kind === "ok";
      return {
        tone: "bad",
        title: moving ? "Nagy késésekkel jár a villamos" : "Összeomlott a villamosközlekedés",
        detail: `${t.severe} villamos késik 10 percnél többet, ${t.late} legalább 5 percet.${zone}${worst}${moving ? " Most már minden villamos halad, a késés a korábbi zavarból maradt." : ""}${t.replacementRunning ? ` ${repl}.` : ""}`,
      };
    }
    case "replaced":
      return { tone: "bad", title: "Villamospótló busz jár", detail: `${repl}. ${t.running ? `${t.running} villamos közlekedik.` : "Villamos most nem közlekedik."}` };
    case "thin":
      return { tone: "warn", title: "Kevés villamos jár", detail: `${t.running} van úton, a menetrend szerint ${t.scheduled} kellene.` };
    case "late":
      return {
        tone: "warn",
        title: "Akadozik a villamos",
        detail: t.stalled.length
          ? `Hosszan áll: ${where}.`
          : `${t.late ? `${t.late} villamos késik legalább 5 percet.` : `Egy villamos rendkívül késik.`}${zone}${worst}`,
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
