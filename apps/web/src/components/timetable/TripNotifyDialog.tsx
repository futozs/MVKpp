import { useEffect, useState } from "react";
import { BellOff, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PermissionNote } from "@/components/notifications/PermissionNote";
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
  setPushRegistered,
  setWatch,
} from "@/lib/notifications";
import { registerPushWatch, unregisterPushWatch } from "@/lib/push";
import { withHungarianSuffix } from "@/lib/utils";

type TripNotifyDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stopId: string;
  stopName: string;
  tripId: string;
  routeShort: string;
  /** a jármű a mondatokba („3743-as busz”, „IC vonat”); hiányában „<vonal>-es busz” */
  vehicleLabel?: string;
  isDeparture: boolean;
  departureLabel: string;
  /** a menetrend napja (szolgáltatási nap): az egyszeri figyelés csak erre szól */
  date: string;
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

/** "HH:MM" → percek éjféltől (0-1439). Hibás formátumnál null. */
function parseHm(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 27 || min < 0 || min > 59) return null;
  return (h * 60 + min) % 1440;
}

export function TripNotifyDialog({
  open,
  onOpenChange,
  stopId,
  stopName,
  tripId,
  routeShort,
  vehicleLabel,
  isDeparture,
  departureLabel,
  date,
}: TripNotifyDialogProps) {
  const what = vehicleLabel ?? `${withHungarianSuffix(routeShort)} busz`;
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD_MIN);
  const [recurring, setRecurring] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [existed, setExisted] = useState(false);
  const [pushStatus, setPushStatus] = useState<Status>({ state: "idle" });

  useEffect(() => {
    if (!open) return;
    const w = getWatch(stopId);
    setExisted(Boolean(w));
    setThreshold(w?.thresholdMin ?? DEFAULT_THRESHOLD_MIN);
    setRecurring(w?.schedMin != null);
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
    const schedMin = recurring ? (parseHm(departureLabel) ?? undefined) : undefined;
    const config = {
      stopId,
      stopName,
      thresholdMin,
      isDeparture,
      tripId: recurring ? undefined : tripId,
      routeShorts: recurring ? [routeShort] : undefined,
      schedMin,
      // a menetazonosító naponta ismétlődik: az egyszeri figyelés csak a kiválasztott napra szól
      date: recurring ? undefined : date,
    };
    setWatch(stopId, config);

    const result = await registerPushWatch({ ...config, params: config.date ? { date: config.date } : undefined });
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
            Értesítés — {what}, {departureLabel}
          </DialogTitle>
          <DialogDescription>
            {isDeparture
              ? `Szólunk, mielőtt ez a menet elindul innen: ${stopName}`
              : `Szólunk, mielőtt ez a menet ideér: ${stopName}`}{" "}
            — lezárt telefonon is, ha a push-regisztráció sikerül.
          </DialogDescription>
        </DialogHeader>

        {permissionDenied ? <PermissionNote /> : null}

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

          <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium">Ismétlődő — minden nap</p>
              <p className="text-[11px] text-muted-foreground">
                Nem csak erre az egy napra, hanem minden napra szól, amikor a{" "}
                {what} {departureLabel}-kor közlekedik innen. Ez
                kell a napi iskolabuszhoz/munkába járáshoz — egyszer állítod
                be, és nem kell újra minden alkalommal.
              </p>
            </div>
            <Switch checked={recurring} onCheckedChange={setRecurring} />
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
