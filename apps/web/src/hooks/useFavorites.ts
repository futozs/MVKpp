import { useCallback, useEffect, useState } from "react";
import { useStorageRefresh } from "./useStorageRefresh";

const STORAGE_KEY = "mvk_timetable_favorites";
const MAX_FAVORITES = 24;

export interface FavoriteLine {
  routeId: string;
  dir: string;
}

function read(): FavoriteLine[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (x): x is FavoriteLine =>
          typeof x?.routeId === "string" && typeof x?.dir === "string",
      )
      .slice(0, MAX_FAVORITES);
  } catch {
    return [];
  }
}

export const favoriteKey = (routeId: string, dir: string) =>
  `${routeId}|${dir}`;

export function useFavorites() {
  const [favorites, setFavorites] = useState<FavoriteLine[]>(read);
  useStorageRefresh(STORAGE_KEY, () => setFavorites(read()));

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
    } catch {}
  }, [favorites]);

  const isFavorite = useCallback(
    (routeId: string, dir: string) =>
      favorites.some((f) => f.routeId === routeId && f.dir === dir),
    [favorites],
  );

  const toggleFavorite = useCallback((routeId: string, dir: string) => {
    setFavorites((prev) => {
      const exists = prev.some((f) => f.routeId === routeId && f.dir === dir);
      if (exists)
        return prev.filter((f) => !(f.routeId === routeId && f.dir === dir));
      if (prev.length >= MAX_FAVORITES) return prev;
      return [...prev, { routeId, dir }];
    });
  }, []);

  return { favorites, isFavorite, toggleFavorite, maxFavorites: MAX_FAVORITES };
}
