import { useEffect, useState } from "react";
import { Bell, BellOff, MoonStar, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  getAllWatches,
  getNotificationSettings,
  notificationPermission,
  removeWatch,
  requestNotificationPermission,
  setNotificationSettings,
  type NotifyWatch,
} from "@/lib/notifications";
import { setDnd } from "@/lib/push";
import { cn } from "@/lib/utils";

interface NotificationsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function minToTime(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timeToMin(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return ((h || 0) * 60 + (m || 0)) % 1440;
}

function watchLabel(w: NotifyWatch): string {
  if (w.tripId) return "egy konkrét indulás";
  if (w.schedMin != null) return `napi ${minToTime(w.schedMin)}-kor`;
  if (w.routeShorts?.length) return w.routeShorts.join(", ") + " járat";
  return "bármelyik járat";
}

export function NotificationsModal({ isOpen, onClose }: NotificationsModalProps) {
  const [settings, setSettings] = useState(getNotificationSettings);
  const [watches, setWatches] = useState<NotifyWatch[]>([]);
  const [permission, setPermission] = useState(notificationPermission);
  const [dndSaving, setDndSaving] = useState(false);
  const [dndNote, setDndNote] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setWatches(getAllWatches());
    setSettings(getNotificationSettings());
    setPermission(notificationPermission());
  }, [isOpen]);

  const save = (next: typeof settings) => {
    setSettings(next);
    setNotificationSettings(next);
  };

  const applyDnd = async (next: typeof settings) => {
    save(next);
    setDndSaving(true);
    setDndNote(null);
    const res = await setDnd(next.dnd);
    setDndSaving(false);
    if (!res.ok) {
      setDndNote(
        res.reason?.includes("feliratkozás")
          ? "A nyitott lapon már érvényes, a lezárt telefonra érkező push-hoz még nincs feliratkozás egyetlen megállóra sem."
          : (res.reason ?? "Nem sikerült menteni a szerveren."),
      );
    }
  };

  const removeOne = (stopId: string) => {
    removeWatch(stopId);
    setWatches(getAllWatches());
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-0 overflow-hidden rounded-t-2xl p-0 sm:max-w-md sm:rounded-lg">
        <DialogHeader className="border-b border-border px-5 py-4 text-left">
          <DialogTitle className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-primary" />
            Értesítések
          </DialogTitle>
          <DialogDescription>
            Mikor és milyen buszokról kapj figyelmeztetést.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70dvh] space-y-5 overflow-y-auto px-5 py-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:max-h-[65vh]">
          {}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold">Értesítések engedélyezve</p>
              <p className="text-[11px] text-muted-foreground">
                {permission === "granted"
                  ? "A böngésző engedélyezve."
                  : permission === "denied"
                    ? "A böngésző letiltotta — a rendszerbeállításokban engedélyezhető."
                    : "Még nincs engedélyezve."}
              </p>
            </div>
            {permission !== "granted" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await requestNotificationPermission();
                  setPermission(notificationPermission());
                }}
              >
                Engedélyezés
              </Button>
            ) : (
              <Switch
                checked={settings.enabled}
                onCheckedChange={(v) => save({ ...settings, enabled: v })}
                aria-label="Értesítések engedélyezve"
              />
            )}
          </div>

          {}
          <div
            className={cn(
              "space-y-3 rounded-xl border border-border bg-muted/30 p-3.5",
              !settings.enabled && "opacity-50",
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <p className="flex items-center gap-1.5 text-sm font-semibold">
                <MoonStar className="h-3.5 w-3.5 text-primary" />
                Ne zavarj
              </p>
              <Switch
                checked={settings.dnd.enabled}
                disabled={!settings.enabled}
                onCheckedChange={(v) =>
                  applyDnd({ ...settings, dnd: { ...settings.dnd, enabled: v } })
                }
                aria-label="Ne zavarj időszak"
              />
            </div>

            {settings.dnd.enabled ? (
              <div className="flex items-center gap-2">
                <label className="flex-1 space-y-1 text-[11px] text-muted-foreground">
                  Ettől
                  <input
                    type="time"
                    value={minToTime(settings.dnd.startMin)}
                    onChange={(e) =>
                      applyDnd({
                        ...settings,
                        dnd: { ...settings.dnd, startMin: timeToMin(e.target.value) },
                      })
                    }
                    className="block w-full rounded-md border border-border bg-card px-2 py-1.5 font-mono text-sm text-foreground"
                  />
                </label>
                <label className="flex-1 space-y-1 text-[11px] text-muted-foreground">
                  Eddig
                  <input
                    type="time"
                    value={minToTime(settings.dnd.endMin)}
                    onChange={(e) =>
                      applyDnd({
                        ...settings,
                        dnd: { ...settings.dnd, endMin: timeToMin(e.target.value) },
                      })
                    }
                    className="block w-full rounded-md border border-border bg-card px-2 py-1.5 font-mono text-sm text-foreground"
                  />
                </label>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Ilyenkor egyetlen értesítés sem érkezik — sem a nyitott lapon,
                sem lezárt telefonra.
              </p>
            )}
            {dndSaving ? (
              <p className="text-[11px] text-muted-foreground">Mentés…</p>
            ) : dndNote ? (
              <p className="text-[11px] text-early">{dndNote}</p>
            ) : null}
          </div>

          {}
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Aktív figyelések ({watches.length})
            </p>
            {watches.length === 0 ? (
              <p className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
                <BellOff className="h-3.5 w-3.5 shrink-0" />
                Egyetlen megállóra vagy indulásra sincs beállítva figyelés — a
                menetrend vagy egy megálló kártyáján a csengő ikonnal
                adhatsz hozzá.
              </p>
            ) : (
              <ul className="divide-y divide-border/60 rounded-lg border border-border">
                {watches.map((w) => (
                  <li
                    key={w.stopId}
                    className="flex items-center gap-2.5 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold">
                        {w.stopName}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {watchLabel(w)} · {w.thresholdMin} percen belül
                        {w.pushRegistered ? " · lezárt telefonra is" : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeOne(w.stopId)}
                      aria-label={`Figyelés törlése — ${w.stopName}`}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
