/**
 * Belső hivatkozások (értesítésből): `/?stop=SP12#multistop`  a Figyelő az
 * adott megállóval. Hidegindításkor az URL-ből, nyitott appnál a service
 * worker üzenetéből vagy az oldalon belüli értesítés kattintásából jön.
 */
import type { ActiveTab } from "@/types";

export const OPEN_LINK_EVENT = "mvk-open-link";

const TABS: ActiveTab[] = ["map", "multistop", "timetable", "parking", "planner", "stats"];
/** ugyanaz, mint a szerveren (`packages/api/src/push.ts`) */
const STOP_ID_RE = /^[\w:.-]{1,32}$/;

export type ParsedLink = { tab: ActiveTab | null; stopId: string | null };

export function stopLink(stopId: string): string {
  return `/?stop=${encodeURIComponent(stopId)}#multistop`;
}

export function parseLink(url: string): ParsedLink {
  try {
    const u = new URL(url, window.location.origin);
    if (u.origin !== window.location.origin) return { tab: null, stopId: null };
    const hash = u.hash.replace(/^#/, "");
    const stop = u.searchParams.get("stop");
    const stopId = stop && STOP_ID_RE.test(stop) ? stop : null;
    // fül nélküli megálló-hivatkozás (`/?stop=SP12`): a Figyelő, ahová a megálló kerül
    const tab = (TABS as string[]).includes(hash) ? (hash as ActiveTab) : stopId ? "multistop" : null;
    return { tab, stopId };
  } catch {
    return { tab: null, stopId: null };
  }
}

/** Az app megnyitja a hivatkozást (lásd App: `OPEN_LINK_EVENT`). */
export function openLink(url: string) {
  window.dispatchEvent(new CustomEvent<string>(OPEN_LINK_EVENT, { detail: url }));
}

/** A hidegindítás hivatkozása egyszer érvényes: utána az URL tiszta (újratöltéskor ne ugorjon vissza). */
export function consumeInitialLink(): ParsedLink | null {
  const { search, hash, pathname } = window.location;
  if (!search.includes("stop=") && !hash) return null;
  const parsed = parseLink(window.location.href);
  const rest = new URLSearchParams(search);
  rest.delete("stop");
  const q = rest.toString();
  window.history.replaceState(window.history.state, "", `${pathname}${q ? `?${q}` : ""}`);
  return parsed;
}
