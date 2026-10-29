/**
 * Szolgáltatási nap a kliensen: Budapest szerint, hajnali 3:00-kor vált (ahogy
 * a szerveren és a GTFS-ben) — nem a készülék időzónája és nem éjfél szerint.
 * Éjfél után a 24:xx-es menetek így még a „mai” napon futnak. Az idő a
 * szerveré (a készülék órája elállítva is lehet).
 */
import { serviceDayOf, zonedUnix } from "@/components/map/historyTime";
import { serverNow } from "@/lib/realtime";

export function serviceNow(nowMs: number = serverNow() * 1000): { iso: string; sec: number } {
  const unix = nowMs / 1000;
  const iso = serviceDayOf(unix);
  return { iso, sec: Math.floor(unix - zonedUnix(iso, 0)) };
}

/** Budapesti falióra perce (0–1439) — az ismétlődő értesítések egyeztetéséhez. */
export function budapestMinuteOfDay(nowMs: number = serverNow() * 1000): number {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Budapest", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowMs));
  const h = Number(p.find((x) => x.type === "hour")?.value ?? 0);
  const m = Number(p.find((x) => x.type === "minute")?.value ?? 0);
  return h * 60 + m;
}
