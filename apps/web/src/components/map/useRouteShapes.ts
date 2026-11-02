import { useEffect, useMemo, useState } from "react";
import { api } from "@/services/api";

/** egy vonal nyomvonalai ([lat, lon] pontok, irányonként) */
export type RouteLines = [number, number][][];

/** a letöltött nyomvonalak (a 2D és a 3D térkép közös gyorsítótára) */
const cache = new Map<string, RouteLines>();

/** A kiválasztott vonalak nyomvonalai: ami már megvan, azonnal; a többi letöltés után. */
export function useRouteShapes(ids: readonly string[]): ReadonlyMap<string, RouteLines> {
  const key = ids.join(",");
  const [loaded, setLoaded] = useState(0);
  useEffect(() => {
    const missing = ids.filter((id) => !cache.has(id));
    if (missing.length === 0) return;
    // Ha a letöltés közben a kiválasztás változott, a régi kör ne frissítsen.
    let alive = true;
    api
      .getRouteGeo(missing)
      .then((res) => {
        res.routes.forEach((r) => cache.set(r.id, r.shapes));
        if (alive) setLoaded((n) => n + 1);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // a `key` az `ids` tartalma
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useMemo(
    () => new Map(ids.flatMap((id) => (cache.has(id) ? [[id, cache.get(id)!] as const] : []))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, loaded],
  );
}
