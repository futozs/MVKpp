import { useEffect, useState } from "react";
import { Bell, BellOff, Check, MoonStar, Pencil, Trash2, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TimeField } from "@/components/ui/time-field";
import {
  DEFAULT_THRESHOLD_MIN,
  getAllWatches,
  getNotificationSettings,
  notificationPermission,
  removeWatch,
  requestNotificationPermission,
  setNotificationSettings,
  setPushRegistered,
  setWatch,
  type NotifyWatch,
} from "@/lib/notifications";
import { registerPushWatch, setDnd, setPushEnabled, unregisterPushWatch } from "@/lib/push";
import { cn } from "@/lib/utils";
import { DeliveryLog } from "./DeliveryLog";
import { AlertList } from "./AlertList";

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
  const [enabledSaving, setEnabledSaving] = useState(false);
  const [enabledNote, setEnabledNote] = useState<string | null>(null);
  const [dndSaving, setDndSaving] = useState(false);
  const [dndNote, setDndNote] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editThreshold, setEditThreshold] = useState(DEFAULT_THRESHOLD_MIN);
  const [editRoutes, setEditRoutes] = useState("");
  const [editBusy, setEditBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setWatches(getAllWatches());
    setSettings(getNotificationSettings());
    setPermission(notificationPermission());
    setEditingId(null);
  }, [isOpen]);

  const save = (next: typeof settings) => {
    setSettings(next);
    setNotificationSettings(next);
  };

  const applyEnabled = async (enabled: boolean) => {
    save({ ...settings, enabled });
    setEnabledSaving(true);
    setEnabledNote(null);
    const res = await setPushEnabled(enabled);
    setEnabledSaving(false);
    if (!res.ok && !res.reason?.includes("feliratkozás")) {
      setEnabledNote(res.reason ?? "Nem sikerült menteni a szerveren.");
    }
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
    unregisterPushWatch(stopId);
    if (editingId === stopId) setEditingId(null);
    setWatches(getAllWatches());
  };

  const startEdit = (w: NotifyWatch) => {
    setEditingId(w.stopId);
    setEditThreshold(w.thresholdMin);
    setEditRoutes((w.routeShorts ?? []).join(", "));
  };

  const saveEdit = async (w: NotifyWatch) => {
    setEditBusy(true);
    const thresholdMin = Math.max(1, Math.min(60, editThreshold || DEFAULT_THRESHOLD_MIN));
    const routeShorts = editRoutes
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    const finalRouteShorts = routeShorts.length ? routeShorts : undefined;
    setWatch(w.stopId, { ...w, thresholdMin, routeShorts: finalRouteShorts });
    if (w.pushRegistered) {
      const result = await registerPushWatch({
        stopId: w.stopId,
        stopName: w.stopName,
        thresholdMin,
        routeShorts: finalRouteShorts,
        tripId: w.tripId,
        isDeparture: w.isDeparture,
        schedMin: w.schedMin,
      });
      setPushRegistered(w.stopId, result.ok);
    }
    setWatches(getAllWatches());
    setEditBusy(false);
    setEditingId(null);
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
                onCheckedChange={applyEnabled}
                aria-label="Értesítések engedélyezve"
              />
            )}
          </div>
          {enabledSaving ? (
            <p className="-mt-3 text-[11px] text-muted-foreground">Mentés…</p>
          ) : enabledNote ? (
            <p className="-mt-3 text-[11px] text-early">{enabledNote}</p>
          ) : null}

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
                <div className="flex-1 space-y-1">
                  <span className="text-[11px] text-muted-foreground">Ettől</span>
                  <TimeField
                    value={minToTime(settings.dnd.startMin)}
                    onChange={(next) =>
                      applyDnd({
                        ...settings,
                        dnd: { ...settings.dnd, startMin: timeToMin(next) },
                      })
                    }
                    aria-label="Ne zavarj kezdete"
                    className="bg-card"
                  />
                </div>
                <div className="flex-1 space-y-1">
                  <span className="text-[11px] text-muted-foreground">Eddig</span>
                  <TimeField
                    value={minToTime(settings.dnd.endMin)}
                    onChange={(next) =>
                      applyDnd({
                        ...settings,
                        dnd: { ...settings.dnd, endMin: timeToMin(next) },
                      })
                    }
                    aria-label="Ne zavarj vége"
                    className="bg-card"
                  />
                </div>
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

          <AlertList />

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
                  <li key={w.stopId} className="px-3 py-2">
                    {editingId === w.stopId ? (
                      <div className="space-y-2.5 py-1">
                        <p className="truncate text-xs font-semibold">{w.stopName}</p>
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="space-y-1">
                            <Label
                              htmlFor={`edit-threshold-${w.stopId}`}
                              className="text-[11px]"
                            >
                              Percen belül
                            </Label>
                            <Input
                              id={`edit-threshold-${w.stopId}`}
                              type="number"
                              inputMode="numeric"
                              min={1}
                              max={60}
                              value={editThreshold}
                              onChange={(e) => setEditThreshold(Number(e.target.value))}
                              className="w-20"
                            />
                          </div>
                          <div className="min-w-0 flex-1 space-y-1">
                            <Label
                              htmlFor={`edit-routes-${w.stopId}`}
                              className="text-[11px]"
                            >
                              Járatok (üres = bármelyik)
                            </Label>
                            <Input
                              id={`edit-routes-${w.stopId}`}
                              value={editRoutes}
                              onChange={(e) => setEditRoutes(e.target.value)}
                              placeholder="pl. 1, 2A"
                            />
                          </div>
                        </div>
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditingId(null)}
                            disabled={editBusy}
                          >
                            <X className="h-3.5 w-3.5" /> Mégse
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => saveEdit(w)}
                            disabled={editBusy}
                          >
                            <Check className="h-3.5 w-3.5" /> Mentés
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2.5">
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
                          onClick={() => startEdit(w)}
                          aria-label={`Figyelés szerkesztése — ${w.stopName}`}
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeOne(w.stopId)}
                          aria-label={`Figyelés törlése — ${w.stopName}`}
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <DeliveryLog open={isOpen} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
