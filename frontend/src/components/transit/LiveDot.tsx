import { cn } from "@/lib/utils";

export function LiveDot({ className }: { className?: string }) {
  return (
    <span
      className={cn("relative flex h-2 w-2 shrink-0", className)}
      aria-hidden
    >
      <span className="absolute inline-flex h-full w-full animate-live-pulse rounded-full bg-live" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-live" />
    </span>
  );
}

export function LiveTag({ live }: { live: boolean }) {
  if (!live) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40"
        />
        Menetrendi
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-live">
      <LiveDot />
      Valós idejű
    </span>
  );
}
