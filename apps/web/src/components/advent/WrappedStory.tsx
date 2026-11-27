import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Share2, X } from "lucide-react";
import type { WrappedCard } from "@mvk/core/advent/wrapped";
import { cn } from "@/lib/utils";

const TONE: Record<WrappedCard["tone"], string> = {
  gold: "text-advent-gold",
  ok: "text-ontime",
  warn: "text-nosignal",
  bad: "text-late",
};

/** a Wrapped-előnézet az oldalon: a borító és két szám, koppintásra a teljes összegző */
export function WrappedTeaser({ cards, title, onOpen }: { cards: WrappedCard[]; title: string; onOpen: () => void }) {
  if (!cards.length) return null;
  const cover = cards[0];
  const pick = cards.filter((c) => c.id === "km" || c.id === "trips" || c.id === "stops").slice(0, 3);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative block w-full overflow-hidden rounded-2xl border border-advent-gold/40 bg-advent-navy px-4 py-3.5 text-left shadow-md transition-transform duration-fast hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-advent-gold"
    >
      <Perforation />
      <p className={cn("text-[26px] font-extrabold leading-none tracking-tight", TONE[cover.tone])}>{cover.big}</p>
      <p className="mt-1 text-[12px] text-advent-ink/75">
        {title} · {cover.title}
      </p>
      <dl className="mt-3 grid grid-cols-3 gap-2">
        {pick.map((c) => (
          <div key={c.id}>
            <dd className="font-mono text-[17px] font-bold tabular-nums text-advent-ink">{c.big}</dd>
            <dt className="text-[10.5px] text-advent-ink/60">{c.unit}</dt>
          </div>
        ))}
      </dl>
      <span className="absolute right-4 top-3.5 flex items-center gap-1 text-[12px] font-semibold text-advent-gold">
        Megnézem <ChevronRight className="h-4 w-4 transition-transform duration-fast group-hover:translate-x-0.5" aria-hidden />
      </span>
    </button>
  );
}

/** a jegy lyukasztott széle */
function Perforation() {
  return (
    <span aria-hidden className="pointer-events-none absolute inset-y-3 left-0 flex w-1.5 flex-col justify-between">
      {Array.from({ length: 7 }, (_, i) => (
        <span key={i} className="h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-background" />
      ))}
    </span>
  );
}

/**
 * A teljes összegző: lapok egymás után (koppintás, nyíl, húzás), a végén megosztás.
 * A megosztott kép egy menetjegy: mélykék alap, arany keret, a nap számai.
 */
export function WrappedStory({ cards, title, subtitle, onClose }: { cards: WrappedCard[]; title: string; subtitle: string; onClose: () => void }) {
  const [i, setI] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  const touch = useRef<number | null>(null);
  const last = cards.length - 1;
  const go = (d: number) => setI((x) => Math.min(last, Math.max(0, x + d)));

  useEffect(() => {
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const c = cards[i];
  const share = async () => {
    const blob = await ticketImage(cards, title, subtitle);
    const file = new File([blob], "adventi-villamos.png", {
      type: "image/png",
    });
    const text = `${title} · ${subtitle}`;
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: text }).catch(() => undefined);
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  return (
    <div className="fixed inset-0 z-dialog flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm" onClick={onClose}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={`${title}, ${i + 1}. lap a ${cards.length}-ből`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => (touch.current = e.touches[0].clientX)}
        onTouchEnd={(e) => {
          if (touch.current == null) return;
          const dx = e.changedTouches[0].clientX - touch.current;
          if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
          touch.current = null;
        }}
        className="relative flex aspect-[9/16] max-h-[min(92svh,760px)] w-full max-w-[420px] flex-col overflow-hidden rounded-3xl border border-advent-gold/40 bg-advent-navy text-advent-ink shadow-xl outline-none"
      >
        <div className="flex gap-1 px-4 pt-4" aria-hidden>
          {cards.map((x, k) => (
            <span key={x.id} className={cn("h-1 flex-1 rounded-full transition-colors duration-normal", k <= i ? "bg-advent-gold" : "bg-advent-ink/20")} />
          ))}
        </div>
        <div className="flex items-center justify-between px-4 pt-3">
          <p className="text-[13px] leading-tight">
            <span className="block font-bold text-advent-gold">{title}</span>
            <span className="block text-advent-ink/60">{subtitle}</span>
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Bezárás"
            className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-advent-ink/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-advent-gold"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <button
          type="button"
          className="relative flex flex-1 flex-col justify-center px-7 text-left focus-visible:outline-none"
          onClick={() => (i < last ? go(1) : undefined)}
          aria-label={i < last ? "Következő lap" : c.title}
        >
          <span key={c.id} className="block animate-in fade-in-0 slide-in-from-bottom-2 duration-300 motion-reduce:animate-none">
            <span className={cn("block font-extrabold leading-[0.95] tracking-tight", TONE[c.tone], c.big.length > 9 ? "text-[44px]" : "text-[72px]")}>{c.big}</span>
            {c.unit ? <span className="mt-1 block text-[20px] font-bold text-advent-ink">{c.unit}</span> : null}
            <span className="mt-5 block text-[19px] font-bold text-advent-ink">{c.title}</span>
            {c.line ? <span className="mt-1 block max-w-[30ch] text-[15px] leading-snug text-advent-ink/75">{c.line}</span> : null}
          </span>
        </button>

        <div className="flex items-center justify-between gap-2 px-4 pb-4">
          <button
            type="button"
            onClick={() => go(-1)}
            disabled={i === 0}
            aria-label="Előző lap"
            className="flex h-11 w-11 items-center justify-center rounded-full border border-advent-ink/20 disabled:opacity-30 enabled:hover:bg-advent-ink/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-advent-gold"
          >
            <ChevronLeft className="h-5 w-5" aria-hidden />
          </button>
          {i === last ? (
            <button
              type="button"
              onClick={() => void share()}
              className="flex h-11 items-center gap-2 rounded-full bg-advent-gold px-5 text-[14px] font-bold text-advent-navy hover:brightness-105 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-advent-ink"
            >
              <Share2 className="h-4 w-4" aria-hidden /> Megosztom
            </button>
          ) : (
            <span className="font-mono text-[12px] tabular-nums text-advent-ink/50">
              {i + 1}/{cards.length}
            </span>
          )}
          <button
            type="button"
            onClick={() => go(1)}
            disabled={i === last}
            aria-label="Következő lap"
            className="flex h-11 w-11 items-center justify-center rounded-full border border-advent-ink/20 disabled:opacity-30 enabled:hover:bg-advent-ink/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-advent-gold"
          >
            <ChevronRight className="h-5 w-5" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

/** a megosztható kép (1080×1920): menetjegy a nap számaival, a böngészőben rajzolva */
async function ticketImage(cards: WrappedCard[], title: string, subtitle: string): Promise<Blob> {
  const W = 1080;
  const H = 1920;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const g = cv.getContext("2d")!;
  const css = getComputedStyle(document.documentElement);
  const col = (v: string) => `hsl(${css.getPropertyValue(v).trim()})`;
  const navy = col("--adv-navy");
  const gold = col("--adv-gold");
  const ink = col("--adv-ink");
  await document.fonts.ready;
  const font = (w: number, px: number) => `${w} ${px}px 'Plus Jakarta Sans', system-ui, sans-serif`;

  g.fillStyle = navy;
  g.fillRect(0, 0, W, H);
  // arany keret, kettős vonallal
  g.strokeStyle = gold;
  g.lineWidth = 6;
  g.strokeRect(48, 48, W - 96, H - 96);
  g.lineWidth = 2;
  g.strokeRect(68, 68, W - 136, H - 136);
  // lyukasztás a jegy szélén
  g.fillStyle = "#000";
  for (let y = 180; y < H - 160; y += 64) {
    g.beginPath();
    g.arc(48, y, 12, 0, Math.PI * 2);
    g.fill();
  }

  g.fillStyle = gold;
  g.font = font(700, 40);
  g.fillText("MENETJEGY", 130, 190);
  g.fillStyle = ink;
  g.font = font(800, 76);
  g.fillText(title, 130, 290);
  g.globalAlpha = 0.7;
  g.font = font(500, 40);
  g.fillText(subtitle, 130, 350);
  g.globalAlpha = 1;

  const cover = cards[0];
  g.fillStyle = gold;
  g.font = font(800, 150);
  g.fillText(cover.big, 130, 560);

  const rows = cards.slice(1, 7);
  rows.forEach((c, k) => {
    const y = 760 + k * 170;
    g.fillStyle = ink;
    g.globalAlpha = 0.6;
    g.font = font(600, 34);
    g.fillText(c.title, 130, y);
    g.globalAlpha = 1;
    g.fillStyle = c.tone === "bad" ? col("--late") : c.tone === "warn" ? col("--nosignal") : ink;
    g.font = font(800, 84);
    g.fillText(c.big, 130, y + 86);
    const wBig = g.measureText(c.big).width;
    if (c.unit) {
      g.fillStyle = ink;
      g.font = font(600, 40);
      g.fillText(c.unit, 130 + wBig + 20, y + 86);
    }
  });

  g.strokeStyle = gold;
  g.setLineDash([14, 12]);
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(130, H - 230);
  g.lineTo(W - 130, H - 230);
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = ink;
  g.globalAlpha = 0.55;
  g.font = font(500, 30);
  g.fillText("mvk.futozs.hu · nem hivatalos összesítő", 130, H - 160);
  g.globalAlpha = 1;

  return new Promise((resolve, reject) => cv.toBlob((b) => (b ? resolve(b) : reject(new Error("a kép nem készült el"))), "image/png"));
}
