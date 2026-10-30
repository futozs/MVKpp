"use client";
import { Lock } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { api, post } from "@/lib/api";
import { BrandGlyph } from "../shell/BrandMark";
import { Button, ErrorNote, Input } from "../ui/primitives";

export function LoginForm() {
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  useEffect(() => {
    api<{ problems: string[] }>("/api/auth/me").then((r) => setProblems(r.problems ?? [])).catch(() => {});
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/api/auth/login", { password });
      const next = params.get("next");
      window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <main className="hub-backdrop flex min-h-dvh items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl">
        <div className="mb-6 flex items-center gap-3">
          <BrandGlyph className="h-11 w-11" />
          <div>
            <h1 className="text-lg font-extrabold tracking-tight">
              MVK<span className="text-primary">++</span> rendszer-hub
            </h1>
            <p className="text-xs text-muted-foreground">Csak belső hálóról. Minden művelet naplózva.</p>
          </div>
        </div>
        <label className="block text-xs font-medium text-muted-foreground" htmlFor="pw">
          Hub-jelszó
        </label>
        <div className="relative mt-1.5">
          <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input id="pw" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="pl-9" />
        </div>
        {error ? <ErrorNote error={error} className="mt-3" /> : null}
        {problems.length ? <ErrorNote error={problems.join(" ")} className="mt-3" /> : null}
        <Button type="submit" variant="primary" className="mt-5 w-full" busy={busy} disabled={!password}>
          Belépés
        </Button>
      </form>
    </main>
  );
}
