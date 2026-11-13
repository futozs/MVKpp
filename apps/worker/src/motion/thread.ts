/** A mozgás-modell tanítása külön szálon (a fő szál közben zavartalanul pollozik és illeszt). */
import { Worker } from "node:worker_threads";
import { log } from "../log.ts";
import type { MotionRunOptions } from "./run.ts";

/** ennyi idő után a tanítást megszakítjuk (nem ragadhat be) */
const TIMEOUT_MS = 40 * 60_000;

let running: Promise<boolean> | null = null;

/** `true`, ha új, ELFOGADOTT modell mentődött (akkor érdemes újratölteni). Egyszerre csak egy fut. */
export function trainMotionModelInThread(opts: Omit<MotionRunOptions, "save" | "log"> = {}): Promise<boolean> {
  if (running) return running;
  running = new Promise<boolean>((resolve) => {
    const w = new Worker(new URL("./trainWorker.ts", import.meta.url), { workerData: opts, resourceLimits: { maxOldGenerationSizeMb: 2560 } });
    let accepted = false;
    const timer = setTimeout(() => {
      log.warn("motion", "a tanítás túl sokáig tartott  megszakítva");
      void w.terminate();
    }, TIMEOUT_MS);
    w.on("message", (m: { t: string; m?: string; text?: string; saved?: { id: number; accepted: boolean } | null }) => {
      if (m.t === "log") log.info("motion", m.m ?? "");
      else if (m.t === "error") log.warn("motion", `a tanítás sikertelen: ${m.m}`);
      else if (m.t === "done") {
        accepted = Boolean(m.saved?.accepted);
        log.info("motion", `mozgás-modell #${m.saved?.id ?? "?"} ${accepted ? "elfogadva" : "nem él (a régi marad)"}\n${m.text}`);
      }
    });
    w.on("error", (e) => log.warn("motion", `a tanító szál hibája: ${e.message}`));
    w.on("exit", () => {
      clearTimeout(timer);
      resolve(accepted);
    });
  }).finally(() => {
    running = null;
  });
  return running;
}
