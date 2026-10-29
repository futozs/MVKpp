import { useCallback, useEffect, useState } from "react";

/**
 * Egy felhasználói beállítás (localStorage-ban, így a felhős szinkron is viszi).
 * Az azonos kulcsot használó komponensek egymás változását is látják.
 */
const EVENT = "mvk-pref-change";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function usePreference<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => read(key, fallback));
  useEffect(() => {
    const sync = (e: Event) => {
      const k = (e as CustomEvent<string>).detail ?? (e as StorageEvent).key;
      if (k === key || k == null) setValue(read(key, fallback));
    };
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = useCallback(
    (v: T) => {
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* privát mód */
      }
      setValue(v);
      window.dispatchEvent(new CustomEvent(EVENT, { detail: key }));
    },
    [key],
  );
  return [value, set];
}

export const PREF_PREDICTED_VEHICLE = "mvk_pref_predicted_vehicle";
