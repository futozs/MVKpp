import { useSyncExternalStore } from "react";

/** Egy CSS media query élő értéke (pl. `(min-width: 768px)`). */
export function useMediaQuery(query: string, serverValue = false): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}
