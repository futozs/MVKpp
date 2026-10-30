/** A Next szerver indulásakor egyszer: a hub naplója és a háttérmunkák. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { teeConsole } = await import("./src/server/hublog.ts");
  teeConsole();
  const { configProblems } = await import("./src/server/env.ts");
  for (const p of configProblems()) console.warn(`[hub] ${p}`);
  const { startScheduler } = await import("./src/server/scheduler.ts");
  startScheduler();
}
