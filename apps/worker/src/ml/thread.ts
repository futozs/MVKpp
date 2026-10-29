/** A késés-modell tanítása külön szálon (a fő szál közben zavartalanul pollozik és illeszt). */
import { Worker } from "node:worker_threads";
import { log } from "../log.ts";
import type { RunOptions } from "./run.ts";

/** ennyi idő után a tanítást megszakítjuk (nem ragadhat be) */
const TIMEOUT_MS = 25 * 60_000;

let running: Promise<boolean> | null = null;

/** `true`, ha új modell mentődött (elfogadva vagy sem). Egyszerre csak egy fut. */
export function trainDelayModelInThread(opts: Omit<RunOptions, "save" | "log"> = {}): Promise<boolean> {
  if (running) return running;
  running = new Promise<boolean>((resolve) => {
    const w = new Worker(new URL("./trainWorker.ts", import.meta.url), { workerData: opts, resourceLimits: { maxOldGenerationSizeMb: 1536 } });
    let saved = false;
    const timer = setTimeout(() => {
      log.warn("ml", "a tanítás túl sokáig tartott — megszakítva");
      void w.terminate();
    }, TIMEOUT_MS);
    w.on("message", (m: { t: string; m?: string; text?: string; saved?: { id: number; accepted: boolean } | null }) => {
      if (m.t === "log") log.info("ml", m.m ?? "");
      else if (m.t === "error") log.warn("ml", `a tanítás sikertelen: ${m.m}`);
      else if (m.t === "done") {
        saved = Boolean(m.saved);
        log.info("ml", `késés-modell #${m.saved?.id ?? "?"} ${m.saved?.accepted ? "elfogadva" : "nem jobb a képletnél"}\n${m.text}`);
      }
    });
    w.on("error", (e) => log.warn("ml", `a tanító szál hibája: ${e.message}`));
    w.on("exit", () => {
      clearTimeout(timer);
      resolve(saved);
    });
  }).finally(() => {
    running = null;
  });
  return running;
}
