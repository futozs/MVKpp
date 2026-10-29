import { useEffect, useState } from "react";
import { CircleCheck, CircleX, Clock, MinusCircle } from "lucide-react";
import { API_BASE } from "@/lib/apiBase";
import { currentPushEndpoint } from "@/lib/push";
import { cn } from "@/lib/utils";

type Delivery = { id: number; kind: string; status: "queued" | "sent" | "failed" | "gone" | "skipped"; attempts: number; last_error: string | null; title: string | null; body: string | null; created_at: string; sent_at: string | null; stop_name: string };

const META: Record<Delivery["status"], { label: string; icon: typeof Clock; tone: string }> = {
  sent: { label: "kiküldve", icon: CircleCheck, tone: "text-ontime" },
  queued: { label: "küldés alatt", icon: Clock, tone: "text-muted-foreground" },
  failed: { label: "nem sikerült", icon: CircleX, tone: "text-destructive" },
  gone: { label: "a feliratkozás lejárt", icon: CircleX, tone: "text-destructive" },
  skipped: { label: "kihagyva (elkésett volna)", icon: MinusCircle, tone: "text-muted-foreground" },
};

/** Az eszköz legutóbbi push-értesítései: mi ment ki, mi nem, és miért. */
export function DeliveryLog({ open }: { open: boolean }) {
  const [rows, setRows] = useState<Delivery[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      const endpoint = await currentPushEndpoint();
      if (!endpoint) return setRows([]);
      const r = await fetch(`${API_BASE}/v3/push/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint }) });
      const d = r.ok ? ((await r.json()) as { deliveries: Delivery[] }) : { deliveries: [] };
      if (alive) setRows(d.deliveries);
    })().catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [open]);

  if (!rows?.length) return null;
  return (
    <div className="border-t border-border px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Legutóbbi értesítések erre az eszközre</p>
      <ul className="mt-2 space-y-2">
        {rows.slice(0, 12).map((d) => {
          const m = META[d.status] ?? META.queued;
          const Icon = m.icon;
          return (
            <li key={d.id} className="flex items-start gap-2">
              <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", m.tone)} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{d.title ?? d.stop_name}</p>
                <p className="truncate text-[11px] text-muted-foreground">{d.body}</p>
                <p className="text-[10px] tabular-nums text-muted-foreground">
                  {new Date(d.created_at).toLocaleString("hu-HU", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} · {m.label}
                  {d.attempts > 1 ? ` · ${d.attempts}. próbálkozásra` : ""}
                  {d.status === "failed" && d.last_error ? ` · ${d.last_error}` : ""}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
