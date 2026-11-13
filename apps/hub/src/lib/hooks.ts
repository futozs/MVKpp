"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, post } from "./api";

/** Lekérdezés lekérdezési időközzel; a háttérben futó lapon nem pollozunk. */
export function useHub<T>(path: string | null, refetchMs = 15_000) {
  return useQuery({
    queryKey: [path],
    queryFn: () => api<T>(path!),
    enabled: Boolean(path),
    refetchInterval: refetchMs || false,
    refetchIntervalInBackground: false,
    staleTime: Math.min(refetchMs, 5_000),
    retry: 1,
  });
}

export const useOverview = () => useHub<import("./types").Overview>("/api/overview", 10_000);

/**
 * Egy gombnyomásos művelet: POST, toast a végén, és a megadott lekérdezések
 * frissítése. A `busy` a gombra kerül.
 */
export function useAction() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async <T,>(key: string, path: string, body: unknown, opts: { success?: string | ((r: T) => string); refresh?: string[] } = {}): Promise<T | null> => {
    setBusy(key);
    try {
      const r = await post<T>(path, body);
      if (opts.success) toast.success(typeof opts.success === "function" ? opts.success(r) : opts.success);
      for (const k of opts.refresh ?? []) void qc.invalidateQueries({ queryKey: [k] });
      return r;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

/** Másodpercenként frissülő „most”  a visszaszámlálókhoz. */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
