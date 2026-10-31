import { useEffect, useRef } from "react";

/**
 * Ismétlődő lekérés, amíg a lap látható (háttérben nem fut, előtérbe kerülve
 * azonnal frissít). A viszonylat- és vonatkártyáknak nincs WebSocket-témájuk.
 */
export function useVisiblePoll(fn: () => void, ms: number, deps: readonly unknown[]) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    ref.current();
    const tick = () => {
      if (document.visibilityState === "visible") ref.current();
    };
    const t = setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}
