/**
 * Mozgás-modell tanítása és visszamérése parancssorból:
 *   node --env-file=.env.dev apps/worker/src/motion/trainCli.ts [--save] [--days=14] [--last=2026-10-28] [--rate=0.35]
 */
import { closeDb } from "@mvk/db";
import { runMotionTraining } from "./run.ts";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const t0 = Date.now();
const r = await runMotionTraining({
  save: process.argv.includes("--save"),
  days: arg("days") ? Number(arg("days")) : undefined,
  lastDay: arg("last"),
  rate: arg("rate") ? Number(arg("rate")) : undefined,
  log: (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)} mp] ${m}`),
});
console.log(r.text);
if (r.saved) console.log(`mentve: #${r.saved.id}, ${r.saved.accepted ? "ELFOGADVA" : "nem él — a régi modell marad"}`);
await closeDb();
