"use client";
/**
 * A hub alapelemei, a főapp formanyelvén: kerek kártyák (rounded-2xl, card
 * felület), JetBrains Mono a számoknak, a zöld csak „élő / rendben” jelentéssel.
 */
import { AlertTriangle, Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Tone = "ok" | "warn" | "crit" | "info" | "idle";

export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-live",
  warn: "text-nosignal",
  crit: "text-late",
  info: "text-early",
  idle: "text-muted-foreground",
};
const TONE_DOT: Record<Tone, string> = { ok: "bg-live", warn: "bg-nosignal", crit: "bg-late", info: "bg-early", idle: "bg-muted-foreground/50" };
const TONE_PILL: Record<Tone, string> = {
  ok: "bg-live/12 text-live ring-live/25",
  warn: "bg-nosignal/12 text-nosignal ring-nosignal/25",
  crit: "bg-late/12 text-late ring-late/30",
  info: "bg-early/12 text-early ring-early/25",
  idle: "bg-muted text-muted-foreground ring-border",
};

export function StatusDot({ tone, pulse = false, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span className={cn("relative inline-flex h-2 w-2 shrink-0", className)} aria-hidden>
      {pulse && tone !== "idle" ? <span className={cn("absolute inset-0 rounded-full opacity-60 animate-live-pulse", TONE_DOT[tone])} /> : null}
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", TONE_DOT[tone])} />
    </span>
  );
}

export function Pill({ tone = "idle", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset", TONE_PILL[tone], className)}>{children}</span>;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "outline" | "danger"; size?: "sm" | "md"; busy?: boolean; icon?: ReactNode };

export function Button({ variant = "outline", size = "md", busy, icon, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl font-semibold transition-[background-color,box-shadow,transform,color] duration-fast ease-out",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-px",
        "disabled:pointer-events-none disabled:opacity-45",
        size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3.5 text-[13px]",
        variant === "primary" && "bg-primary text-primary-foreground shadow-sm hover:bg-signal-400",
        variant === "outline" && "border border-border bg-secondary/60 text-foreground hover:border-signal-800 hover:bg-accent",
        variant === "ghost" && "text-muted-foreground hover:bg-accent hover:text-foreground",
        variant === "danger" && "border border-late/40 bg-late/10 text-late hover:bg-late/20",
        className,
      )}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function Panel({ title, hint, action, children, className, bodyClassName, id }: { title?: ReactNode; hint?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; id?: string }) {
  return (
    <section id={id} className={cn("min-w-0 rounded-2xl border border-border bg-card shadow-xs", className)}>
      {title || action ? (
        <header className="flex flex-wrap items-start justify-between gap-2 px-4 pb-1 pt-4 sm:px-5">
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-semibold tracking-tight">{title}</h2> : null}
            {hint ? <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{hint}</p> : null}
          </div>
          {action ? <div className="flex shrink-0 flex-wrap items-center gap-1.5">{action}</div> : null}
        </header>
      ) : null}
      <div className={cn("px-4 pb-4 pt-3 sm:px-5", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Egy szám, ami számít: nagy, mono, a felirat fölötte, a magyarázat alatta. */
export function Stat({ label, value, sub, tone, className }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: Tone; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className={cn("mt-1 truncate font-mono text-xl font-semibold tabular-nums tracking-tight sm:text-[22px]", tone ? TONE_TEXT[tone] : "text-foreground")}>{value}</div>
      {sub ? <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

export function KeyValue({ rows, className }: { rows: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12.5px]", className)}>
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="truncate text-muted-foreground">{k}</dt>
          <dd className="min-w-0 truncate text-right font-mono tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={cn(
        "h-9 w-full rounded-xl border border-input bg-background/60 px-3 text-[13px] text-foreground placeholder:text-muted-foreground/70",
        "transition-colors focus-visible:border-signal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        className,
      )}
    />
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, className }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <div role="radiogroup" className={cn("inline-flex rounded-xl border border-border bg-background/50 p-0.5", className)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-7 rounded-[9px] px-2.5 text-xs font-semibold transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            o.value === value ? "bg-accent text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Loading({ label = "Betöltés…", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex items-center justify-center gap-2 rounded-2xl border border-border bg-card px-6 py-10 text-xs text-muted-foreground", className)}>
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  const msg = error instanceof Error ? error.message : typeof error === "string" ? error : (error as { error?: string } | null)?.error ?? "Ismeretlen hiba";
  return (
    <div role="alert" className={cn("flex items-start gap-2 rounded-xl border border-late/30 bg-late/10 px-3 py-2.5 text-xs text-late", className)}>
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">{msg}</span>
    </div>
  );
}

export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex min-h-20 items-center justify-center rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-xs text-muted-foreground", className)}>{children}</div>;
}

export function Meter({ value, max = 100, tone = "ok", className, label }: { value: number; max?: number; tone?: Tone; className?: string; label?: string }) {
  const p = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)} role="meter" aria-valuenow={value} aria-valuemax={max} aria-label={label}>
      <div className={cn("h-full rounded-full transition-[width] duration-normal ease-out", TONE_DOT[tone])} style={{ width: `${p}%` }} />
    </div>
  );
}
