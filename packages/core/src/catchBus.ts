/**
 * „Elérem?”  gyalog odaérek-e a megállóba, mielőtt a busz odaér.
 *
 * A busz érkezése bizonytalan, és a várhatónál korábban is jöhet. A korai
 * oldal jóval szűkebb, mint a késés felőli (a busz ritkán siet sokat), ezért
 * a „legkorábban” = várható − a felső (85%-os) szórás egy része, legalább
 * fél, legfeljebb két perc. Ehhez képest számolunk: ha addigra ott vagyok,
 * biztosan elérem.
 */

export const CATCH = {
  /** séta (m/s)  kb. 4,7 km/h */
  WALK_MPS: 1.3,
  /** kocogás (m/s) */
  RUN_MPS: 2.7,
  /** a légvonal ennyiszerese az utcákon */
  DETOUR: 1.3,
  /** a felső szórás ennyi része a korai oldal */
  EARLY_SHARE: 0.35,
  EARLY_MIN_S: 30,
  EARLY_MAX_S: 120,
  /** ha nincs felső becslés: ennyivel jöhet korábban */
  EARLY_DEFAULT_S: 45,
  /** ennyivel a busz előtt legyek a megállóban */
  SAFETY_S: 30,
  /** ennyin belül kell elindulni: „indulj most” */
  GO_WINDOW_S: 90,
  /** ennél messzebbről (kb. 25 perc séta) nem a gyaloglás a kérdés */
  MAX_WALK_M: 1500,
} as const;

/** relax: ráérsz · go: indulj most · run: csak futva · missed: ezt lekésed */
export type CatchState = "relax" | "go" | "run" | "missed";

export type CatchVerdict = {
  state: CatchState;
  /** séta a megállóig (mp) */
  walkS: number;
  /** futva (mp) */
  runS: number;
  /** a busz legkorábban várható érkezése (unix) */
  earliestUnix: number;
  /** legkésőbb ekkor indulj el, hogy biztosan elérd (unix) */
  leaveAtUnix: number;
  /** ennyi időd van még elindulni (mp, negatív: már késő a biztoshoz) */
  slackS: number;
};

/** Séta ideje egy légvonalbeli távolságra (mp). */
export function walkSecondsFor(distanceM: number): number {
  return Math.round((Math.max(0, distanceM) * CATCH.DETOUR) / CATCH.WALK_MPS);
}

/** Mennyivel jöhet korábban a busz a várhatónál (mp). */
export function earlySpreadS(expectedUnix: number, upperUnix: number | null | undefined): number {
  if (upperUnix == null || !Number.isFinite(upperUnix)) return CATCH.EARLY_DEFAULT_S;
  const s = Math.max(0, upperUnix - expectedUnix) * CATCH.EARLY_SHARE;
  return Math.round(Math.min(CATCH.EARLY_MAX_S, Math.max(CATCH.EARLY_MIN_S, s)));
}

export function catchVerdict(input: { nowUnix: number; expectedUnix: number; upperUnix?: number | null; walkS: number }): CatchVerdict {
  const { nowUnix, expectedUnix, walkS } = input;
  const earliestUnix = expectedUnix - earlySpreadS(expectedUnix, input.upperUnix);
  const leaveAtUnix = earliestUnix - walkS - CATCH.SAFETY_S;
  const slackS = Math.round(leaveAtUnix - nowUnix);
  const runS = Math.round((walkS * CATCH.WALK_MPS) / CATCH.RUN_MPS);
  const state: CatchState =
    slackS > CATCH.GO_WINDOW_S ? "relax" : nowUnix + walkS <= expectedUnix ? "go" : nowUnix + runS <= expectedUnix ? "run" : "missed";
  return { state, walkS, runS, earliestUnix, leaveAtUnix, slackS };
}
