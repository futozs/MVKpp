import { useEffect } from "react";
import { startSync } from "@/lib/sync";

/**
 * Felhős szinkron indítása. v3: kulcsonkénti, kétirányú szinkron
 * (lib/sync.ts) a régi, 10 percenkénti egyirányú mentés helyett.
 */
export function useCloudBackup(): void {
  useEffect(() => {
    startSync();
  }, []);
}
