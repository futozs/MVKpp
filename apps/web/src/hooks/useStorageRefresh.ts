import { useEffect, useRef } from "react";

/**
 * Ha egy localStorage-kulcs kívülről változik (felhős szinkron egy másik
 * eszközről, vagy egy másik fül), újraolvassuk  különben a memóriában maradt
 * régi érték a következő helyi módosításkor felülírná a frissebbet.
 */
export function useStorageRefresh(key: string, reload: () => void): void {
  const cb = useRef(reload);
  cb.current = reload;
  useEffect(() => {
    const onChange = (e: Event) => {
      const k = (e as CustomEvent<string>).detail ?? (e as StorageEvent).key;
      if (k === key || k == null) cb.current();
    };
    window.addEventListener("mvk-pref-change", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("mvk-pref-change", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, [key]);
}
