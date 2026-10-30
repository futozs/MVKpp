/**
 * A navigáció egyben állapotjelző: minden menüpont mellett az alrendszer élő
 * száma és színe (az /api/overview-ból), így az oldalsáv maga a vezérlőpult.
 */
import { Boxes, Database, Gauge, HardDriveDownload, KeyRound, LayoutDashboard, ListChecks, Radio, Rocket, ScrollText, Smartphone, Users, BellRing } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { isErr } from "@/lib/api";
import { ago, bytes, duration } from "@/lib/format";
import type { Overview } from "@/lib/types";
import type { Tone } from "../ui/primitives";

export type NavItem = { href: string; label: string; icon: LucideIcon; readout?: (o: Overview, now: number) => { text: string; tone: Tone } | null };
export type NavGroup = { label: string; items: NavItem[] };

const worker = (o: Overview) => (isErr(o.worker) ? null : o.worker);

export const NAV: NavGroup[] = [
  {
    label: "Élő",
    items: [
      {
        href: "/",
        label: "Áttekintés",
        icon: LayoutDashboard,
        readout: (o) => {
          const crit = o.alerts.filter((a) => a.severity === "crit").length;
          const warn = o.alerts.filter((a) => a.severity === "warn").length;
          if (crit) return { text: `${crit} hiba`, tone: "crit" };
          if (warn) return { text: `${warn} figy.`, tone: "warn" };
          return { text: "rendben", tone: "ok" };
        },
      },
      {
        href: "/rendszer",
        label: "Szolgáltatások",
        icon: Boxes,
        readout: (o) => {
          if (isErr(o.containers)) return worker(o) ? { text: "worker él", tone: "ok" } : { text: "nem elérhető", tone: "crit" };
          const up = o.containers.filter((c) => c.state === "running" && c.health !== "unhealthy").length;
          return { text: `${up}/${o.containers.length}`, tone: up === o.containers.length ? "ok" : "crit" };
        },
      },
      {
        href: "/valaszidok",
        label: "Válaszidők",
        icon: Gauge,
        readout: (o) => {
          if (!o.probes.length) return null;
          const ok = o.probes.filter((p) => p.ok).length;
          return { text: `${ok}/${o.probes.length}`, tone: ok === o.probes.length ? "ok" : "warn" };
        },
      },
      { href: "/naplok", label: "Naplók", icon: ScrollText },
    ],
  },
  {
    label: "MVK",
    items: [
      {
        href: "/token",
        label: "Token és agent",
        icon: KeyRound,
        readout: (o, now) => {
          const t = worker(o)?.token;
          if (!t) return null;
          if (!t.present) return { text: "nincs", tone: "crit" };
          if (t.rejected) return { text: "elutasítva", tone: "crit" };
          const left = (t.exp ?? 0) * 1000 - now;
          return { text: left > 0 ? duration(left / 1000) : "lejárt", tone: left <= 0 ? "crit" : left < 3_600_000 ? "warn" : "ok" };
        },
      },
      {
        href: "/mvk",
        label: "MVK API",
        icon: Radio,
        readout: (o, now) => {
          const p = worker(o)?.poll;
          if (!p) return null;
          const age = p.lastOkAt ? (now - p.lastOkAt) / 1000 : Infinity;
          return { text: age === Infinity ? "nincs adat" : `${worker(o)?.poll.vehicles ?? 0} jármű`, tone: age > 60 ? "crit" : age > 15 ? "warn" : "ok" };
        },
      },
      { href: "/feladatok", label: "Feladatok", icon: ListChecks },
    ],
  },
  {
    label: "Emberek",
    items: [
      {
        href: "/hasznalat",
        label: "Használat",
        icon: Smartphone,
        readout: (o) => {
          const live = isErr(o.live) ? null : o.live;
          return live ? { text: `${live.clients} fent`, tone: live.clients > 0 ? "ok" : "idle" } : null;
        },
      },
      {
        href: "/felhasznalok",
        label: "Felhasználók",
        icon: Users,
        readout: (o) => (o.accounts && !isErr(o.accounts) ? { text: String(o.accounts.n), tone: "idle" } : null),
      },
      { href: "/push", label: "Push", icon: BellRing },
    ],
  },
  {
    label: "Adat és kiadás",
    items: [
      {
        href: "/adatbazis",
        label: "Adatbázis",
        icon: Database,
        readout: (o) => (o.db && !isErr(o.db) ? { text: bytes(o.db.bytes), tone: "idle" } : { text: "hiba", tone: "crit" }),
      },
      {
        href: "/mentesek",
        label: "Mentések",
        icon: HardDriveDownload,
        readout: (o, now) => {
          const last = o.backups.last;
          if (!last) return { text: "nincs", tone: "warn" };
          return { text: ago(last.createdAt, now), tone: now - Date.parse(last.createdAt) > 36 * 3_600_000 ? "warn" : "idle" };
        },
      },
      {
        href: "/telepites",
        label: "Telepítés",
        icon: Rocket,
        readout: (o) => {
          if (isErr(o.git) || !o.git.available) return null;
          return o.git.behind ? { text: `${o.git.behind} új`, tone: "info" } : { text: o.git.head?.short ?? "", tone: "idle" };
        },
      },
    ],
  },
];

export const ALL_ITEMS = NAV.flatMap((g) => g.items);
