/** A teljes tanítási kör: adatok → tanítás → kiértékelés → mentés. A tanító szál és a parancssor is ezt hívja. */
import { serviceClock, shiftIso } from "@mvk/core";
import { buildDataset } from "./dataset.ts";
import { saveBundle } from "./store.ts";
import { formatReport, trainDelayModel, type DelayModelBundle } from "./train.ts";

export type RunOptions = {
  days?: number;
  testDays?: number;
  validDays?: number;
  maxTrainRows?: number;
  includeLegacy?: boolean;
  save?: boolean;
  log?: (m: string) => void;
};

export async function runDelayTraining(o: RunOptions = {}): Promise<{ bundle: DelayModelBundle; saved: { id: number; accepted: boolean } | null; text: string }> {
  const log = o.log ?? (() => {});
  const lastDay = shiftIso(serviceClock().iso, -1);
  const data = await buildDataset({
    lastDay,
    days: o.days ?? 90,
    testDays: o.testDays ?? 5,
    validDays: o.validDays ?? 2,
    maxTrainRows: o.maxTrainRows ?? 700_000,
    includeLegacy: o.includeLegacy ?? true,
    log,
  });
  const bundle = trainDelayModel(data, { log });
  const text = formatReport(bundle);
  const saved = o.save ? await saveBundle(bundle) : null;
  return { bundle, saved, text };
}
