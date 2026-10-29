import { cn } from "@/lib/utils";

export function RouteTile({
  short,
  color,
  text,
  size = "md",
  className,
}: {
  short: string;
  color?: string | null;
  text?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-extrabold tabular-nums tracking-tight shadow-sm ring-1 ring-inset ring-black/25",
        size === "sm" && "h-5 min-w-[30px] rounded-md px-1.5 text-[11px]",
        size === "md" && "h-6 min-w-[36px] rounded-md px-2 text-xs",
        size === "lg" && "h-9 min-w-[48px] rounded-lg px-2.5 text-base",
        className,
      )}
      style={{
        backgroundColor: `#${color || "1FB574"}`,
        color: `#${text || "FFFFFF"}`,
      }}
    >
      {short}
    </span>
  );
}
