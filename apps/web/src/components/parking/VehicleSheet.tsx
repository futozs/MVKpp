import { MapPin } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { DepotVehicle, FleetHistory, ParkedVehicle, ParkingSnapshot, ServiceVehicle } from "@/services/parkingApi";
import { cn } from "@/lib/utils";
import { clockOf, daysBetween, depotLine, durationText, hmOfDaySec, pct, REASON_LABEL } from "./format";
import { PresenceStrip, RouteChip, SignalDot, TipChip, type RouteLookup } from "./parts";
import { displayVehicleId, vehicleIdTitle } from "@/lib/modes";

type Located =
  | { state: "terminus"; place: string; v: ParkedVehicle }
  | { state: "depot"; place: string; v: DepotVehicle }
  | { state: "nosignal"; place: string | null; v: ParkedVehicle }
  | { state: "service"; place: null; v: ServiceVehicle };

export function locate(snap: ParkingSnapshot, id: string): Located | null {
  for (const t of [...snap.terminals, ...(snap.regional?.terminals ?? [])]) {
    const v = t.vehicles.find((x) => x.id === id);
    if (v) return { state: "terminus", place: t.name, v };
  }
  for (const d of snap.depots) {
    const v = d.vehicles.find((x) => x.id === id);
    if (v) return { state: "depot", place: d.name, v };
  }
  const n = snap.nosignal.find((x) => x.id === id);
  if (n) return { state: "nosignal", place: n.place, v: n };
  const s = snap.service.find((x) => x.id === id);
  return s ? { state: "service", place: null, v: s } : null;
}

const STATE: Record<Located["state"], { label: string; cls: string }> = {
  terminus: { label: "Végállomáson parkol", cls: "bg-park/15 text-park" },
  depot: { label: "Kocsiszínben", cls: "bg-depot/15 text-depot" },
  nosignal: { label: "Jel nélkül", cls: "bg-nosignal/15 text-nosignal" },
  service: { label: "Bevetésen", cls: "bg-primary/15 text-primary" },
};

export function VehicleSheet({
  snap,
  id,
  now,
  lookup,
  onClose,
  onFocusVehicle,
}: {
  snap: ParkingSnapshot;
  id: string | null;
  now: number;
  lookup: RouteLookup;
  onClose: () => void;
  onFocusVehicle: (id: string) => void;
}) {
  const hit = id ? locate(snap, id) : null;
  const history = id ? snap.fleet[id] : undefined;
  return (
    <Dialog open={Boolean(hit)} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
        {hit ? (
          <>
            <div className="flex items-start gap-3 pr-6">
              <div className="min-w-0 flex-1">
                <DialogTitle className="flex items-center gap-2.5">
                  <span className="font-mono text-[28px] font-bold leading-none tabular-nums" title={vehicleIdTitle(hit.v.id)}>{displayVehicleId(hit.v.id)}</span>
                  <span className="text-xs font-medium text-muted-foreground">{hit.v.kind === "tram" ? "villamos" : "busz"}</span>
                </DialogTitle>
                <DialogDescription className="mt-2 flex flex-wrap items-center gap-2">
                  <span className={cn("rounded-md px-2 py-0.5 text-[11.5px] font-semibold", STATE[hit.state].cls)}>{STATE[hit.state].label}</span>
                  {hit.place ? <span className="text-[13px] text-foreground">{hit.place}</span> : null}
                </DialogDescription>
              </div>
            </div>
            <Where hit={hit} now={now} lookup={lookup} snap={snap} history={history} />
            {history ? <History h={history} serviceDate={snap.serviceDate} lookup={lookup} /> : null}
            {hit.state === "service" || ("online" in hit.v && hit.v.online) ? (
              <Button
                className="w-full"
                onClick={() => {
                  onFocusVehicle(hit.v.id);
                  onClose();
                }}
              >
                <MapPin /> Megnézem a térképen
              </Button>
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-[13px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

function Where({ hit, now, lookup, snap, history }: { hit: Located; now: number; lookup: RouteLookup; snap: ParkingSnapshot; history: FleetHistory | undefined }) {
  if (hit.state === "service") {
    const v = hit.v;
    return (
      <div className="divide-y divide-border/70 rounded-xl border border-border px-3">
        <Row label="Most">
          {v.deadhead ? (
            "menet nélkül úton (átállás)"
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <RouteChip route={v.route} lookup={lookup} /> {v.headsign}
            </span>
          )}
        </Row>
        {v.delayS != null ? <Row label="Késés">{v.delayS >= 60 ? `+${Math.round(v.delayS / 60)} perc` : v.delayS <= -60 ? `${Math.round(v.delayS / 60)} perc (siet)` : "pontos"}</Row> : null}
      </div>
    );
  }
  const v = hit.v;
  return (
    <div className="divide-y divide-border/70 rounded-xl border border-border px-3">
      {hit.state === "depot" ? <Row label="Hogyan került ide">{REASON_LABEL[hit.v.reason].toLowerCase()} — {depotLine(hit.v, history, snap.serviceDate)}</Row> : null}
      {v.since ? <Row label={hit.state === "nosignal" ? "Utolsó jel" : "Itt áll"}>{`${clockOf(v.since)} óta · ${durationText(Math.max(0, now - v.since))}`}</Row> : null}
      <Row label="GPS">
        <span className="inline-flex items-center gap-1.5">
          <SignalDot online={v.online} />
          {v.online ? "élő" : v.lastSeen ? `utoljára ${clockOf(v.lastSeen)}` : "ma nem jelentkezett"}
        </span>
      </Row>
      {v.lastRoute ? (
        <Row label="Utolsó menet">
          <span className="inline-flex items-center gap-1.5">
            <RouteChip route={v.lastRoute} lookup={lookup} /> {v.lastHeadsign ?? ""}
          </span>
        </Row>
      ) : null}
      {v.next ? (
        <Row label={v.next.certain ? "Következő menete" : "Várható következő"}>
          <span className="inline-flex flex-col items-end gap-1">
            <TipChip tip={v.next} lookup={lookup} midnight={snap.midnight} now={now} />
            <span className="text-[11px] text-muted-foreground">
              {v.next.certain ? "az MVK már kiadta neki" : `előrejelzés, ${pct(v.next.confidence)} bizonyossággal`}
            </span>
          </span>
        </Row>
      ) : null}
    </div>
  );
}

function History({ h, serviceDate, lookup }: { h: FleetHistory; serviceDate: string; lookup: RouteLookup }) {
  const since = h.lastDate ? daysBetween(h.lastDate, serviceDate) : null;
  return (
    <div className="rounded-xl border border-border bg-muted/30 px-3 py-3">
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Az utolsó 14 nap</p>
      <PresenceStrip recent={h.recent} tall className="mt-2" />
      <ul className="mt-3 space-y-1.5 text-[12.5px]">
        <li>
          {h.streakDays > 0
            ? `${h.streakDays} napja egyfolytában kint van (tegnapig)`
            : since != null
              ? `${since - 1} napja nem volt kint`
              : "régóta nem volt kint"}
        </li>
        {h.outShare != null ? (
          <li>
            Az ilyen napok <span className="font-mono font-semibold">{pct(h.outShare)}</span>-án kint van
            {h.usualOutS != null ? (
              <>
                , általában <span className="font-mono font-semibold">{hmOfDaySec(h.usualOutS)}</span>-kor áll ki
              </>
            ) : null}
          </li>
        ) : null}
        {h.topRoutes.length ? (
          <li className="flex flex-wrap items-center gap-1.5">
            Legtöbbet: {h.topRoutes.map((r) => <RouteChip key={r} route={r} lookup={lookup} />)}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
