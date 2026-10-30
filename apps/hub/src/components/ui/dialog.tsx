"use client";
/**
 * Megerősítő ablak a veszélyes műveletekhez. `requireText` esetén a gomb csak
 * akkor él, ha a felhasználó pontosan begépelte (pl. „VISSZAÁLLÍT”, egy e-mail-cím).
 */
import * as RD from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button, Input } from "./primitives";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  requireText?: string;
  onConfirm: (typed: string) => Promise<unknown> | unknown;
  children?: ReactNode;
};

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, danger, requireText, onConfirm, children }: Props) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const matches = !requireText || typed.trim().toLowerCase() === requireText.toLowerCase();

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm(typed.trim());
      onOpenChange(false);
      setTyped("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <RD.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) setTyped("");
        onOpenChange(o);
      }}
    >
      <Sheet>
        <RD.Title className="pr-8 text-base font-semibold tracking-tight">{title}</RD.Title>
        {description ? <RD.Description className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{description}</RD.Description> : <RD.Description className="sr-only">megerősítés</RD.Description>}
        {children ? <div className="mt-4 space-y-3">{children}</div> : null}
        {requireText ? (
          <label className="mt-4 block text-xs text-muted-foreground">
            A folytatáshoz írd be: <span className="font-mono font-semibold text-foreground">{requireText}</span>
            <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} className="mt-1.5 font-mono" autoComplete="off" spellCheck={false} />
          </label>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <RD.Close asChild>
            <Button variant="ghost">Mégse</Button>
          </RD.Close>
          <Button variant={danger ? "danger" : "primary"} disabled={!matches} busy={busy} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </div>
      </Sheet>
    </RD.Root>
  );
}

/** Közös ablak-keret (sötétítés + kártya). */
export function Sheet({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <RD.Portal>
      <RD.Overlay className="fixed inset-0 z-dialog bg-background/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
      <RD.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-dialog max-h-[88dvh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-popover p-5 shadow-xl",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          wide ? "max-w-3xl" : "max-w-md",
        )}
      >
        {children}
        <RD.Close className="absolute right-3 top-3 rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Bezárás">
          <X className="h-4 w-4" />
        </RD.Close>
      </RD.Content>
    </RD.Portal>
  );
}

export const DialogRoot = RD.Root;
export const DialogTitle = RD.Title;
export const DialogDescription = RD.Description;
