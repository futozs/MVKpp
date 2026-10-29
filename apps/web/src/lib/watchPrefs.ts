/**
 * A megállófigyelő (és a megálló-lap) funkciói egyenként ki-be kapcsolhatók a
 * Beállításokban. Minden kapcsoló külön `mvk_pref_*` kulcs a localStorage-ban,
 * így a felhős szinkron külön-külön viszi őket (két eszköz eltérő módosítása
 * nem írja felül egymást), és minden nyitott lap azonnal látja a változást.
 */
import { PREF_PREDICTED_VEHICLE, usePreference } from "@/hooks/usePreference";

export type WatchFeature =
  | "predictedVehicle"
  | "catch"
  | "leaveTimes"
  | "startRisk"
  | "traffic"
  | "forecast"
  | "replacement"
  | "vehicleTrack"
  | "commute";

export type PrefItem<Id extends string> = { id: Id; key: string; label: string; hint: string };

export const WATCH_FEATURES: readonly PrefItem<WatchFeature>[] = [
  {
    id: "catch",
    key: "mvk_pref_watch_catch",
    label: "„Elérem?” — indulj most",
    hint: "A következő indulásnál: a helyzetedből mikor indulj el, hogy elérd, és a „Szólj” gomb.",
  },
  {
    id: "leaveTimes",
    key: "mvk_pref_watch_leave_times",
    label: "Indulási idők a sorokban",
    hint: "Minden indulás mellett az idő, amikorra el kell indulnod hozzá.",
  },
  {
    id: "startRisk",
    key: "mvk_pref_watch_start_risk",
    label: "Késve indulás előrejelzése",
    hint: "Ha a menet busza még az előző menetén késik — még mielőtt az MVK kihúzná.",
  },
  {
    id: "traffic",
    key: "mvk_pref_watch_traffic",
    label: "Dugó a busz előtt",
    hint: "Ha az ide tartó busz előtt beállt a forgalom, mennyi pluszidőt hoz.",
  },
  {
    id: "forecast",
    key: "mvk_pref_watch_forecast",
    label: "„Legrosszabb esetben” becslés",
    hint: "A következő busz várható legnagyobb késése ennél a megállónál.",
  },
  {
    id: "predictedVehicle",
    key: PREF_PREDICTED_VEHICLE,
    label: "Rendszám-előrejelzés",
    hint: "Mielőtt a busz élőben megjelenne, a várható rendszámát ~ jellel mutatjuk — a korábbi fordák alapján. Ahol a busz a végállomáson visszafordul, ott ~ nélkül: azt már tudjuk.",
  },
  {
    id: "replacement",
    key: "mvk_pref_watch_replacement",
    label: "Kihúzott menet helyett",
    hint: "A törölt menet mellett, mikor jön helyette a következő ugyanazzal a vonallal.",
  },
  {
    id: "vehicleTrack",
    key: "mvk_pref_watch_vehicle_track",
    label: "A következő busz doboza",
    hint: "Jármű, sebesség, hol jár most, és követés a térképen.",
  },
  {
    id: "commute",
    key: "mvk_pref_watch_commute",
    label: "„Szokásos utad” kártya",
    hint: "Az utazásnaplódból felismert rendszeres út a Figyelő tetején, a szokásos idő előtt.",
  },
];

export type HeaderPref = "tabBadges";

export const HEADER_PREFS: readonly PrefItem<HeaderPref>[] = [
  {
    id: "tabBadges",
    key: "mvk_pref_tab_badges",
    label: "Számlálók a füleken",
    hint: "A Figyelő fülön a figyelt megállók száma, a Statisztikán az élő zavarok jelzése.",
  },
];

/** Egy kapcsoló (alapból minden be van kapcsolva). */
export function useToggle(key: string): [boolean, (v: boolean) => void] {
  return usePreference<boolean>(key, true);
}

/** A Figyelő összes kapcsolója egyben (a lista hossza állandó: a hookok sorrendje is). */
export function useWatchFeatures(): Record<WatchFeature, boolean> {
  const out = {} as Record<WatchFeature, boolean>;
  for (const f of WATCH_FEATURES) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    out[f.id] = usePreference<boolean>(f.key, true)[0] !== false;
  }
  return out;
}

export function useTabBadges(): boolean {
  return usePreference<boolean>(HEADER_PREFS[0].key, true)[0] !== false;
}
