/** Az Elkapó (/engine/advent/plan) válasza: hol, mivel és mikor éred el ma a villamost. */

export type CatchLeg =
  | { kind: "walk"; from: string; to: string; dep: number; arr: number; m: number }
  | { kind: "ride"; mode: string; route: string; color: string; text: string; headsign: string; from: string; to: string; dep: number; arr: number; stops: number; delayS: number | null };

/** vissza a felszállás megállójába egy járattal (az adventi villamossal is) */
export type CatchBack = { mode: string; route: string; color: string; text: string; advent: boolean; dep: number; arr: number };

export type CatchRide = { n: number; stop: number; name: string; at: number; back: CatchBack | null };

export type CatchOption = {
  run: string;
  dir: "out" | "back";
  headsign: string;
  live: boolean;
  uncertain: boolean;
  /** a megálló (index a season.stops-ban) és a villamos várható ideje ott */
  stop: number;
  name: string;
  at: number;
  sched: number;
  /** indulj ekkor (gyalog: a legkésőbb), érsz oda ekkor */
  leave: number;
  arrive: number;
  slackS: number;
  walkOnly: boolean;
  /** elébe mész: korábban éred el, mint ha megvárnád */
  chase: boolean;
  legs: CatchLeg[];
  rides: CatchRide[];
};

export type CatchPlan = {
  at: number;
  date: string;
  from: { lat: number; lon: number; name: string };
  /** a villamos élő helyzetéből (különben a menetrendből) */
  live: boolean;
  /** a menetek alapja: a feed ADV-menetei vagy a plakát */
  source: "feed" | "poster";
  runsLeft: number;
  options: CatchOption[];
};
