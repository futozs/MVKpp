import { useEffect, useState } from "react";
import { BellOff, CheckCircle2, XCircle } from "lucide-react";
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
import {
  DEFAULT_THRESHOLD_MIN,
  getWatch,
  notificationPermission,
  requestNotificationPermission,
  setPushRegistered,
  setWatch,
} from "@/lib/notifications";
import { registerPushWatch, unregisterPushWatch } from "@/lib/push";

type TripNotifyDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A kiválasztott megálló, amelyre a figyelés szól — indulási VAGY útközbeni is lehet. */
  stopId: string;
  stopName: string;
  tripId: string;
  routeShort: string;
  /** Igaz, ha a kiválasztott megálló a menet kiinduló megállója (szövegezéshez). */
  isDeparture: boolean;
  /** A menet indulási ideje (vagy a kiválasztott megálló ideje), pl. "16:43" — csak megjelenítéshez. */
  departureLabel: string;
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

export function TripNotifyDialog({
  open,
  onOpenChange,
  stopId,
  stopName,
  tripId,
  routeShort,
  isDeparture,
  departureLabel,
}: TripNotifyDialogProps) {
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD_MIN);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [existed, setExisted] = useState(false);
  const [pushStatus, setPushStatus] = useState<Status>({ state: "idle" });

  useEffect(() => {
    if (!open) return;
    const w = getWatch(stopId);
    const matchesThisTrip = w?.tripId === tripId;
    setExisted(matchesThisTrip);
    setThreshold(matchesThisTrip ? w!.thresholdMin : DEFAULT_THRESHOLD_MIN);
    setPermissionDenied(notificationPermission() === "denied");
    setPushStatus({ state: "idle" });
  }, [open, stopId, tripId]);

  const handleSave = async () => {
    const granted = await requestNotificationPermission();
    if (!granted) {
      setPermissionDenied(true);
      return;
    }
    const thresholdMin = Math.max(1, Math.min(60, threshold || DEFAULT_THRESHOLD_MIN));
    setWatch(stopId, { stopName, thresholdMin, tripId, isDeparture });

    // Ugyanaz a szerver oldali push-lánc szolgálja ki, mint a megállófigyelő
    // értesítéseit — csak itt a járat/megálló szűrés helyett egy pontos
    // tripId-re szól, hogy csak EZ az egy indulás váltson ki riasztást. Mivel
    // egy megállóhoz csak EGY figyelés tartozhat, ha ugyanerre a megállóra
    // már van egy sima (megállófigyelős) riasztás, ez felülírja azt — nem
    // kaphatsz emiatt két külön értesítést ugyanarra a buszra.
    const result = await registerPushWatch({
      stopId,
      stopName,
      thresholdMin,
      tripId,
      isDeparture,
    });
    setPushRegistered(stopId, result.ok);
    setPushStatus(
      result.ok ? { state: "ok" } : { state: "fail", reason: result.reason },
    );
    setExisted(true);
  };

  const handleRemove = () => {
    setWatch(stopId, null);
    unregisterPushWatch(stopId);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader className="text-left">
          <DialogTitle>
            Értesítés — {routeShort}-es busz, {departureLabel}
          </DialogTitle>
          <DialogDescription>
            {isDeparture
              ? `Szólunk, mielőtt ez a menet elindul innen: ${stopName}`
              : `Szólunk, mielőtt ez a menet ideér: ${stopName}`}{" "}
            — lezárt telefonon is, ha a push-regisztráció sikerül.
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
            <Label htmlFor="trip-notify-threshold">
              {isDeparture
                ? "Riasztás ennyi perccel indulás előtt"
                : "Riasztás ennyi perccel érkezés előtt"}
            </Label>
            <Input
              id="trip-notify-threshold"
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
