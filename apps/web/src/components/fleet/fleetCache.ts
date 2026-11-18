import { API_BASE } from "@/lib/apiBase";

/**
 * A Flotta lekéréseinek közös, memóriabeli gyorsítótára: a már látott pillanat,
 * nap vagy lista oda-vissza léptetéskor azonnal kint van. A lezárt múlt nem
 * változik, ezért sokáig, a mai adat csak rövid ideig él. A hibás válasz nem marad bent.
 */
const MAX_ENTRIES = 300;
const store = new Map<string, { exp: number; value: Promise<unknown> }>();

/** a visszanézés lépésköze (mp): a szerver is erre kerekít, így a gyorsítótárak találnak */
export const AT_STEP_S = 30;
/** ennél régebbi pillanat már nem változik (mp) */
const SETTLED_S = 600;

export const roundAt = (t: number) => Math.floor(t / AT_STEP_S) * AT_STEP_S;

export function fetchCached<T>(path: string, ttlS: number): Promise<T> {
  const now = Date.now();
  const hit = store.get(path);
  if (hit && hit.exp > now) {
    // a legutóbb használt a végére: a legrégebben használt esik ki először
    store.delete(path);
    store.set(path, hit);
    return hit.value as Promise<T>;
  }
  const value = fetch(`${API_BASE}${path}`).then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(`HTTP ${r.status}`))));
  store.set(path, { exp: now + ttlS * 1000, value });
  value.catch(() => {
    if (store.get(path)?.value === value) store.delete(path);
  });
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value ?? "");
  return value;
}

/** a pillanat vagy nap kora szerint: a lezárt múltat sokáig, a frisset röviden tartjuk */
export const ttlFor = (t: number) => (Date.now() / 1000 - t > SETTLED_S ? 3600 : 30);
