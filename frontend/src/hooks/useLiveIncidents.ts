import { useEffect, useState } from "react";
import { serviceToday, statsApi } from "@/services/statsApi";

const POLL_MS = 60_000;
// A worker kb. 5 percenként fut újra (CLOSE_INTERVAL_MS), ezért egy
// észlelés csak addig számít "élőnek", amíg a legutóbbi futtatási
// ablaknál nem régebbi — ennél régebbi lezárt esemény már csak történelem.
const RECENT_WINDOW_S = 15 * 60;

/**
 * Hány üzemzavar-észlelés "él" éppen most: az elmúlt 15 percben indult,
 * vagy még nyitott kiesés (absence). Ez ad indokot arra, hogy a fejlécen
 * megjelenjen egy figyelmeztető jelzés anélkül, hogy be kellene lépni a
 * Statisztika/Üzemzavarok fülre.
 */
export function useLiveIncidents(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;

    const load = () => {
      const today = serviceToday();
      statsApi
        .incidents(today, today, undefined, 50)
        .then((res) => {
          if (!alive) return;
          const now = Math.floor(Date.now() / 1000);
          const live = res.incidents.filter(
            (i) =>
              (i.kind === "absence" && i.ended_ts == null) ||
              now - i.started_ts <= RECENT_WINDOW_S,
          );
          setCount(live.length);
        })
        .catch(() => {});
    };

    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return count;
}
