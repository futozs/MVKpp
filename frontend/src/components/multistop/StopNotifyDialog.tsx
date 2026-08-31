import { useEffect, useState } from "react";
import { BellOff } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import {
  DEFAULT_THRESHOLD_MIN,
  getWatch,
  notificationPermission,
  requestNotificationPermission,
  setWatch,
} from "@/lib/notifications";

type StopNotifyDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stopId: string;
  stopName: string;
  arrivals: ArrivalItem[];
  onChanged?: (active: boolean) => void;
};

export function StopNotifyDialog({
  open,
  onOpenChange,
  stopId,
  stopName,
  arrivals,
  onChanged,
}: StopNotifyDialogProps) {
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD_MIN);
  const [onlyVehicle, setOnlyVehicle] = useState(false);
  const [vehicleId, setVehicleId] = useState("");
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [existed, setExisted] = useState(false);

  useEffect(() => {
    if (!open) return;
    const w = getWatch(stopId);
    setExisted(Boolean(w));
    setThreshold(w?.thresholdMin ?? DEFAULT_THRESHOLD_MIN);
    setOnlyVehicle(Boolean(w?.vehicleId));
    setVehicleId(w?.vehicleId ?? "");
    setPermissionDenied(notificationPermission() === "denied");
  }, [open, stopId]);

  const nearbyVehicleIds = [
    ...new Set(
      arrivals.map((a) => a.vehicle?.id).filter((id): id is string => !!id),
    ),
  ];

  const handleSave = async () => {
    const granted = await requestNotificationPermission();
    if (!granted) {
      setPermissionDenied(true);
      return;
    }
    setWatch(stopId, {
      stopName,
      thresholdMin: Math.max(1, Math.min(60, threshold || DEFAULT_THRESHOLD_MIN)),
      vehicleId: onlyVehicle && vehicleId.trim() ? vehicleId.trim() : undefined,
    });
    onChanged?.(true);
    onOpenChange(false);
  };

  const handleRemove = () => {
    setWatch(stopId, null);
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
            megállóhoz. Csak addig működik, amíg ez a lap nyitva van a
            böngészőben.
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
              min={1}
              max={60}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="w-24"
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium">Csak egy konkrét jármű</p>
              <p className="text-[11px] text-muted-foreground">
                Kikapcsolva: bármelyik következő busz jó.
              </p>
            </div>
            <Switch checked={onlyVehicle} onCheckedChange={setOnlyVehicle} />
          </div>

          {onlyVehicle ? (
            <div className="space-y-1.5">
              <Label htmlFor="notify-vehicle">Jármű azonosító</Label>
              <Input
                id="notify-vehicle"
                value={vehicleId}
                onChange={(e) => setVehicleId(e.target.value)}
                placeholder="pl. 1641"
              />
              {nearbyVehicleIds.length ? (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {nearbyVehicleIds.map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setVehicleId(id)}
                      className="rounded-md border border-border px-2 py-1 font-mono text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                    >
                      {id}
                    </button>
                  ))}
                </div>
              ) : null}
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
