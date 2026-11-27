import { useEffect, type RefObject } from "react";
import type { LiveMapHandle } from "./gl/LiveMap";

const MINUTE = 60;
const TEN_MINUTES = 600;
const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const ACTIVATABLE_TAGS = new Set(["BUTTON", "A"]);

/**
 * Szóköz = lejátszás/szünet, ←/→ = ±1 perc (Shifttel ±10 perc). Csak akkor
 * él, ha a fókusz a sávon vagy a térképen van (`whenIdle`: akkor is, ha sehol
 * sincs)  a szűrőpanel saját nyílbillentyűit nem veszi el. Görgetett oldalon
 * (`whenIdle` nélkül) a nyilak az oldalt görgetik tovább.
 */
export function useTimelineKeys(
  rootRef: RefObject<HTMLElement | null>,
  liveRef: RefObject<LiveMapHandle | null>,
  togglePlay: () => void,
  step: (deltaSec: number) => void,
  whenIdle: boolean,
) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target && (TYPING_TAGS.has(target.tagName) || target.isContentEditable)) return;
      if (target?.closest("[role='listbox'], [role='dialog']")) return;

      const inBar = Boolean(target && rootRef.current?.contains(target));
      const inMap = Boolean(target && liveRef.current?.map()?.getContainer().contains(target));
      const idle = whenIdle && (!target || target === document.body || target === document.documentElement);
      if (!inBar && !inMap && !idle) return;

      if (e.key === " " || e.code === "Space") {
        // Fókuszált gombon a szóköz a gombot nyomja meg  azt nem duplázzuk.
        if (target && ACTIVATABLE_TAGS.has(target.tagName)) return;
        e.preventDefault();
        e.stopPropagation();
        togglePlay();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        // A térkép ne is mozduljon a nyíltól, amíg az idővonal él.
        e.stopPropagation();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        step(dir * (e.shiftKey ? TEN_MINUTES : MINUTE));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rootRef, liveRef, togglePlay, step, whenIdle]);
}
