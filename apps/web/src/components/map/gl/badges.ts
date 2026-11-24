/**
 * A járműcsempék (vonalszám a vonal színében, alatta a rendszám) képei egy közös
 * textúrán: canvasra rajzolva, pontosan úgy, ahogy a régi HTML-csempe kinézett
 * (`.mvk-vehicle` az index.css-ben), csak most a GPU rajzolja ki mindet egyszerre.
 * Egy kép egyszer készül el; a textúra betelése után elölről töltődik.
 */
import type { TransitMode } from "@/types";

/** a vonalszám-csempe kinézete (a kulcsa a `badgeKey`) */
export interface BadgeSpec {
  text: string;
  /** hexa, # nélkül */
  bg: string;
  fg: string;
  mode?: TransitMode;
  tracked: boolean;
  estimated: boolean;
}

/** Egy kép helye a textúrán és a négyszöge a jármű pontjához képest (CSS px, lefelé nő). */
export interface AtlasEntry {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const ATLAS_SIZE = 2048;
const TILE_H = 19;
const TILE_MIN_W = 27;
/** a vonalszám a csempe közepén; a rendszám ennyivel lejjebb kezdődik (CSS px) */
const LABEL_GAP = 4;
/** az árnyék miatti ráhagyás a kép körül (CSS px) */
export const IMAGE_PAD = 7;
const PAD = IMAGE_PAD;
const SHADOW = "hsla(160, 40%, 2%, 0.7)";

export function badgeKey(b: BadgeSpec): string {
  return `b|${b.text}|${b.bg}|${b.fg}|${b.mode ?? ""}|${b.tracked ? 1 : 0}|${b.estimated ? 1 : 0}`;
}

export function labelKey(text: string, tracked: boolean): string {
  return `l|${text}|${tracked ? 1 : 0}`;
}

type Shelf = { y: number; h: number; x: number };

export interface Theme {
  primary: string;
  background: string;
  foreground: string;
  popover: string;
  border: string;
  trackedText: string;
}

/**
 * A textúra: polcos csomagolás. `generation` nő, ha betelt és elölről kezdődött
 * ilyenkor a réteg mindent újrakér.
 */
export class BadgeAtlas {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private entries = new Map<string, AtlasEntry>();
  private shelves: Shelf[] = [];
  private nextY = 0;
  /** a GPU-ra még fel nem töltött terület (eszköz-px) */
  dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;
  generation = 0;

  constructor(
    /** eszközpixel / CSS px (a térkép pixelRatio-ja): a kép így 1:1-ben kerül a képernyőre */
    readonly scale: number,
    private readonly theme: Theme,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = ATLAS_SIZE;
    this.canvas.height = ATLAS_SIZE;
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("canvas 2d nem érhető el");
    this.ctx = ctx;
  }

  badge(spec: BadgeSpec): AtlasEntry {
    return this.get(badgeKey(spec), () => this.measureBadge(spec), (ctx, w, h) => this.drawBadge(ctx, spec, w, h));
  }

  label(text: string, tracked: boolean): AtlasEntry {
    return this.get(labelKey(text, tracked), () => this.measureLabel(text), (ctx, w, h) => this.drawLabel(ctx, text, tracked, w, h));
  }

  private get(key: string, measure: () => { w: number; h: number; x: number; y: number }, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): AtlasEntry {
    const hit = this.entries.get(key);
    if (hit) return hit;
    const box = measure();
    const s = this.scale;
    // eszközpixelre kerekítve: a kép a képernyő pixelrácsára esik, éles marad
    const dw = Math.ceil((box.w + PAD * 2) * s);
    const dh = Math.ceil((box.h + PAD * 2) * s);
    let spot = this.place(dw, dh);
    if (!spot) {
      this.reset();
      spot = this.place(dw, dh);
      if (!spot) throw new Error("a kép nagyobb, mint a textúra");
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.clearRect(spot.x, spot.y, dw, dh);
    ctx.translate(spot.x, spot.y);
    ctx.scale(s, s);
    ctx.translate(PAD, PAD);
    draw(ctx, box.w, box.h);
    ctx.restore();
    this.markDirty(spot.x, spot.y, dw, dh);
    const entry: AtlasEntry = {
      u0: spot.x / ATLAS_SIZE,
      v0: spot.y / ATLAS_SIZE,
      u1: (spot.x + dw) / ATLAS_SIZE,
      v1: (spot.y + dh) / ATLAS_SIZE,
      x: Math.round((box.x - PAD) * s) / s,
      y: Math.round((box.y - PAD) * s) / s,
      w: dw / s,
      h: dh / s,
    };
    this.entries.set(key, entry);
    return entry;
  }

  private place(w: number, h: number): { x: number; y: number } | null {
    let best: Shelf | null = null;
    for (const sh of this.shelves) {
      if (sh.h >= h && sh.h <= h * 1.4 && ATLAS_SIZE - sh.x >= w && (!best || sh.h < best.h)) best = sh;
    }
    if (!best) {
      if (this.nextY + h > ATLAS_SIZE) return null;
      best = { y: this.nextY, h, x: 0 };
      this.shelves.push(best);
      this.nextY += h;
    }
    const spot = { x: best.x, y: best.y };
    best.x += w;
    return spot;
  }

  private reset(): void {
    this.entries.clear();
    this.shelves = [];
    this.nextY = 0;
    this.ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    this.generation++;
    this.markDirty(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  }

  private markDirty(x: number, y: number, w: number, h: number): void {
    const d = this.dirty;
    this.dirty = d
      ? { x0: Math.min(d.x0, x), y0: Math.min(d.y0, y), x1: Math.max(d.x1, x + w), y1: Math.max(d.y1, y + h) }
      : { x0: x, y0: y, x1: x + w, y1: y + h };
  }

  /** A feltöltendő terület képe (és a hely), utána tisztának számít. */
  takeDirty(): { x: number; y: number; data: ImageData } | null {
    const d = this.dirty;
    if (!d) return null;
    this.dirty = null;
    return { x: d.x0, y: d.y0, data: this.ctx.getImageData(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0) };
  }

  /** a teljes textúra (új GL-kontextusnál) */
  all(): ImageData {
    this.dirty = null;
    return this.ctx.getImageData(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  }

  private badgeFont(): string {
    return `800 11px "Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif`;
  }

  private measureBadge(b: BadgeSpec) {
    const ctx = this.ctx;
    ctx.font = this.badgeFont();
    const pad = b.mode === "rail" ? 7 : 5;
    const w = Math.max(TILE_MIN_W, Math.ceil(ctx.measureText(b.text).width + pad * 2 + 2));
    const ring = b.tracked ? 4 : 0;
    // a csempe közepe a jármű helye; a kijelölés gyűrűje is a képbe kerül
    return { w: w + ring * 2, h: TILE_H + ring * 2, x: -(w / 2) - ring, y: -(TILE_H / 2) - ring };
  }

  private drawBadge(ctx: CanvasRenderingContext2D, b: BadgeSpec, w: number, h: number): void {
    const ring = b.tracked ? 4 : 0;
    const tw = w - ring * 2;
    const r = b.mode === "rail" ? TILE_H / 2 : b.mode === "coach" ? 3 : 6;
    ctx.globalAlpha = b.estimated ? 0.72 : 1;
    if (b.tracked) {
      // kijelölés: háttérszínű rés, a márkazöld gyűrű és halvány zöld fény
      ctx.save();
      ctx.shadowColor = "hsla(154, 71%, 42%, 0.45)";
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 3;
      roundRect(ctx, 0, 0, w, h, r + ring);
      ctx.fillStyle = this.theme.primary;
      ctx.fill();
      ctx.restore();
      roundRect(ctx, 2, 2, w - 4, h - 4, r + 2);
      ctx.fillStyle = this.theme.background;
      ctx.fill();
    }
    ctx.save();
    ctx.translate(ring, ring);
    ctx.shadowColor = SHADOW;
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    roundRect(ctx, 0, 0, tw, TILE_H, r);
    ctx.fillStyle = `#${b.bg}`;
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(ring, ring);
    // felül egy halvány fény, körben sötét szegély (szaggatott: menetrendből becsült hely)
    ctx.beginPath();
    ctx.moveTo(r, 1);
    ctx.lineTo(tw - r, 1);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
    ctx.lineWidth = 1;
    ctx.stroke();
    roundRect(ctx, 0.5, 0.5, tw - 1, TILE_H - 1, Math.max(0, r - 0.5));
    ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
    if (b.estimated) ctx.setLineDash([2.5, 2]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = this.badgeFont();
    ctx.letterSpacing = "-0.2px";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = `#${b.fg}`;
    ctx.fillText(b.text, tw / 2, TILE_H / 2 + 0.5);
    ctx.restore();
  }

  private labelFont(): string {
    return `700 9.5px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace`;
  }

  private measureLabel(text: string) {
    const ctx = this.ctx;
    ctx.font = this.labelFont();
    const w = Math.ceil(ctx.measureText(text).width + 10);
    const h = 14;
    return { w, h, x: -w / 2, y: TILE_H / 2 + LABEL_GAP };
  }

  private drawLabel(ctx: CanvasRenderingContext2D, text: string, tracked: boolean, w: number, h: number): void {
    ctx.save();
    ctx.shadowColor = SHADOW;
    ctx.shadowBlur = 5;
    ctx.shadowOffsetY = 2;
    roundRect(ctx, 0, 0, w, h, 5);
    ctx.fillStyle = this.theme.popover;
    ctx.fill();
    ctx.restore();
    roundRect(ctx, 0.5, 0.5, w - 1, h - 1, 4.5);
    ctx.strokeStyle = tracked ? this.theme.primary : this.theme.border;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = this.labelFont();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = tracked ? this.theme.trackedText : this.theme.foreground;
    ctx.fillText(text, w / 2, h / 2 + 0.5);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, h / 2, w / 2));
}
