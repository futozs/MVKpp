import { useEffect, useState } from "react";
import { BellOff, CheckCircle2, XCircle } from "lucide-react";
import type { ArrivalItem } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  DEFAULT_THRESHOLD_MIN,
  getWatch,
  notificationPermission,
  requestNotificationPermission,
  setWatch,
} from "@/lib/notifications";
import { registerPushWatch, unregisterPushWatch } from "@/lib/push";

type StopNotifyDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stopId: string;
  stopName: string;
  arrivals: ArrivalItem[];
  onChanged?: (active: boolean) => void;
};

type Status = { state: "idle" | "ok" | "fail"; reason?: string };

function StatusLine({ status, okLabel }: { status: Status; okLabel: string }) {
  if (status.state === "idle") return null;
  if (status.state === "ok")
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-ontime">
        <CheckCircle2 className="h-3.5 w-3.5" /> {okLabel}
      </p>
    );
  return (
    <p className="flex items-start gap-1.5 text-[11px] text-destructive">
      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {status.reason}
    </p>
  );
}

export function StopNotifyDialog({
  open,
  onOpenChange,
  stopId,
  stopName,
  arrivals,
  onChanged,
}: StopNotifyDialogProps) {
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD_MIN);
  const [routeShorts, setRouteShorts] = useState<string[]>([]);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [existed, setExisted] = useState(false);
  const [pushStatus, setPushStatus] = useState<Status>({ state: "idle" });

  useEffect(() => {
    if (!open) return;
    const w = getWatch(stopId);
    setExisted(Boolean(w));
    setThreshold(w?.thresholdMin ?? DEFAULT_THRESHOLD_MIN);
    setRouteShorts(w?.routeShorts ?? []);
    setPermissionDenied(notificationPermission() === "denied");
    setPushStatus({ state: "idle" });
  }, [open, stopId]);

  const nearbyRoutes = [...new Set(arrivals.map((a) => a.route).filter(Boolean))];

  const toggleRoute = (route: string) =>
    setRouteShorts((prev) =>
      prev.includes(route) ? prev.filter((r) => r !== route) : [...prev, route],
    );

  const handleSave = async () => {
    const granted = await requestNotificationPermission();
    if (!granted) {
      setPermissionDenied(true);
      return;
    }
    const thresholdMin = Math.max(1, Math.min(60, threshold || DEFAULT_THRESHOLD_MIN));
    const finalRouteShorts = routeShorts.length ? routeShorts : undefined;
    setWatch(stopId, { stopName, thresholdMin, routeShorts: finalRouteShorts });
    onChanged?.(true);

    // Ez teszi lehetővé, hogy lezárt telefonon/bezárt lapnál is jöjjön
    // értesítés — a szerver saját maga figyeli az érkezéseket és push-t
    // küld. A dialógus szándékosan NEM zárul be azonnal, hogy lásd, sikerült-e
    // ez a szerver-oldali regisztráció (a helyi, nyitott lapos figyelés
    // ettől függetlenül mindig működik).
    const result = await registerPushWatch({
      stopId,
      stopName,
      thresholdMin,
      routeShorts: finalRouteShorts,
    });
    setPushStatus(
      result.ok ? { state: "ok" } : { state: "fail", reason: result.reason },
    );
  };

  const handleRemove = () => {
    setWatch(stopId, null);
    unregisterPushWatch(stopId);
    onChanged?.(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader className="text-left">
          <DialogTitle>Értesítés — {stopName}</DialogTitle>
          <DialogDescription>
            Szólunk, amikor a busz a beállított időn belülre ér ehhez a
            megállóhoz — lezárt telefonon is, ha a push-regisztráció sikerül.
          </DialogDescription>
        </DialogHeader>

        {permissionDenied ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            A böngésző letiltotta az értesítéseket ehhez az oldalhoz. Engedélyezd
            a böngésző beállításaiban (a címsor melletti lakat ikonnál), majd
            próbáld újra.
          </p>
        ) : null}

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="notify-threshold">Riasztás ennyi percen belül</Label>
            <Input
              id="notify-threshold"
              type="number"
              inputMode="numeric"
              pattern="[0-9]*"
              min={1}
              max={60}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="w-24"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Csak ezekre a járatokra</Label>
            <p className="text-[11px] text-muted-foreground">
              Ha egyet sem jelölsz be, bármelyik vonal jó.
            </p>
            {nearbyRoutes.length ? (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {nearbyRoutes.map((route) => {
                  const active = routeShorts.includes(route);
                  return (
                    <button
                      key={route}
                      type="button"
                      onClick={() => toggleRoute(route)}
                      aria-pressed={active}
                      className={cn(
                        "rounded-md border px-2.5 py-1.5 font-mono text-xs font-bold transition-colors",
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
                      )}
                    >
                      {route}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Most nincs élő járat itt, amit ki lehetne választani.
              </p>
            )}
          </div>

          {pushStatus.state !== "idle" ? (
            <div className="space-y-1 rounded-lg border border-border px-3 py-2">
              <p className="text-[11px] font-semibold text-muted-foreground">
                Lezárt telefonos (push) értesítés
              </p>
              <StatusLine status={pushStatus} okLabel="Sikeresen regisztrálva a szerveren." />
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          {existed ? (
            <Button
              type="button"
              variant="outline"
              className="hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
              onClick={handleRemove}
            >
              <BellOff /> Értesítés kikapcsolása
            </Button>
          ) : null}
          <Button type="button" onClick={handleSave}>
            Mentés
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
