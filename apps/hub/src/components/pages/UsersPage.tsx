"use client";
import { Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ago, date, num } from "@/lib/format";
import { useHub, useNow } from "@/lib/hooks";
import { PageHeader } from "../shell/Shell";
import { Empty, ErrorNote, Input, Loading, Panel, Pill } from "../ui/primitives";

type UserRow = { id: string; email: string; createdAt: string; legacyId: number | null; passkeys: number; sessions: number; lastSeen: string | null; devices: number; rides: number; pushSubs: number; stateKeys: number; favorites: Record<string, number> };

const FAV_LABEL: Record<string, string> = { lines: "vonal", stops: "megálló", statStops: "stat-megálló", vehicles: "jármű", parking: "parkoló", kiosk: "kijelző" };

export function UsersPage() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, error, isLoading } = useHub<{ total: number; users: UserRow[] }>(`/api/users?q=${encodeURIComponent(debounced)}`, 30_000);
  const now = useNow(30_000);

  return (
    <>
      <PageHeader
        title="Felhasználók"
        lead="A passkey-s fiókok: mikor jártak itt, hány eszközük és munkamenetük van, mit tettek kedvencnek, hány utazást rögzítettek. Egy sorra kattintva minden adatuk és a kezelés."
        actions={
          <div className="relative w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="keresés e-mailre" className="pl-9" />
          </div>
        }
      />
      {isLoading ? (
        <Loading />
      ) : !data ? (
        <ErrorNote error={error} />
      ) : (
        <Panel title={`${num(data.total)} fiók`} hint={debounced ? `${data.users.length} találat` : "a legutóbb aktívak elöl"}>
          {data.users.length ? (
            <div className="-mx-4 overflow-x-auto sm:-mx-5">
              <table className="w-full min-w-[860px] text-[12.5px]">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                    <th className="px-4 py-2 font-medium sm:px-5">e-mail</th>
                    <th className="px-2 py-2 font-medium">utoljára</th>
                    <th className="px-2 py-2 font-medium">regisztrált</th>
                    <th className="px-2 py-2 text-right font-medium">passkey</th>
                    <th className="px-2 py-2 text-right font-medium">eszköz</th>
                    <th className="px-2 py-2 font-medium">kedvencek</th>
                    <th className="px-2 py-2 text-right font-medium">utazás</th>
                    <th className="px-4 py-2 text-right font-medium sm:px-5">push</th>
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((u) => (
                    <tr key={u.id} className="border-b border-border/60 last:border-0 hover:bg-accent/30">
                      <td className="px-4 py-2 sm:px-5">
                        <Link href={`/felhasznalok/${u.id}`} className="font-semibold hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          {u.email}
                        </Link>
                        {u.legacyId ? <Pill className="ml-2">v2</Pill> : null}
                      </td>
                      <td className="px-2 py-2 text-muted-foreground">{u.lastSeen ? ago(u.lastSeen, now) : "–"}</td>
                      <td className="px-2 py-2 text-muted-foreground">{date(u.createdAt)}</td>
                      <td className="px-2 py-2 text-right font-mono tabular-nums">{u.passkeys}</td>
                      <td className="px-2 py-2 text-right font-mono tabular-nums">{u.devices}</td>
                      <td className="px-2 py-2 text-muted-foreground">
                        {Object.entries(u.favorites)
                          .filter(([, n]) => n > 0)
                          .map(([k, n]) => `${n} ${FAV_LABEL[k] ?? k}`)
                          .join(" · ") || "–"}
                      </td>
                      <td className="px-2 py-2 text-right font-mono tabular-nums">{num(u.rides)}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums sm:px-5">{u.pushSubs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>Nincs ilyen felhasználó.</Empty>
          )}
        </Panel>
      )}
    </>
  );
}
