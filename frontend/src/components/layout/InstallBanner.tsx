import { Download, Share, SquarePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useInstallPrompt } from "@/hooks/useInstallPrompt";

/**
 * Telepítési ajánlat: a webapp kikerülhet a telefon kezdőképernyőjére, és
 * onnan böngészősáv nélkül, alkalmazásként indul. Androidon a böngésző saját
 * telepítőpárbeszédét nyitja meg, iOS-en — ahol nincs ilyen API — a két
 * kézi lépést mutatja meg.
 */
export function InstallBanner() {
  const { canOffer, needsManualSteps, install, dismiss } = useInstallPrompt();
  if (!canOffer) return null;

  return (
    <aside
      aria-label="A webapp telepítése"
      className="relative z-bar shrink-0 border-b border-primary/25 bg-primary/10"
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/20 text-primary">
          <Download className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold">Tedd ki a kezdőképernyőre</p>
          {needsManualSteps ? (
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px] text-muted-foreground">
              Safari:
              <Share aria-hidden className="h-3 w-3" />
              Megosztás
              <span aria-hidden>→</span>
              <SquarePlus aria-hidden className="h-3 w-3" />
              „Kezdőképernyőhöz adás”
            </p>
          ) : (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Teljes képernyőn, böngészősáv nélkül indul, és offline is
              megnyílik.
            </p>
          )}
        </div>

        {needsManualSteps ? null : (
          <Button size="sm" className="h-8 shrink-0" onClick={install}>
            Telepítés
          </Button>
        )}

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={dismiss}
          aria-label="Ajánlat elrejtése"
        >
          <X />
        </Button>
      </div>
    </aside>
  );
}
