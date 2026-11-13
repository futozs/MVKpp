import { TrainFront } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePreference } from "@/hooks/usePreference";
import { MODE_ITEMS, REGIONAL_INTRO_KEY } from "@/lib/modes";

/**
 * Egyszeri bemutató: a Volán és a vasút alapból be van kapcsolva  itt egy
 * érintéssel megtartható, vagy vissza lehet állni a csak MVK-s nézetre. A döntés
 * (és a módok) szinkronizálódik, így a többi eszközön már nem kérdez.
 */
export function RegionalIntroBanner() {
  const [seen, setSeen] = usePreference<string | null>(REGIONAL_INTRO_KEY, null);
  const [, setCoach] = usePreference<boolean>(MODE_ITEMS[2].key, true);
  const [, setRail] = usePreference<boolean>(MODE_ITEMS[3].key, true);
  if (seen) return null;

  const onlyMvk = () => {
    setCoach(false);
    setRail(false);
    setSeen("mvk");
  };

  return (
    <aside aria-label="Új: vonatok és Volán-buszok" className="shrink-0 border-b border-primary/25 bg-primary/10">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/20 text-primary">
          <TrainFront className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold">Új: vonatok és Volán-buszok is</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Borsod-Abaúj-Zemplénben a térképen, a figyelőben (vasútállomás, vágány, késés oka) és a menetrendben. A Beállításokban módonként kikapcsolhatod.
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-1.5 sm:flex-row">
          <Button size="sm" className="h-8" onClick={() => setSeen("all")}>
            Maradjon
          </Button>
          <Button size="sm" variant="ghost" className="h-8" onClick={onlyMvk}>
            Csak MVK
          </Button>
        </div>
      </div>
    </aside>
  );
}
