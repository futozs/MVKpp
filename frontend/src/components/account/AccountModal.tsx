import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CloudUpload,
  Fingerprint,
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
  addPasskeyToCurrentAccount,
  getBackupStatus,
  getSession,
  loginWithPasskey,
  logout,
  passkeysSupported,
  pullBackup,
  pushBackup,
  registerAccount,
  type Session,
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
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus] = useState<{
    lastBackupAt: number | null;
    bytes: number;
    credentialCount: number;
  } | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [actionNote, setActionNote] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setSession(getSession());
    setError(null);
    setActionNote(null);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !session) return;
    setStatusBusy(true);
    getBackupStatus()
      .then((res) => setStatus(res.ok ? res.data : null))
      .finally(() => setStatusBusy(false));
  }, [isOpen, session]);

  const handleRegister = async () => {
    setBusy(true);
    setError(null);
    const res = await registerAccount(email.trim());
    setBusy(false);
    if (!res.ok) {
      setError(res.reason);
      return;
    }
    setSession(res.data);
    pushBackup().catch(() => {});
  };

  const handleLogin = async () => {
    setBusy(true);
    setError(null);
    const res = await loginWithPasskey(email.trim());
    setBusy(false);
    if (!res.ok) {
      setError(res.reason);
      return;
    }
    setSession(res.data);
  };

  const handleAddDevice = async () => {
    setStatusBusy(true);
    setActionNote(null);
    const res = await addPasskeyToCurrentAccount();
    setActionNote(res.ok ? "Új passkey hozzáadva ehhez a fiókhoz." : res.reason);
    setStatusBusy(false);
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

  const handleLogout = async () => {
    if (!window.confirm("Kijelentkezel erről az eszközről? A felhőben mentett adat megmarad.")) return;
    await logout();
    setSession(null);
    setStatus(null);
  };

  const supported = passkeysSupported();

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-0 overflow-hidden rounded-t-2xl p-0 sm:max-w-md sm:rounded-lg">
        <DialogHeader className="border-b border-border px-5 py-4 text-left">
          <DialogTitle className="flex items-center gap-2">
            <UserRound className="h-4 w-4 text-primary" />
            Fiók és felhős mentés
          </DialogTitle>
          <DialogDescription className="sr-only">
            Fiók bejelentkezés és a beállítások felhős mentése.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70dvh] space-y-4 overflow-y-auto px-5 py-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:max-h-[65vh]">
          {!supported ? (
            <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Ez a böngésző nem támogatja a passkey-alapú bejelentkezést.</span>
            </p>
          ) : !session ? (
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
                  Van már fiókom
                </button>
              </div>

              <div className="space-y-2">
                <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  E-mail cím
                </label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="pl. nev@pelda.hu"
                />
                <Button
                  className="w-full"
                  onClick={mode === "new" ? handleRegister : handleLogin}
                  disabled={busy || !email.includes("@")}
                >
                  <Fingerprint className={busy ? "animate-pulse" : undefined} />
                  {busy
                    ? "Várakozás a hitelesítőre…"
                    : mode === "new"
                      ? "Passkey létrehozása"
                      : "Bejelentkezés passkey-vel"}
                </Button>
              </div>

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
                <p className="flex items-center gap-1.5 truncate text-sm font-semibold">
                  <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
                  {session.email}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {statusBusy
                    ? "Állapot lekérdezése…"
                    : `Utolsó mentés: ${fmtWhen(status?.lastBackupAt ?? null)} · ${status?.credentialCount ?? 1} passkey`}
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
                className="w-full"
                onClick={handleAddDevice}
                disabled={statusBusy}
              >
                <Fingerprint />
                Új eszköz/passkey hozzáadása
              </Button>

              <Button
                variant="ghost"
                size="sm"
                className="w-full text-muted-foreground"
                onClick={handleLogout}
              >
                <LogOut />
                Kijelentkezés erről az eszközről
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
