/** A mozgás-modell teljes tanítási köre: visszajátszás → profil → sorok → tanítás → kiértékelés → mentés. */
import { finalizeProfile, packProfile, serviceClock, shiftIso, sumProfiles, type ProfileSums } from "@mvk/core";
import { FeedManager } from "../feeds.ts";
import { evalRows, mulberry32, sumsOfDay, trainingRows } from "./dataset.ts";
import { replayDay, type HistoryDay } from "./history.ts";
import { loadMotionBundle, saveMotionBundle } from "./store.ts";
import { formatMotionReport, trainMotionModel, type MotionModelBundle } from "./train.ts";

export type MotionRunOptions = {
  /** ennyi napot játszunk vissza (a legutóbbi teljes naptól visszafelé) */
  days?: number;
  testDays?: number;
  validDays?: number;
  /** az utolsó felhasznált nap (alapból a tegnapi) */
  lastDay?: string;
  /** a fixek ekkora hányada lesz tanító kiindulópont */
  rate?: number;
  save?: boolean;
  log?: (m: string) => void;
};

/** egy nap ennél kevesebb fixszel kiesésnek számít (kimarad) */
const MIN_DAY_FIXES = 20_000;
const MIN_TRAIN_DAYS = 3;
/** a teszten ezekkel a késleltetésekkel mérünk (mp) */
const TEST_LATENCIES = [5, 15];

export async function runMotionTraining(o: MotionRunOptions = {}): Promise<{ bundle: MotionModelBundle; saved: { id: number; accepted: boolean } | null; text: string }> {
  const log = o.log ?? (() => {});
  const testDays = o.testDays ?? 2;
  const validDays = o.validDays ?? 1;
  const lastDay = o.lastDay ?? shiftIso(serviceClock().iso, -1);
  const n = o.days ?? 14;
  const feeds = new FeedManager();
  await feeds.init();

  const days: HistoryDay[] = [];
  for (let k = n - 1; k >= 0; k--) {
    const iso = shiftIso(lastDay, -k);
    const d = await replayDay(feeds, iso);
    const fixes = d.runs.reduce((s, r) => s + r.fixes.length, 0);
    if (fixes < MIN_DAY_FIXES) {
      log(`${iso}: csak ${fixes} fix — kimarad`);
      continue;
    }
    days.push(d);
    log(`${iso}: ${d.runs.length} menet, ${fixes} fix`);
  }
  if (days.length < testDays + validDays + MIN_TRAIN_DAYS) throw new Error(`kevés használható nap (${days.length})`);
  const test = days.slice(days.length - testDays);
  const valid = days.slice(days.length - testDays - validDays, days.length - testDays);
  const train = days.slice(0, days.length - testDays - validDays);

  // A napi összegeket egyenként adjuk hozzá (egy nap ~20 MB — nem tartjuk mind a memóriában).
  let total: ProfileSums | null = null;
  for (const d of train) total = total ? sumProfiles([total, sumsOfDay(d)]) : sumsOfDay(d);
  const rnd = mulberry32(7);
  const rate = o.rate ?? 0.35;
  const trainSet = trainingRows(train, total!, { rate, latencies: 2, rnd });
  const prof = finalizeProfile(total!);
  const validSet = evalRows(valid, prof, { rate, latencies: 2, rnd });
  const testSet = evalRows(test, prof, { rate: 0.5, latencies: TEST_LATENCIES, rnd });
  log(`sorok: tanító ${trainSet.rows}, validációs ${validSet.rows}, teszt ${testSet.rows}`);

  // Élesben a legfrissebb tudás kell: a profil az összes napból.
  let all = total!;
  for (const d of [...valid, ...test]) all = sumProfiles([all, sumsOfDay(d)]);
  const packed = packProfile(finalizeProfile(all));
  days.length = 0;

  const current = await loadMotionBundle().catch(() => null);
  const bundle = trainMotionModel({ train: trainSet, valid: validSet, test: testSet }, packed, current, { log });
  const text = formatMotionReport(bundle);
  const saved = o.save ? await saveMotionBundle(bundle) : null;
  return { bundle, saved, text };
}
