/** Utólag felvett utazás: a menetrend menetei egy naptári napra (`/engine/ridelog/*`). */
import { useEffect, useState } from "react";
import type { PastRoute, PastTrip } from "@mvk/core/pastRides";
import { serviceClock, shiftIso } from "@mvk/core/time";
import { API_BASE } from "@/lib/apiBase";
import { serverNow } from "@/lib/realtime";

export type { PastRoute };

/** a menet futása, ha a rendszer látta: melyik busz, mikor indult és ért be */
export type PastRun = { vehicleId: string; actualStart: number | null; actualEnd: number | null; status: string };
export type PastTripRow = PastTrip & { run: PastRun | null };
export type NextChoice = PastTripRow & { kind: "loop" | "nearby"; sameVehicle: boolean };

const q = encodeURIComponent;

export const rideLogUrl = {
  routes: (date: string) => `${API_BASE}/engine/ridelog/routes?date=${q(date)}`,
  trips: (date: string, route: string) => `${API_BASE}/engine/ridelog/trips?date=${q(date)}&route=${q(route)}`,
  next: (serviceDate: string, tripId: string, vehicleId: string) =>
    `${API_BASE}/engine/ridelog/next?date=${q(serviceDate)}&trip=${q(tripId)}${vehicleId ? `&vehicle=${q(vehicleId)}` : ""}`,
};

export type Fetched<T> = { state: "loading" } | { state: "error" } | { state: "ok"; data: T };

/** Egyszeri lekérés; `url` váltásakor az előző válasz nem látszik tovább. */
export function useFetched<T>(url: string | null): Fetched<T> {
  const [res, setRes] = useState<{ url: string; value: Fetched<T> } | null>(null);
  useEffect(() => {
    if (!url) return;
    const ctl = new AbortController();
    fetch(url, { signal: ctl.signal, cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => setRes({ url, value: { state: "ok", data } }))
      .catch(() => {
        if (!ctl.signal.aborted) setRes({ url, value: { state: "error" } });
      });
    return () => ctl.abort();
  }, [url]);
  return url && res?.url === url ? res.value : { state: "loading" };
}

/** ennyi naptári napra visszamenőleg kínálunk napot (a szerver két hetet enged) */
const DAYS_BACK = 7;
const WEEKDAY = new Intl.DateTimeFormat("hu-HU", { timeZone: "UTC", weekday: "short" });

/** A választható naptári napok (Budapest falióra szerint), a mai elöl. */
export function recentDays(): { iso: string; label: string }[] {
  const today = serviceClock(Math.floor(serverNow())).calendarIso;
  return Array.from({ length: DAYS_BACK }, (_, i) => {
    const iso = shiftIso(today, -i);
    // „H 26.” — a hét napja és a nap (a hónap a két hétből úgyis kiderül)
    const label = `${WEEKDAY.format(new Date(`${iso}T12:00:00Z`))} ${Number(iso.slice(8))}.`;
    return { iso, label: i === 0 ? "Ma" : i === 1 ? "Tegnap" : label };
  });
}
