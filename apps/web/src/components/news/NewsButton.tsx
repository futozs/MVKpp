import { useState } from "react";
import { Info } from "lucide-react";
import { MapControl } from "@/components/map/controls/MapControl";
import { NewsDialog } from "./NewsDialog";
import { useNews } from "./useNews";

/**
 * Térkép, jobb felső sarok: az MVK hírei. Csak egy kis pötty jelzi, ha van
 * még nem látott hír — a megnyitás mindet látottnak jelöli.
 */
export function NewsButton({ onShowRoute }: { onShowRoute: (routeId: string) => void }) {
  const news = useNews();
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState<Set<number>>(() => new Set());
  const hasUnseen = news.unseenCount > 0;

  const openNews = () => {
    setFresh(news.markAllSeen());
    news.refreshIfOld();
    setOpen(true);
  };

  return (
    <>
      <MapControl
        icon={Info}
        label={hasUnseen ? `Hírek, ${news.unseenCount} új` : "Hírek"}
        title="Az MVK hírei"
        active={open}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openNews}
      >
        {hasUnseen ? <span aria-hidden className="absolute right-[9px] top-[9px] h-2 w-2 rounded-full bg-primary ring-2 ring-card" /> : null}
      </MapControl>
      <NewsDialog
        open={open}
        onOpenChange={setOpen}
        feed={news.feed}
        error={news.error}
        isLoading={news.loading}
        fresh={fresh}
        onRetry={() => void news.reload()}
        onShowRoute={(id) => {
          setOpen(false);
          onShowRoute(id);
        }}
      />
    </>
  );
}
