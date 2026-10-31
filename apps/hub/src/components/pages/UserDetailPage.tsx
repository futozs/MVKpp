"use client";
import { ArrowLeft, Download, LogOut, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ago, dateTime, num } from "@/lib/format";
import { useAction, useHub, useNow } from "@/lib/hooks";
import { PageHeader } from "../shell/Shell";
import { ConfirmDialog } from "../ui/dialog";
import { Button, Empty, ErrorNote, KeyValue, Loading, Panel, Pill } from "../ui/primitives";

type Named = { id: string; name: string };
type Detail = {
  user: { id: string; email: string; createdAt: string; legacyId: number | null };
  passkeys: { id: string; deviceName: string | null; deviceType: string | null; backedUp: boolean; transports: string | null; createdAt: string; lastUsedAt: string | null }[];
  sessions: { id: string; createdAt: string; lastSeenAt: string | null; expiresAt: string; userAgent: string | null }[];
  devices: { deviceId: string; platform: string | null; browser: string | null; standalone: boolean; firstSeen: string; lastSeen: string; opens: number }[];
  favorites: { lines: { routeId: string; dir: string; short: string; color: string; text: string; long: string }[]; stops: Named[]; statStops: Named[]; vehicles: string[]; parking: string[]; kiosk: Named[] };
  settings: { key: string; value: unknown; updatedAt: string }[];
  rides: { n: number; first: string | null; last: string | null; recent: Record<string, unknown>[] };
  push: { id: number; host: string; enabled: boolean; failCount: number; lastSuccessAt: string | null; createdAt: string; watches: number }[];
};

function Chips({ items, empty }: { items: { key: string; node: React.ReactNode }[]; empty: string }) {
  if (!items.length) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <span key={i.key} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/50 px-2 py-1 text-[12px]">
          {i.node}
        </span>
      ))}
    </div>
  );
}

/** Egy utazás egy sorban (a webapp Ride rekordjából: vonal, honnan → hová, vehicle). */
function rideLine(r: Record<string, unknown>): string {
  const from = r.fromStopName ? String(r.fromStopName) : "";
  const to = r.toStopName ? String(r.toStopName) : "";
  return [r.route ? String(r.route) : "", from && to ? `${from} → ${to}` : from || to, r.vehicleId ? `#${String(r.vehicleId).replace(/^hkir:hkir_|^1:/, "")}` : ""].filter(Boolean).join(" · ") || "utazás";
}

export function UserDetailPage({ id }: { id: string }) {
  const { data, error, isLoading } = useHub<Detail>(`/api/users/${id}`, 30_000);
  const now = useNow(30_000);
  const router = useRouter();
  const { run } = useAction();
  const [revoke, setRevoke] = useState(false);
  const [del, setDel] = useState(false);

  if (isLoading) return <Loading />;
  if (!data) return <ErrorNote error={error} />;
  const f = data.favorites;

  return (
    <>
      <Link href="/felhasznalok" className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> Felhasználók
      </Link>
      <PageHeader
        title={data.user.email}
        lead={`Regisztrált ${dateTime(data.user.createdAt)}${data.user.legacyId ? ` · v2-ből átjött (#${data.user.legacyId})` : ""}`}
        actions={
          <>
            <a href={`/api/users/${id}/export`}>
              <Button size="sm" icon={<Download className="h-3.5 w-3.5" />}>
                Adatexport (JSON)
              </Button>
            </a>
            <Button size="sm" icon={<LogOut className="h-3.5 w-3.5" />} onClick={() => setRevoke(true)} disabled={!data.sessions.length}>
              Kiléptetés mindenhonnan
            </Button>
            <Button size="sm" variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setDel(true)}>
              Fiók törlése
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Panel title="Kedvencek" hint="a felhős szinkronból" className="xl:col-span-2">
          <div className="space-y-4">
            <div>
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">vonalak</div>
              <Chips
                empty="nincs kedvenc vonal"
                items={f.lines.map((l) => ({
                  key: `${l.routeId}|${l.dir}`,
                  node: (
                    <>
                      <span className="rounded px-1 text-[11px] font-extrabold" style={{ background: `#${l.color}`, color: `#${l.text}` }}>
                        {l.short}
                      </span>
                      {l.long}
                    </>
                  ),
                }))}
              />
            </div>
            <div>
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">figyelt megállók</div>
              <Chips empty="nincs" items={f.stops.map((s) => ({ key: s.id, node: s.name }))} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">járművek</div>
                <Chips empty="nincs" items={f.vehicles.map((v) => ({ key: v, node: <span className="font-mono">{v}</span> }))} />
              </div>
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">parkolók</div>
                <Chips empty="nincs" items={f.parking.map((p) => ({ key: p, node: p }))} />
              </div>
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">statisztika-megállók</div>
                <Chips empty="nincs" items={f.statStops.map((s) => ({ key: s.id, node: s.name }))} />
              </div>
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">kijelző</div>
                <Chips empty="nincs" items={f.kiosk.map((s) => ({ key: s.id, node: s.name }))} />
              </div>
            </div>
          </div>
        </Panel>
        <Panel title="Utazások">
          <KeyValue rows={[["rögzítve", num(data.rides.n)], ["első", data.rides.first ? dateTime(data.rides.first) : "–"], ["utolsó", data.rides.last ? ago(data.rides.last, now) : "–"]]} />
          {data.rides.recent.length ? (
            <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto text-[12px]">
              {data.rides.recent.map((r, i) => (
                <li key={String(r.id ?? i)} className="flex justify-between gap-2">
                  <span className="truncate">{rideLine(r)}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{typeof r.boardedAt === "number" ? dateTime((r.boardedAt as number) * 1000) : ""}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>

        <Panel title="Passkey-k">
          {data.passkeys.length ? (
            <ul className="divide-y divide-border">
              {data.passkeys.map((p) => (
                <li key={p.id} className="py-2 text-[12.5px]">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{p.deviceName ?? p.deviceType ?? "passkey"}</span>
                    {p.backedUp ? <Pill tone="ok">szinkronizált</Pill> : null}
                    <button
                      className="ml-auto text-xs text-muted-foreground hover:text-late"
                      onClick={() => void run(`pk:${p.id}`, `/api/users/${id}/passkeys/${p.id}/delete`, {}, { success: "passkey törölve", refresh: [`/api/users/${id}`] })}
                    >
                      törlés
                    </button>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    létrehozva {dateTime(p.createdAt)} · használva {p.lastUsedAt ? ago(p.lastUsedAt, now) : "soha"}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nincs passkey.</Empty>
          )}
        </Panel>
        <Panel title="Munkamenetek és eszközök">
          <ul className="divide-y divide-border">
            {data.sessions.map((s) => (
              <li key={s.id} className="py-2 text-[12px]">
                <div className="truncate" title={s.userAgent ?? ""}>
                  {s.userAgent ?? "ismeretlen böngésző"}
                </div>
                <div className="text-xs text-muted-foreground">
                  utoljára {s.lastSeenAt ? ago(s.lastSeenAt, now) : "–"} · lejár {dateTime(s.expiresAt)}
                </div>
              </li>
            ))}
            {data.devices.map((d) => (
              <li key={d.deviceId} className="py-2 text-[12px]">
                <span className="font-mono text-muted-foreground">{d.deviceId.slice(0, 8)}</span> {d.platform} · {d.browser} {d.standalone ? <Pill tone="info">app</Pill> : null}
                <div className="text-xs text-muted-foreground">
                  {d.opens} megnyitás · utoljára {ago(d.lastSeen, now)}
                </div>
              </li>
            ))}
          </ul>
          {!data.sessions.length && !data.devices.length ? <Empty>Nincs aktív munkamenet.</Empty> : null}
        </Panel>
        <Panel title="Push-feliratkozások">
          {data.push.length ? (
            <ul className="divide-y divide-border">
              {data.push.map((p) => (
                <li key={p.id} className="py-2 text-[12.5px]">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{p.host}</span>
                    <Pill tone={!p.enabled ? "idle" : p.failCount ? "warn" : "ok"}>{!p.enabled ? "kikapcsolva" : p.failCount ? `${p.failCount} hiba` : "él"}</Pill>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {p.watches} figyelés · utolsó kézbesítés {p.lastSuccessAt ? ago(p.lastSuccessAt, now) : "–"}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nincs push-feliratkozás.</Empty>
          )}
        </Panel>

        <Panel title="Beállítások" hint="minden más szinkronizált kulcs" className="xl:col-span-3">
          {data.settings.length ? (
            <div className="grid grid-cols-1 gap-x-6 gap-y-1 md:grid-cols-2">
              {data.settings.map((s) => (
                <div key={s.key} className="flex min-w-0 items-baseline justify-between gap-3 border-b border-border/50 py-1 text-[12px]">
                  <span className="truncate font-mono text-muted-foreground">{s.key.replace(/^mvk_/, "")}</span>
                  <span className="max-w-[55%] truncate font-mono" title={JSON.stringify(s.value)}>
                    {typeof s.value === "string" ? s.value : JSON.stringify(s.value)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Empty>Nincs szinkronizált beállítás.</Empty>
          )}
        </Panel>
      </div>

      <ConfirmDialog
        open={revoke}
        onOpenChange={setRevoke}
        title="Kiléptetés minden eszközről"
        description="Az összes munkamenet törlődik; a felhasználó a passkey-jével újra be tud lépni."
        confirmLabel="Kiléptetés"
        onConfirm={() => run("revoke", `/api/users/${id}/revoke-sessions`, {}, { success: (r: { removed: number }) => `${r.removed} munkamenet törölve`, refresh: [`/api/users/${id}`] })}
      />
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        danger
        title="Fiók végleges törlése"
        description="Törlődik a fiók, a passkey-k, a munkamenetek, a szinkronizált beállítások és az utazások. A push-feliratkozások megmaradnak, de fiók nélkül. Nem visszavonható."
        confirmLabel="Végleges törlés"
        requireText={data.user.email}
        onConfirm={async (typed) => {
          const r = await run("delete", `/api/users/${id}/delete`, { confirm: typed }, { success: "a fiók törölve" });
          if (r) router.push("/felhasznalok");
        }}
      />
    </>
  );
}
