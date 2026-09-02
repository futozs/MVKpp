import { useEffect } from "react";
import { getSession, pushBackup } from "@/lib/account";

const PUSH_INTERVAL_MS = 10 * 60_000;

export function useCloudBackup(): void {
  useEffect(() => {
    if (!getSession()) return;

    pushBackup().catch(() => {});
    const timer = setInterval(() => {
      if (getSession()) pushBackup().catch(() => {});
    }, PUSH_INTERVAL_MS);

    const onVisible = () => {
      if (document.visibilityState === "visible" && getSession()) {
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
