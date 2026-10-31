/** A régi API-val bájtra kompatibilis valós idejű típusok (az iOS app ezt olvassa). */
import type { TransitMode } from "../transit/modes.ts";

export type LiveVeh = {
  id: string;
  lat: number;
  lon: number;
  bearing: number | null;
  speed: number | null;
  routeId: string;
  tripId: string;
};

/** /live/positions egy eleme */
export type DecodedVehicle = {
  id: string;
  label: string;
  routeId: string;
  routeShort: string;
  routeColor: string;
  routeText: string;
  headsign: string;
  lat: number | null;
  lon: number | null;
  bearing: number | null;
  speed: number | null;
  tripId: string;
  timestamp: number | null;
  /** v3: az MVK által küldött eredeti trip_id (ha a feloldás miatt eltér) */
  rtTripId?: string;
  /** v3: közlekedési mód (tram, bus, coach, rail) — a v2-ben csak MVK (tram/bus) jön */
  mode?: TransitMode;
  /** v3: a vonal kulcsa (MVK-nál a rövid név, máshol a vonal-azonosító) */
  routeKey?: string;
  /** v3: rendszám (Volán, és az MVK-é a tartalék forrásból) */
  plate?: string;
  /** v3: vonatszám és név (vasút) */
  trainNo?: string;
  trainName?: string;
  /** v3: a hivatalos (OTP2) késés a következő megállónál, mp */
  delaySec?: number | null;
  /** v3: menetrendből becsült helyzet, nem GPS */
  estimated?: boolean;
  /** v3: honnan jött a jel ("otp2" = MÁV+; hiányzik = natív MVK) */
  source?: "otp2";
};

export type StopPrediction = { unix: number; delay: number | null };

/**
 * Egy poll eredménye, előfeldolgozva: a megállónkénti előrejelzéseket
 * egyszer építjük fel, nem minden megálló-kérésnél a teljes feedből.
 */
export type RealtimeSnapshot = {
  fetchedAt: number;
  header: { version: string; timestamp: number };
  decoded: DecodedVehicle[];
  vehicles: LiveVeh[];
  /** stopId → (tripId → előrejelzés) — az első egyezés nyer, mint a régi kódban */
  predByStop: Map<string, Map<string, StopPrediction>>;
  updatesHeaderTs: number;
  updatesCount: number;
  rtError: string | null;
  /** v3: az MVK-adat forrása ebben a körben ("otp2" = tartalék, MÁV+) */
  source?: "mvk" | "otp2" | null;
  /** v3: a regionális (Volán, vasút) adat utolsó sikeres frissítése (ms) */
  regionalAt?: number;
};

export type ArrivalItem = {
  route: string;
  color: string;
  text: string;
  headsign: string;
  time: string;
  etaMin: number;
  delaySec: number | null;
  live: boolean;
  tripId: string;
  vehicle: LiveVeh | null;
  currentStopName: string | null;
  distanceToStopKm: number | null;
  progressDesc: string | null;
  /** v3: a saját illesztőnk által mért aktuális késés (mp), ha van */
  measuredDelaySec?: number | null;
  /**
   * v3: előre jelzett rendszám, ha még nincs élő jármű a menethez. `method: "loop"`:
   * nem tipp — a fordulóhurkon ugyanaz a busz fordul vissza, ami most odafelé jár.
   */
  predictedVehicle?: { id: string; confidence: number; method?: string } | null;
  /** v3: az MVK törölte a menetet */
  cancelled?: boolean;
  /** v3: várható késés ennél a megállónál (szakaszprofilokból) és a 85%-os felső becslés */
  forecastDelaySec?: number | null;
  forecastUpperSec?: number | null;
  /** v3: menetrend szerinti érkezés/indulás ennél a megállónál (unix) */
  schedUnix?: number | null;
  /** v3: késve indul / valószínűleg kimarad, mert a busza még az előző menetén van */
  startRisk?: {
    vehicleId: string;
    expectedDelayS: number;
    level: "late" | "likely-missed";
    prevRoute: string | null;
    prevEndUnix: number;
    predicted: boolean;
  } | null;
  /** v3: dugó a busz előtt a megállóig (többletidő és a legrosszabb szakasz) */
  trafficAhead?: { excessS: number; level: number; fromName: string; toName: string } | null;
  /** v3: közlekedési mód és a vonal kulcsa (a v2 csak MVK-t ad, ott hiányozhat) */
  mode?: TransitMode;
  routeKey?: string;
  /** v3: üzemeltető (pl. „Helyközi busz”, „Tiszaújváros”) */
  operator?: string | null;
  /** v3: vasút: vonatszám, név (TOKAJ), kategória (IC, Sz) */
  trainNo?: string | null;
  trainName?: string | null;
  /** v3: vágány / kocsiállás (élőben változhat) és hogy változott-e */
  platform?: string | null;
  platformChanged?: boolean;
  /** v3: a megálló, ahonnan indul (állomásnál a vágány megállója) */
  stopId?: string;
  /** v3: hivatalos megjegyzések (késés oka, kocsiösszeállítás, pótlóbusz) */
  notices?: string[];
};

export type StopArrivals = {
  stop: { id: string; code?: string; name?: string; lat?: number; lon?: number };
  now: number;
  rtError: string | null;
  arrivals: ArrivalItem[];
  /** közös megálló: a táblán ezeknek a megállóknak az indulásai (az MVK-oszlop és a Volán-párja) */
  merged?: string[];
};
