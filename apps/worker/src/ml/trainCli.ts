/**
 * Késés-modell tanítása és visszamérése parancssorból:
 *   node --env-file=.env.dev apps/worker/src/ml/trainCli.ts [--save] [--no-legacy] [--days=90] [--test=5]
 */
import { closeDb } from "@mvk/db";
import { runDelayTraining } from "./run.ts";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const t0 = Date.now();
const r = await runDelayTraining({
  save: process.argv.includes("--save"),
  includeLegacy: !process.argv.includes("--no-legacy"),
  days: arg("days") ? Number(arg("days")) : undefined,
  testDays: arg("test") ? Number(arg("test")) : undefined,
  maxTrainRows: arg("rows") ? Number(arg("rows")) : undefined,
  log: (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)} mp] ${m}`),
});
console.log(r.text);
if (r.saved) console.log(`mentve: #${r.saved.id}, ${r.saved.accepted ? "ELFOGADVA" : "nem jobb a képletnél  nem használjuk"}`);
await closeDb();
