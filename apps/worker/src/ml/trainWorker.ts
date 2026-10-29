/** A tanító szál belépési pontja: a teljes kör itt fut, hogy az élő motor ne akadjon meg közben. */
import { parentPort, workerData } from "node:worker_threads";
import { closeDb } from "@mvk/db";
import { runDelayTraining, type RunOptions } from "./run.ts";

const opts = (workerData ?? {}) as RunOptions;
try {
  const r = await runDelayTraining({ ...opts, save: true, log: (m) => parentPort?.postMessage({ t: "log", m }) });
  parentPort?.postMessage({ t: "done", text: r.text, saved: r.saved });
} catch (e) {
  parentPort?.postMessage({ t: "error", m: e instanceof Error ? e.message : String(e) });
} finally {
  await closeDb().catch(() => {});
}
