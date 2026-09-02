import { useEffect } from "react";
import { getAccount, pushBackup } from "@/lib/account";

const PUSH_INTERVAL_MS = 10 * 60_000;

/**
 * Ha van beállított fiók ezen az eszközön, rendszeresen felküldi a
 * localStorage app-adatait biztonsági mentésként — csak felfelé, soha nem
 * tölt le automatikusan (lásd account.ts).
 */
export function useCloudBackup(): void {
  useEffect(() => {
    if (!getAccount()) return;

    pushBackup().catch(() => {});
    const timer = setInterval(() => {
      if (getAccount()) pushBackup().catch(() => {});
    }, PUSH_INTERVAL_MS);

    const onVisible = () => {
      if (document.visibilityState === "visible" && getAccount()) {
        pushBackup().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
