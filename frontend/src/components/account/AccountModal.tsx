import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  CloudUpload,
  Copy,
  KeyRound,
  LogOut,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  connectWithKey,
  forgetAccountOnThisDevice,
  getAccount,
  getBackupStatus,
  pullBackup,
  pushBackup,
  registerAccount,
  type Account,
} from "@/lib/account";
import { cn } from "@/lib/utils";

interface AccountModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function fmtWhen(unixSec: number | null): string {
  if (!unixSec) return "még nem történt mentés";
  return new Date(unixSec * 1000).toLocaleString("hu-HU", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

export function AccountModal({ isOpen, onClose }: AccountModalProps) {
  const [account, setAccount] = useState<Account | null>(null);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [email, setEmail] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [status, setStatus] = useState<{
    lastBackupAt: number | null;
    bytes: number;
  } | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [actionNote, setActionNote] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setAccount(getAccount());
    setError(null);
    setFreshKey(null);
    setActionNote(null);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !account) return;
    setStatusBusy(true);
    getBackupStatus()
      .then((res) => setStatus(res.ok ? res.data : null))
      .finally(() => setStatusBusy(false));
  }, [isOpen, account]);

  const handleRegister = async () => {
    setBusy(true);
    setError(null);
    const res = await registerAccount(email.trim());
    setBusy(false);
    if (!res.ok) {
      setError(res.reason);
      return;
    }
    setFreshKey(res.data.key);
    setAccount(res.data);
    pushBackup().catch(() => {});
  };

  const handleConnect = async () => {
    setBusy(true);
    setError(null);
    const res = await connectWithKey(keyInput.trim());
    setBusy(false);
    if (!res.ok) {
      setError(res.reason);
      return;
    }
    setAccount(res.data);
    setKeyInput("");
  };

  const handlePushNow = async () => {
    setStatusBusy(true);
    setActionNote(null);
    const res = await pushBackup();
    setActionNote(res.ok ? "Mentve." : res.reason);
    const s = await getBackupStatus();
    setStatus(s.ok ? s.data : null);
    setStatusBusy(false);
  };

  const handlePull = async () => {
    if (
      !window.confirm(
        "Ez felülírja az ezen az eszközön tárolt kedvenceket, figyeléseket és beállításokat a felhőben mentett utolsó állapottal. Folytatod?",
      )
    )
      return;
    setStatusBusy(true);
    setActionNote(null);
    const res = await pullBackup();
    setActionNote(
      res.ok
        ? `Visszaállítva (${res.data.keysRestored} beállítás) — érdemes újratölteni az oldalt.`
        : res.reason,
    );
    setStatusBusy(false);
  };

  const handleForget = () => {
    if (
      !window.confirm(
        "Leválasztod a fiókot erről az eszközről? A felhőben mentett adat megmarad, később a kulccsal újra csatlakozhatsz.",
      )
    )
      return;
    forgetAccountOnThisDevice();
    setAccount(null);
    setStatus(null);
  };

  const copyKey = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* a vágólap megtagadható */
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-0 overflow-hidden rounded-t-2xl p-0 sm:max-w-md sm:rounded-lg">
        <DialogHeader className="border-b border-border px-5 py-4 text-left">
          <DialogTitle className="flex items-center gap-2">
            <UserRound className="h-4 w-4 text-primary" />
            Fiók és felhős mentés
          </DialogTitle>
          <DialogDescription>
            Jelszó nélkül — a kedvenceid, figyeléseid és beállításaid mentése
            biztonsági másolatként.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70dvh] space-y-4 overflow-y-auto px-5 py-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:max-h-[65vh]">
          {!account ? (
            <>
              <div className="flex gap-1 rounded-lg border border-border bg-muted/40 p-1">
                <button
                  type="button"
                  onClick={() => setMode("new")}
                  className={cn(
                    "flex-1 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors",
                    mode === "new"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  Új fiók
                </button>
                <button
                  type="button"
                  onClick={() => setMode("existing")}
                  className={cn(
                    "flex-1 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors",
                    mode === "existing"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  Van már kulcsom
                </button>
              </div>

              {freshKey ? (
                <div className="space-y-2 rounded-xl border border-primary/40 bg-primary/10 p-3.5">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                    Fiók létrehozva
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Ez a kulcs csak most, EGYETLEN alkalommal látszik. Mentsd
                    el (pl. jelszókezelőbe) — ezzel tudsz majd egy másik
                    eszközön is csatlakozni ugyanehhez a fiókhoz.
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-xs">
                      {freshKey}
                    </code>
                    <Button size="sm" variant="outline" onClick={() => copyKey(freshKey)}>
                      {copied ? <Check className="text-primary" /> : <Copy />}
                      {copied ? "Másolva" : "Másolás"}
                    </Button>
                  </div>
                  <Button size="sm" className="w-full" onClick={() => setFreshKey(null)}>
                    Rendben, elmentettem
                  </Button>
                </div>
              ) : mode === "new" ? (
                <div className="space-y-2">
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    E-mail cím
                  </label>
                  <p className="text-[11px] text-muted-foreground">
                    Csak megjelenítési címke — nincs jelszó, nincs
                    megerősítő levél. A tényleges kulcsot ez az eszköz hozza
                    létre.
                  </p>
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="pl. zsombi@example.com"
                  />
                  <Button
                    className="w-full"
                    onClick={handleRegister}
                    disabled={busy || !email.includes("@")}
                  >
                    <KeyRound className={busy ? "animate-pulse" : undefined} />
                    {busy ? "Létrehozás…" : "Fiók létrehozása"}
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Kulcs
                  </label>
                  <p className="text-[11px] text-muted-foreground">
                    Illeszd be a másik eszközön kapott kulcsot — ezzel
                    csatlakozol ugyanahhoz a fiókhoz, letöltés nélkül.
                  </p>
                  <Input
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder="a mentett kulcs…"
                    className="font-mono text-xs"
                    autoComplete="off"
                  />
                  <Button
                    className="w-full"
                    onClick={handleConnect}
                    disabled={busy || !keyInput.trim()}
                  >
                    <KeyRound className={busy ? "animate-pulse" : undefined} />
                    {busy ? "Ellenőrzés…" : "Csatlakozás"}
                  </Button>
                </div>
              )}

              {error ? (
                <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </p>
              ) : null}
            </>
          ) : (
            <>
              <div className="rounded-xl border border-border bg-muted/30 p-3.5">
                <p className="truncate text-sm font-semibold">{account.email}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {statusBusy
                    ? "Állapot lekérdezése…"
                    : `Utolsó mentés: ${fmtWhen(status?.lastBackupAt ?? null)}`}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePushNow}
                  disabled={statusBusy}
                >
                  <CloudUpload />
                  Mentés most
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePull}
                  disabled={statusBusy}
                >
                  Visszaállítás
                </Button>
              </div>

              {actionNote ? (
                <p className="text-[11px] text-muted-foreground">{actionNote}</p>
              ) : null}

              <p className="text-[11px] leading-relaxed text-muted-foreground">
                A mentés automatikusan, rendszeresen felfelé történik — soha
                nem tölt le és ír felül magától. A "Visszaállítás" az egyetlen
                mód, ahogy adat lefelé kerülhet, és mindig a te döntésed.
              </p>

              <Button
                variant="ghost"
                size="sm"
                className="w-full text-muted-foreground"
                onClick={handleForget}
              >
                <LogOut />
                Leválasztás erről az eszközről
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
