import { useEffect, useState } from "react";
import type { WeatherResponse } from "@/types";
import { api } from "@/services/api";

const POLL_MS = 15 * 60 * 1000;

export function useWeather() {
  const [weather, setWeather] = useState<WeatherResponse | null>(null);

  useEffect(() => {
    let alive = true;

    const load = () => {
      api
        .getWeather()
        .then((res) => alive && setWeather(res))
        .catch(() => {});
    };

    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return weather;
}
