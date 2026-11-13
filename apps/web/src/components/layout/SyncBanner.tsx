import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { getSyncStatus, onSyncStatus, type SyncStatus } from "@/lib/sync";

/** Egy másik eszközön módosított beállítás megérkezett  egy kattintással betölthető. */
export function SyncBanner() {
  const [s, setS] = useState<SyncStatus>(getSyncStatus);
  useEffect(() => {
    const off = onSyncStatus(setS);
    return () => {
      off();
    };
  }, []);
  if (!s.pendingRemote) return null;
  return (
    <div role="status" className="flex shrink-0 items-center justify-center gap-3 border-b border-primary/30 bg-primary/10 px-4 py-2 text-xs">
      <span>Egy másik eszközön módosítottad a beállításaidat.</span>
      <button
        type="button"
        onClick={() => location.reload()}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden />
        Betöltés
      </button>
    </div>
  );
}
