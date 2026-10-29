import { useCallback, useEffect, useState } from "react";
import { useStorageRefresh } from "./useStorageRefresh";

const STORAGE_KEY = "mvk_stats_favorite_vehicles";
const MAX_FAVORITES = 40;

function read(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === "string")
      .slice(0, MAX_FAVORITES);
  } catch {
    return [];
  }
}

export function useFavoriteVehicles() {
  const [favorites, setFavorites] = useState<string[]>(read);
  useStorageRefresh(STORAGE_KEY, () => setFavorites(read()));

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
    } catch {}
  }, [favorites]);

  const isFavoriteVehicle = useCallback(
    (vehicleId: string) => favorites.includes(vehicleId),
    [favorites],
  );

  const toggleFavoriteVehicle = useCallback((vehicleId: string) => {
    setFavorites((prev) => {
      if (prev.includes(vehicleId)) return prev.filter((v) => v !== vehicleId);
      if (prev.length >= MAX_FAVORITES) return prev;
      return [...prev, vehicleId];
    });
  }, []);

  return { favoriteVehicles: favorites, isFavoriteVehicle, toggleFavoriteVehicle };
}
