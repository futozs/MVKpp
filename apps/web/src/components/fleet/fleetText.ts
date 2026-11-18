import type { BoardSnapshot, BoardVehicle, TramVerdict } from "@mvk/core";
import { withHungarianSuffix } from "@/lib/utils";

/** egész perc, előjellel: „+7 perc”, „−3 perc” */
export function minutesText(sec: number): string {
  const m = Math.max(1, Math.round(Math.abs(sec) / 60));
  return `${sec < 0 ? "−" : "+"}${m} perc`;
}

/** rövid perc: „+7 p” (a szűk helyekre) */
export const minShort = (sec: number) => minutesText(sec).replace(" perc", " p");

/** perc:mp, előjellel: „+6:51” (a rangsor pontos értéke) */
export function clockText(sec: number): string {
  const a = Math.abs(Math.round(sec));
  return `${sec < 0 ? "−" : "+"}${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}`;
}

/** Hol jár most a jármű, egy sorban. */
export function whereText(v: BoardVehicle): string {
  if (!v.at) return v.stopsDone <= 1 ? "a kiinduló megállóban" : "a végállomásnál";
  if (!v.at.from) return `${v.at.to} felé indul`;
  return `${v.at.from} → ${v.at.to}`;
}

export type Cause = { tone: "late" | "jam" | "early" | "muted"; text: string };

/**
 * Honnan jön a késés (vagy a sietés), röviden: késve / korán indult, és hol
 * szedte fel útközben. Mindkettő igaz lehet, ezért lista.
 */
export function causes(v: BoardVehicle): Cause[] {
  const out: Cause[] = [];
  const start = v.startDelayS ?? 0;
  if (start >= 120) out.push({ tone: "late", text: `Késve indult ${minShort(start)}` });
  else if (start <= -60) out.push({ tone: "early", text: `Korán indult ${minShort(start)}` });
  const p = v.pickup;
  if (p) {
    const where = p.from === p.to ? p.from : `${p.from} → ${p.to}`;
    out.push({ tone: p.jam ? "jam" : "late", text: `${p.ongoing ? "Most veszít" : "Felszedte"}: ${where} ${minShort(p.gainS)}${p.jam ? " · dugó" : ""}` });
  }
  if (!out.length && v.delayS >= 180) out.push({ tone: "muted", text: "Apránként gyűlt össze" });
  return out;
}

/** „a 609-es”, „az 501-es”: névelő és toldalék a pályaszám elé-mögé */
export function vehicleRef(id: string): string {
  return `${/^[15]/.test(id) ? "az" : "a"} ${withHungarianSuffix(id)}`;
}

const cap = (s: string) => `${s[0]?.toUpperCase() ?? ""}${s.slice(1)}`;
const between = (a: string, b: string) => (a === b ? `${a} megállónál` : `${a} és ${b} között`);

/** Mi történik a villamosvonalon: a vonal-elemző következtetése egy címben és egy-két mondatban. */
export function verdictText(v: TramVerdict): { title: string; text: string } {
  switch (v.kind) {
    case "whole-line":
      return { title: "Az egész vonal áll", text: "Sok helyen egyszerre, mindkét irányban: áramkimaradás vagy felsővezeték-hiba." };
    case "both-ways":
      return v.samePlace
        ? { title: "Mindkét irány áll", text: `${v.places[0]} környékén mindkét oldalon. Pályát elzáró akadály: baleset, a síneken álló jármű vagy felsővezeték-hiba.` }
        : { title: "Két helyen áll sor", text: `Más-más helyen: ${v.places.join(", ")}.` };
    case "one-way":
      return {
        title: `Áll a sor ${v.toward} felé`,
        text: `Elöl ${vehicleRef(v.head)} áll ${Math.max(1, Math.round(v.sinceS / 60))} perce, ${between(v.fromStop, v.toStop)}${v.behind ? `, mögötte ${v.behind} villamos` : ""}. Előtte akadály van, vagy ő hibásodott meg.${v.otherOk ? " A másik irány halad." : ""}`,
      };
    case "queue":
      return {
        title: `Torlódás ${v.toward} felé`,
        text: `${cap(between(v.fromStop, v.toStop))} araszolnak, elöl ${vehicleRef(v.head)}. Nem teljes leállás.`,
      };
    default:
      return { title: "Halad a vonal", text: "" };
  }
}

export type Tone = "ok" | "warn" | "bad" | "off";
export type Tile = { tone: Tone; title: string; sub: string };

/** A villamos állapota egy csempén: egy-két szó és egy rövid számsor. */
export function tramTile(t: BoardSnapshot["tram"]): Tile {
  const v = t.analysis.verdict;
  switch (t.state) {
    case "halted":
      return { tone: "bad", title: "Áll", sub: v.kind === "one-way" ? `elöl ${vehicleRef(v.head)}, ${v.fromStop}` : `${t.stalled.length} szerelvény áll` };
    case "collapsed":
      // ha már minden villamos halad, a zavar elmúlt: a késés maradt meg
      return { tone: "bad", title: v.kind === "ok" ? "Nagy késések" : "Összeomlott", sub: `${t.severe} késik 10+ percet` };
    case "replaced":
      return { tone: "bad", title: "Pótlóbusz jár", sub: `${t.replacementRunning} pótlóbusz${t.replacementPlanned ? ", tervezett" : ", rendkívüli"}` };
    case "thin":
      return { tone: "warn", title: "Kevés jár", sub: `${t.running} a menetrendi ${t.scheduled} helyett` };
    case "late":
      return { tone: "warn", title: "Akadozik", sub: t.late ? `${t.late} késik 5+ percet` : "egy villamos nagyon késik" };
    case "off":
      return { tone: "off", title: "Nem jár", sub: "most nincs menet" };
    default:
      return { tone: "ok", title: "Rendben", sub: `${t.running} úton` };
  }
}

/** A buszhálózat állapota egy csempén. */
export function busTile(b: BoardSnapshot["bus"]): Tile {
  const c = b.corridors[0];
  const late = `${b.late} késik 5+ percet`;
  switch (b.state) {
    case "collapsed":
      return { tone: "bad", title: "Beállt a gerinc", sub: late };
    case "jammed":
      return { tone: "bad", title: "Torlódik", sub: c ? `${c.from} → ${c.to}` : late };
    case "slow":
      return { tone: "warn", title: "Lassul", sub: c ? `${c.from} → ${c.to}` : late };
    default:
      return b.running ? { tone: "ok", title: "Rendben", sub: `${b.running} úton · ${late}` } : { tone: "off", title: "Nem jár", sub: "most nincs menet" };
  }
}
