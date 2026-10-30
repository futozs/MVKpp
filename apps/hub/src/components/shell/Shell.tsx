"use client";
/**
 * A pult kerete: asztalon bal oldali sáv (navigáció + élő állapot), telefonon
 * felső sáv és kihúzható menü. Az oldal tartalma jobbra, a háttérben finom
 * zöldes ragyogás — ugyanaz a sötét, jádezöld világ, mint a főappé.
 */
import { LogOut, Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { post } from "@/lib/api";
import { useNow, useOverview } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { StatusDot, TONE_TEXT, type Tone } from "../ui/primitives";
import { BrandMark } from "./BrandMark";
import { NAV } from "./nav";

function overallTone(alerts: { severity: string }[] | undefined, failed: boolean): Tone {
  if (failed) return "crit";
  if (!alerts) return "idle";
  if (alerts.some((a) => a.severity === "crit")) return "crit";
  if (alerts.some((a) => a.severity === "warn")) return "warn";
  return "ok";
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  const { data } = useOverview();
  const now = useNow(5000);
  return (
    <nav aria-label="Hub navigáció" className="space-y-5">
      {NAV.map((g) => (
        <div key={g.label}>
          <div className="mb-1.5 px-3 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">{g.label}</div>
          <ul className="space-y-0.5">
            {g.items.map((it) => {
              const active = it.href === "/" ? path === "/" : path === it.href || path.startsWith(`${it.href}/`);
              const r = data && it.readout ? it.readout(data, now) : null;
              const Icon = it.icon;
              return (
                <li key={it.href}>
                  <Link
                    href={it.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group flex h-9 items-center gap-2.5 rounded-xl px-3 text-[13px] font-medium transition-colors duration-fast",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active ? "bg-accent text-foreground shadow-xs" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    <Icon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
                    <span className="min-w-0 flex-1 truncate">{it.label}</span>
                    {r ? (
                      <span className={cn("flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums", r.tone === "idle" ? "text-muted-foreground" : TONE_TEXT[r.tone])}>
                        {r.tone !== "idle" ? <StatusDot tone={r.tone} /> : null}
                        {r.text}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function SystemPulse() {
  const { data, isError, dataUpdatedAt } = useOverview();
  const now = useNow(1000);
  const tone = overallTone(data?.alerts, isError);
  const label = isError ? "a hub API nem válaszol" : !data ? "betöltés…" : tone === "ok" ? "minden rendszer él" : tone === "warn" ? "figyelmeztetés" : "beavatkozás kell";
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-background/40 px-3 py-2">
      <StatusDot tone={tone} pulse />
      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-xs font-semibold", TONE_TEXT[tone])}>{label}</div>
        <div className="font-mono text-[10.5px] text-muted-foreground">{dataUpdatedAt ? `frissítve ${Math.max(0, Math.round((now - dataUpdatedAt) / 1000))} mp-e` : "–"}</div>
      </div>
    </div>
  );
}

async function logout() {
  await post("/api/auth/logout").catch(() => null);
  window.location.href = "/login";
}

export function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);

  return (
    <div className="hub-backdrop min-h-dvh">
      <aside className="fixed inset-y-0 left-0 z-bar hidden w-[264px] flex-col border-r border-border bg-card/80 backdrop-blur-xl lg:flex">
        <div className="px-5 pb-4 pt-5">
          <BrandMark />
        </div>
        <div className="px-3 pb-3">
          <SystemPulse />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          <NavList />
        </div>
        <div className="border-t border-border px-3 py-3">
          <button onClick={() => void logout()} className="flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-[13px] text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <LogOut className="h-4 w-4" />
            Kilépés
          </button>
        </div>
      </aside>

      <header className="sticky top-0 z-bar flex h-14 items-center justify-between border-b border-border bg-card/85 px-4 pt-[env(safe-area-inset-top)] backdrop-blur-xl lg:hidden">
        <BrandMark />
        <button onClick={() => setOpen(true)} className="rounded-xl p-2 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Menü">
          <Menu className="h-5 w-5" />
        </button>
      </header>

      {open ? (
        <div className="fixed inset-0 z-drawer lg:hidden" role="dialog" aria-modal="true" aria-label="Menü">
          <button className="absolute inset-0 bg-background/70 backdrop-blur-sm" aria-label="Menü bezárása" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 right-0 flex w-[min(320px,88vw)] flex-col border-l border-border bg-card shadow-xl animate-in slide-in-from-right">
            <div className="flex items-center justify-between px-4 py-3">
              <SystemPulse />
              <button onClick={() => setOpen(false)} className="ml-2 rounded-xl p-2 text-muted-foreground hover:bg-accent" aria-label="Bezárás">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
              <NavList onNavigate={() => setOpen(false)} />
            </div>
            <div className="border-t border-border px-3 py-3">
              <button onClick={() => void logout()} className="flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-[13px] text-muted-foreground hover:bg-accent/60">
                <LogOut className="h-4 w-4" />
                Kilépés
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <main className="lg:pl-[264px]">
        <div className="mx-auto w-full max-w-[1440px] px-4 pb-16 pt-5 sm:px-6 lg:px-8 lg:pt-8">{children}</div>
      </main>
    </div>
  );
}

/** Az oldal fejléce: nagy cím, rövid magyarázat, jobbra a műveletek. */
export function PageHeader({ title, lead, actions }: { title: string; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[26px] font-extrabold leading-tight tracking-tight sm:text-[30px]">{title}</h1>
        {lead ? <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">{lead}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
