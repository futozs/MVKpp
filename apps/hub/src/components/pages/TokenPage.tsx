"use client";
import { Copy, Eye, EyeOff, KeyRound, RefreshCw, Send, Smartphone, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { post } from "@/lib/api";
import { ago, dateTime, duration } from "@/lib/format";
import { useAction, useHub, useNow } from "@/lib/hooks";
import type { Agent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PageHeader } from "../shell/Shell";
import { ConfirmDialog, DialogRoot, DialogTitle, Sheet } from "../ui/dialog";
import { Button, Empty, ErrorNote, Input, KeyValue, Loading, Panel, Pill, Segmented, StatusDot, TONE_TEXT, type Tone } from "../ui/primitives";

type TokenData = {
  health: { jwt: { present: boolean; exp?: number; expiresInSec?: number; expired?: boolean; installationId?: string }; lastRenew: { at: string; ok: boolean; status?: number; note?: string } | null; tokenRejected: boolean };
  current: { masked: string | null; claims: Record<string, unknown> | null; status: { source?: string; receivedAt?: string } | null };
  history: { id: number; source: string; agentId: string | null; installationId: string | null; iat: string | null; exp: string; receivedAt: string; rejectedAt: string | null }[];
  agents: Agent[];
  commands: { id: number; agentId: string | null; kind: string; createdAt: string; requestedBy: string | null; pickedAt: string | null; pickedBy: string | null; doneAt: string | null; ok: boolean | null; note: string | null; expired: boolean; stuck: boolean }[];
};

const COMMAND_LABEL: Record<string, string> = {
  "restart-app": "MVK app újraindítása",
  "send-token": "token küldése most",
  "restart-agent": "agent újraindítása",
};

function commandState(c: TokenData["commands"][number]): { text: string; tone: Tone } {
  if (c.doneAt) return c.ok ? { text: "kész", tone: "ok" } : { text: "sikertelen", tone: "crit" };
  if (c.pickedAt) return c.stuck ? { text: "nincs visszajelzés", tone: "warn" } : { text: "fut az agenten", tone: "info" };
  if (c.expired) return { text: "lejárt (nem vette fel)", tone: "idle" };
  return { text: "vár az agentre", tone: "warn" };
}

function Countdown({ data, now }: { data: TokenData; now: number }) {
  const j = data.health.jwt;
  const left = j.exp ? j.exp * 1000 - now : null;
  const tone: Tone = !j.present || (left ?? 0) <= 0 || data.health.tokenRejected ? "crit" : (left ?? 0) < 3_600_000 ? "warn" : "ok";
  const total = 9 * 3600 * 1000;
  const frac = Math.max(0, Math.min(1, (left ?? 0) / total));
  const R = 52;
  const C = 2 * Math.PI * R;
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative h-36 w-36 shrink-0">
        <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
          <circle cx="60" cy="60" r={R} fill="none" stroke="hsl(var(--muted))" strokeWidth="8" />
          <circle cx="60" cy="60" r={R} fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${C * frac} ${C}`} className={cn("transition-[stroke-dasharray] duration-normal", TONE_TEXT[tone])} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className={cn("font-mono text-lg font-bold tabular-nums", TONE_TEXT[tone])}>{left == null ? "–" : left > 0 ? duration(left / 1000) : "lejárt"}</span>
          <span className="text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground">hátra</span>
        </div>
      </div>
      <KeyValue
        className="min-w-[240px] flex-1"
        rows={[
          ["állapot", data.health.tokenRejected ? "az MVK elutasította" : j.present ? (j.expired ? "lejárt" : "érvényes") : "nincs token"],
          ["lejár", j.exp ? dateTime(j.exp * 1000) : "–"],
          ["kiadva (iat)", typeof data.current.claims?.iat === "number" ? dateTime((data.current.claims.iat as number) * 1000) : "–"],
          ["forrás", data.current.status?.source ?? "–"],
          ["megérkezett", data.current.status?.receivedAt ? ago(data.current.status.receivedAt, now) : "–"],
          ["installation-id", j.installationId ? `${j.installationId.slice(0, 8)}…` : "–"],
          ["utolsó szerveroldali megújítás", data.health.lastRenew ? `${data.health.lastRenew.ok ? "sikeres" : "sikertelen"} · ${ago(data.health.lastRenew.at, now)}` : "még nem volt"],
        ]}
      />
    </div>
  );
}

function AgentCard({ a, now, onCommand, busy }: { a: Agent; now: number; onCommand: (kind: string, agentId: string) => void; busy: string | null }) {
  const age = now - Date.parse(a.lastSeenAt);
  const modern = typeof a.info.version === "number" && a.info.version >= 2;
  return (
    <div className="rounded-2xl border border-border bg-background/40 p-4">
      <div className="flex items-center gap-2.5">
        <StatusDot tone={age > 20 * 60_000 ? "crit" : age > 2 * 60_000 ? "warn" : "ok"} pulse={age < 2 * 60_000} />
        <span className="text-[15px] font-bold">{a.agentId}</span>
        {modern ? <Pill tone="ok">v{String(a.info.version)}</Pill> : <Pill tone="warn">régi agent</Pill>}
      </div>
      <KeyValue
        className="mt-3"
        rows={[
          ["utoljára", ago(a.lastSeenAt, now)],
          ["gép", String(a.info.host ?? "–")],
          ["MVK app", a.info.appRunning ? "fut" : "nem fut"],
          ["plist olvasható", a.info.plistReadable ? "igen" : "NEM  Teljes lemezhozzáférés kell"],
          ...(typeof a.info.localTokenLeftSec === "number" ? ([["az app tokenje", duration(a.info.localTokenLeftSec)]] as [string, string][]) : []),
          ...(a.info.lastRestartAt ? ([["utolsó app-újraindítás", ago(String(a.info.lastRestartAt), now)]] as [string, string][]) : []),
          ...(a.info.macos ? ([["macOS", String(a.info.macos)]] as [string, string][]) : []),
        ]}
      />
      {!modern ? <p className="mt-3 text-[11.5px] text-nosignal">Ez az agent még nem fogad parancsot a hubból. Telepítsd újra (apps/token-agent/install.sh), és fél percen belül mindent innen tudsz indítani.</p> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={<Smartphone className="h-3.5 w-3.5" />} busy={busy === `restart-app:${a.agentId}`} onClick={() => onCommand("restart-app", a.agentId)}>
          MVK app újraindítása
        </Button>
        <Button size="sm" icon={<Send className="h-3.5 w-3.5" />} busy={busy === `send-token:${a.agentId}`} onClick={() => onCommand("send-token", a.agentId)}>
          Token küldése
        </Button>
        <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} busy={busy === `restart-agent:${a.agentId}`} onClick={() => onCommand("restart-agent", a.agentId)}>
          Agent újraindítása
        </Button>
      </div>
    </div>
  );
}

function IngestDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [jwt, setJwt] = useState("");
  const [inst, setInst] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await post("/api/token/ingest", { jwt, installationId: inst || undefined });
      toast.success("a token betöltve");
      setJwt("");
      onOpenChange(false);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <Sheet>
        <DialogTitle className="text-base font-semibold">Token kézi betöltése</DialogTitle>
        <p className="mt-1 text-[13px] text-muted-foreground">Vészhelyzetre, ha nincs kéznél a Mac. A szerver csak akkor cseréli le a mostanit, ha ez később jár le.</p>
        <textarea value={jwt} onChange={(e) => setJwt(e.target.value)} rows={5} placeholder="eyJ…" spellCheck={false} className="mt-4 w-full rounded-xl border border-input bg-background/60 p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" />
        <Input value={inst} onChange={(e) => setInst(e.target.value)} placeholder="installation-id (nem kötelező)" className="mt-2 font-mono" />
        <div className="mt-4 flex justify-end">
          <Button variant="primary" busy={busy} disabled={!jwt.trim()} onClick={() => void submit()} icon={<Upload className="h-3.5 w-3.5" />}>
            Betöltés
          </Button>
        </div>
      </Sheet>
    </DialogRoot>
  );
}

export function TokenPage() {
  const { data, error, isLoading, refetch } = useHub<TokenData>("/api/token", 5_000);
  const now = useNow(1000);
  const { busy, run } = useAction();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [ingest, setIngest] = useState(false);
  const [renew, setRenew] = useState(false);
  const [target, setTarget] = useState<string>("*");

  if (isLoading) return <Loading />;
  if (!data) return <ErrorNote error={error} />;

  const command = (kind: string, agentId: string | null) =>
    run(`${kind}:${agentId ?? "*"}`, "/api/token/agent", { kind, agentId }, { success: `„${COMMAND_LABEL[kind]}” elküldve  az agent fél percen belül felveszi`, refresh: ["/api/token"] });

  const reveal = async () => {
    if (revealed) return setRevealed(null);
    const r = await run<{ jwt: string }>("reveal", "/api/token/reveal", {});
    if (r) setRevealed(r.jwt);
  };

  return (
    <>
      <PageHeader
        title="Token és agent"
        lead="Az MVK API-hoz kb. 9 órás JWT kell, amit a Macen futó token-agent hoz az MVK MobilON+ appból. Innen újraindíthatod az appot, azonnali tokenküldést kérhetsz, vagy kézzel tölthetsz be."
        actions={
          <>
            <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => setRenew(true)} busy={busy === "renew"}>
              Szerveroldali megújítás
            </Button>
            <Button size="sm" icon={<Upload className="h-3.5 w-3.5" />} onClick={() => setIngest(true)}>
              Kézi betöltés
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-5">
        <Panel title="A szerver tokenje" className="xl:col-span-3">
          <Countdown data={data} now={now} />
          <div className="mt-5 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background/50 px-3 py-2">
            <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
            <code className="min-w-0 flex-1 break-all font-mono text-[11.5px] text-muted-foreground">{revealed ?? data.current.masked ?? "(nincs)"}</code>
            <Button size="sm" variant="ghost" icon={revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} onClick={() => void reveal()} busy={busy === "reveal"}>
              {revealed ? "Elrejt" : "Megmutat"}
            </Button>
            {revealed ? (
              <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => void navigator.clipboard.writeText(revealed).then(() => toast.success("vágólapra másolva"))}>
                Másol
              </Button>
            ) : null}
          </div>
        </Panel>
        <Panel title="Gyors friss token" hint="Bármelyik élő agent felveheti  ha több Mac van, válassz." className="xl:col-span-2">
          <Segmented value={target} onChange={setTarget} options={[{ value: "*", label: "bármelyik" }, ...data.agents.map((a) => ({ value: a.agentId, label: a.agentId }))]} className="mb-4 max-w-full overflow-x-auto" />
          <div className="space-y-2">
            {(["restart-app", "send-token", "restart-agent"] as const).map((k) => (
              <Button key={k} className="w-full justify-start" variant={k === "restart-app" ? "primary" : "outline"} busy={busy === `${k}:${target}`} onClick={() => void command(k, target === "*" ? null : target)}>
                {COMMAND_LABEL[k]}
              </Button>
            ))}
          </div>
          <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">Az app-újraindítás kb. 1,5 perc: az agent bezárja és háttérben újranyitja a MobilON+ appot, megvárja az új tokent, kiolvassa és felküldi.</p>
        </Panel>
      </div>

      <h2 className="mb-3 mt-8 text-lg font-bold tracking-tight">Agentek</h2>
      {data.agents.length ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.agents.map((a) => (
            <AgentCard key={a.agentId} a={a} now={now} busy={busy} onCommand={(k, id) => void command(k, id)} />
          ))}
        </div>
      ) : (
        <Empty>Még egy token-agent sem jelentkezett. Telepítés: apps/token-agent/install.sh &lt;szerver-url&gt; &lt;AGENT_SECRET&gt;</Empty>
      )}

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel title="Parancsok" hint="A hubból kért agent-műveletek és az eredményük.">
          {data.commands.length ? (
            <ul className="divide-y divide-border">
              {data.commands.map((c) => {
                const st = commandState(c);
                return (
                  <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[12.5px]">
                    <StatusDot tone={st.tone} />
                    <span className="font-semibold">{COMMAND_LABEL[c.kind] ?? c.kind}</span>
                    <span className="text-muted-foreground">→ {c.agentId ?? "bármelyik"}</span>
                    <span className={cn("text-xs", TONE_TEXT[st.tone])}>{st.text}</span>
                    <span className="ml-auto font-mono text-[11px] text-muted-foreground">{ago(c.createdAt, now)}</span>
                    {c.note ? <span className="w-full pl-5 text-xs text-muted-foreground">{c.note}</span> : null}
                    {!c.pickedAt && !c.expired ? (
                      <button className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => void run(`cancel:${c.id}`, `/api/token/agent/${c.id}/cancel`, {}, { refresh: ["/api/token"] })}>
                        visszavon
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty>Még nem küldtél parancsot.</Empty>
          )}
        </Panel>
        <Panel title="Token-előzmények" hint="Minden befogadott token (titkosítva tárolva  itt csak a metaadat).">
          <div className="max-h-[420px] overflow-y-auto">
            <ul className="divide-y divide-border">
              {data.history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2 text-[12.5px]">
                  <Pill tone={h.rejectedAt ? "crit" : h.source === "agent" ? "ok" : "info"}>{h.source}</Pill>
                  <span className="text-muted-foreground">{h.agentId ?? ""}</span>
                  <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                    {dateTime(h.receivedAt)} → {dateTime(h.exp)}
                  </span>
                  {h.rejectedAt ? <span className="w-full text-xs text-late">elutasítva {dateTime(h.rejectedAt)}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      </div>

      <IngestDialog open={ingest} onOpenChange={setIngest} onDone={() => void refetch()} />
      <ConfirmDialog
        open={renew}
        onOpenChange={setRenew}
        title="Szerveroldali megújítás"
        description="A worker a mostani tokennel meghívja az MVK generate-jwt végpontját. App Attest nélkül az MVK ezt gyakran elutasítja  ilyenkor az agentes app-újraindítás a biztos út."
        confirmLabel="Megújítás"
        onConfirm={() => run("renew", "/api/token/renew", {}, { success: (r: { result?: { note?: string } }) => `megújítás: ${r.result?.note ?? "kész"}`, refresh: ["/api/token"] })}
      />
    </>
  );
}
