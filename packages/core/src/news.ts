/**
 * MVK-hírek (`/api/v1/news/available`) feldolgozása.
 *
 * Az MVK a hír törzsét HTML-ként adja (`<p>`, `<a>`, `<em>`, `<strong>`, `<br>`,
 * sok `&eacute;` entitással). Ebből biztonságos, szerkezetes blokkokat
 * készítünk — bekezdés, alcím, felsorolás —, így a kliensnek sosem kell
 * innerHTML-t használnia. A szövegben említett járatokat („a 34-es”,
 * „az 1-es villamos”, „ZOO viszonylat”) a GTFS járatlistájából ismerjük fel.
 *
 * A `shortContent` a valódi adatban mindig a címmel egyezik, ezért a
 * kivonatot a törzs első bekezdéséből vesszük.
 */
import { budapestOffsetSec } from "./time.ts";

export type NewsRun = {
  text: string;
  bold?: true;
  italic?: true;
  /** csak http(s), mailto és tel hivatkozás marad meg */
  href?: string;
  /** a felismert járat GTFS route_id-ja (a `text` az írt jelzés, pl. „1”) */
  route?: string;
};
export type NewsListItem = {
  /** a „Végállomásról: 08:10, 09:15 …” típusú tételek címkéje */
  lead: NewsRun[] | null;
  runs: NewsRun[];
};
export type NewsBlock =
  | { kind: "p"; runs: NewsRun[] }
  | { kind: "h"; runs: NewsRun[] }
  /** rövid, kettősponttal záruló bevezető sor („Az extra járatok indulási időpontjai:”) */
  | { kind: "label"; runs: NewsRun[] }
  | { kind: "list"; items: NewsListItem[] };

export type NewsItem = {
  id: number;
  title: string;
  /** az MVK kategóriája; az általános „Egyéb” helyett null */
  type: string | null;
  modifiedAt: number;
  validFrom: number | null;
  validUntil: number | null;
  summary: string;
  /** az említett járatok route_id-ja, az első említés sorrendjében */
  routes: string[];
  blocks: NewsBlock[];
};
export type NewsRoute = { short: string; color: string; text: string };
export type NewsFeed = {
  fetchedAt: number;
  /** az MVK most nem érhető el, a legutóbbi jó lista látszik */
  stale: boolean;
  items: NewsItem[];
  routes: Record<string, NewsRoute>;
};

type RouteLike = { id: string; short: string; color: string; text: string };

const SUMMARY_MAX = 170;
const HEADING_MAX = 64;
const LEAD_MAX = 48;
const GENERIC_TYPES = new Set(["egyéb", "egyeb", "other"]);

// ── HTML → bekezdések ──────────────────────────────────────────────────

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "",
  ndash: "–", mdash: "—", hellip: "…", bdquo: "„", ldquo: "“", rdquo: "”",
  lsquo: "‘", rsquo: "’", sbquo: "‚", laquo: "«", raquo: "»", bull: "•",
  middot: "·", deg: "°", euro: "€", times: "×", copy: "©", reg: "®", trade: "™",
  aacute: "á", Aacute: "Á", eacute: "é", Eacute: "É", iacute: "í", Iacute: "Í",
  oacute: "ó", Oacute: "Ó", ouml: "ö", Ouml: "Ö", odblac: "ő", Odblac: "Ő",
  uacute: "ú", Uacute: "Ú", uuml: "ü", Uuml: "Ü", udblac: "ű", Udblac: "Ű",
  auml: "ä", Auml: "Ä", Scaron: "Š", scaron: "š", Zcaron: "Ž", zcaron: "ž",
  Ccaron: "Č", ccaron: "č", Rcaron: "Ř", rcaron: "ř", ccedil: "ç", Ccedil: "Ç",
  agrave: "à", egrave: "è", ograve: "ò", ugrave: "ù", acirc: "â", ecirc: "ê",
  icirc: "î", ocirc: "ô", ucirc: "û", atilde: "ã", otilde: "õ", ntilde: "ñ",
  aring: "å", oslash: "ø", szlig: "ß", euml: "ë", iuml: "ï", yacute: "ý",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] !== "#") return NAMED[e] ?? m;
    const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    const ok = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
    return ok ? String.fromCodePoint(cp) : "";
  });
}

const BLOCK_TAGS = new Set(["p", "div", "li", "ul", "ol", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "table", "section"]);
const SKIP_TAGS = new Set(["script", "style", "noscript", "template"]);

function safeHref(raw: string): string | undefined {
  const href = decodeEntities(raw).trim();
  return /^(https?:\/\/|mailto:|tel:)/i.test(href) ? href : undefined;
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

const sameFormat = (a: NewsRun, b: NewsRun) => a.bold === b.bold && a.italic === b.italic && a.href === b.href && a.route === b.route;

/** Szomszédos, azonos formázású darabok összevonása, üresek elhagyása. */
function mergeRuns(runs: NewsRun[]): NewsRun[] {
  const out: NewsRun[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const prev = out[out.length - 1];
    if (prev && sameFormat(prev, r)) out[out.length - 1] = { ...prev, text: prev.text + r.text };
    else out.push(r);
  }
  return out;
}

/** Szóközök egységesítése a bekezdésen belül; a `<br>` sortörése megmarad. */
function tidy(runs: NewsRun[]): NewsRun[] {
  const collapsed = runs.map((r) => ({ ...r, text: r.text.replace(/[ \t\r\f ]+/g, " ").replace(/ ?\n ?/g, "\n") }));
  const merged = mergeRuns(collapsed);
  // a darabhatáron összetorlódó szóközök és a bekezdés eleji/végi üres hely
  for (let i = 1; i < merged.length; i++) {
    if (merged[i - 1].text.endsWith(" ") && merged[i].text.startsWith(" ")) merged[i] = { ...merged[i], text: merged[i].text.slice(1) };
  }
  if (merged.length) {
    merged[0] = { ...merged[0], text: merged[0].text.replace(/^\s+/, "") };
    const last = merged.length - 1;
    merged[last] = { ...merged[last], text: merged[last].text.replace(/\s+$/, "") };
  }
  return mergeRuns(merged);
}

/** A HTML bekezdésekre bontva, formázott darabokkal. */
export function htmlParagraphs(html: string): NewsRun[][] {
  const paras: NewsRun[][] = [];
  let cur: NewsRun[] = [];
  let bold = 0;
  let italic = 0;
  let skip = 0;
  const links: (string | undefined)[] = [];
  const flush = () => {
    const runs = tidy(cur);
    if (runs.some((r) => r.text.trim())) paras.push(runs);
    cur = [];
  };
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|[^<]+|</g;
  for (const m of html.matchAll(re)) {
    const [tok, close, rawTag, attrs] = m;
    if (tok.startsWith("<!--")) continue;
    if (rawTag === undefined) {
      if (skip) continue;
      // A forrásbeli sortörés HTML-ben szóköz — de egy-egy hír sima szövegként
      // jön, üres sorokkal elválasztott bekezdésekkel.
      tok.split(/\r?\n[ \t]*\r?\n/).forEach((part, n) => {
        if (n) flush();
        const run: NewsRun = { text: decodeEntities(part.replace(/\s+/g, " ")) };
        if (bold) run.bold = true;
        if (italic) run.italic = true;
        const href = links[links.length - 1];
        if (href) run.href = href;
        cur.push(run);
      });
      continue;
    }
    const tag = rawTag.toLowerCase();
    const closing = close === "/";
    if (SKIP_TAGS.has(tag)) {
      skip = Math.max(0, skip + (closing ? -1 : 1));
      continue;
    }
    if (skip) continue;
    if (BLOCK_TAGS.has(tag)) flush();
    else if (tag === "br") {
      // két egymást követő <br> bekezdéshatár, egy sima sortörés
      const k = cur.findLastIndex((r) => r.text.trim() || r.text === "\n");
      if (k >= 0 && cur[k].text === "\n") {
        cur = cur.slice(0, k);
        flush();
      } else cur.push({ text: "\n" });
    }
    else if (tag === "strong" || tag === "b") bold = Math.max(0, bold + (closing ? -1 : 1));
    else if (tag === "em" || tag === "i") italic = Math.max(0, italic + (closing ? -1 : 1));
    else if (tag === "a") {
      if (closing) links.pop();
      else links.push(safeHref(attr(attrs ?? "", "href") ?? ""));
    }
  }
  flush();
  return paras;
}

// ── bekezdések → blokkok ───────────────────────────────────────────────

const plain = (runs: NewsRun[]) => runs.map((r) => r.text).join("");
const endsWithAny = (s: string, chars: string) => chars.includes(s.trimEnd().slice(-1));
const ABBREV_END = /\b(stb|pl|ill|kb|ún|vö|ld|sz|u)\.$/i;

/** A darabok kettévágása a teljes szöveg `at` pozíciójánál. */
function splitRunsAt(runs: NewsRun[], at: number): [NewsRun[], NewsRun[]] {
  const before: NewsRun[] = [];
  const after: NewsRun[] = [];
  let pos = 0;
  for (const r of runs) {
    const end = pos + r.text.length;
    if (end <= at) before.push(r);
    else if (pos >= at) after.push(r);
    else {
      before.push({ ...r, text: r.text.slice(0, at - pos) });
      after.push({ ...r, text: r.text.slice(at - pos) });
    }
    pos = end;
  }
  return [before, after];
}

/** A felsorolás-tétel záró „;” / „,” / „.” jele nélkül (a rövidítés pontja marad). */
function stripItemEnd(runs: NewsRun[]): NewsRun[] {
  const text = plain(runs).trimEnd();
  const drop = /[;,]$/.test(text) || (text.endsWith(".") && !text.endsWith("..") && !ABBREV_END.test(text)) ? 1 : 0;
  if (!drop) return runs;
  return tidy(splitRunsAt(runs, text.length - drop)[0]);
}

/** „Felső-Majláth végállomásról: 17:00, 18:00” → címke + tartalom. */
function splitLead(runs: NewsRun[]): NewsListItem | null {
  const text = plain(runs);
  const colon = text.indexOf(": ");
  if (colon <= 0 || colon > LEAD_MAX || /[,;]/.test(text.slice(0, colon))) return null;
  const [lead, rest] = splitRunsAt(runs, colon);
  const after = tidy(splitRunsAt(rest, 1)[1]);
  if (lead.some((r) => r.href) || !plain(after).trim()) return null;
  return { lead: tidy(lead), runs: after };
}

function listItem(runs: NewsRun[]): NewsListItem {
  const body = stripItemEnd(runs);
  return splitLead(body) ?? { lead: null, runs: body };
}

const TIME_RE = /\d:\d{2}/;

function isHeading(runs: NewsRun[], hasNext: boolean): boolean {
  const text = plain(runs).trim();
  if (!hasNext || !text || runs.some((r) => r.href) || text.includes("\n")) return false;
  const allBold = runs.every((r) => r.bold || !r.text.trim());
  // a félkövér kérdés is alcím („Hogyan tölthető le az új alkalmazás?”)
  const question = allBold && text.endsWith("?");
  if ((!question && endsWithAny(text, ".;:,!?…)\"”")) || text.includes(": ") || TIME_RE.test(text)) return false;
  return text.length <= (allBold ? 100 : HEADING_MAX) && /\p{L}/u.test(text);
}

function isLabel(runs: NewsRun[], hasNext: boolean): boolean {
  const text = plain(runs).trim();
  return hasNext && text.endsWith(":") && text.length <= HEADING_MAX && !text.includes("\n") && !text.slice(0, -1).includes(": ");
}

const endsWith = (runs: NewsRun[], ch: string) => plain(runs).trimEnd().endsWith(ch);

/** Az `i`-től kezdődő felsorolás vége (kizárólagos), vagy `i`, ha ott nincs lista. */
function listEnd(paras: NewsRun[][], i: number): number {
  // „;”-vel (vagy „,”-vel) záruló tételek, az utolsó „.”-tal
  for (const sep of [";", ","]) {
    if (!endsWith(paras[i], sep)) continue;
    let j = i;
    while (j < paras.length && endsWith(paras[j], sep)) j++;
    const closed = j < paras.length && endsWith(paras[j], ".");
    if (closed) j++;
    // vesszős sorozatnál a pont kötelező: anélkül inkább egy széttört mondat
    if (j - i >= 2 && (closed || sep === ";")) return j;
  }
  // „Végállomásról: 08:10, 09:15” sorok egymás után
  let j = i;
  while (j < paras.length && splitLead(stripItemEnd(paras[j]))) j++;
  return j - i >= 2 ? j : i;
}

/**
 * A hivatalos szövegben a felsorolás egymás utáni, „;”-vel záruló
 * bekezdésekként érkezik (az utolsó „.”-tal), a menetrendi kivonat pedig
 * „Végállomásról: időpontok” sorokként — ezekből lista lesz. A rövid,
 * írásjel nélküli sorok („34-es autóbusz-viszonylat”) alcímek, a rövid,
 * kettősponttal záruló bevezetők címkék.
 */
export function blocksOf(paras: NewsRun[][]): NewsBlock[] {
  const blocks: NewsBlock[] = [];
  let i = 0;
  while (i < paras.length) {
    const j = listEnd(paras, i);
    if (j > i) {
      blocks.push({ kind: "list", items: paras.slice(i, j).map(listItem) });
      i = j;
      continue;
    }
    const hasNext = i < paras.length - 1;
    const kind = isHeading(paras[i], hasNext) ? "h" : isLabel(paras[i], hasNext) ? "label" : "p";
    blocks.push({ kind, runs: paras[i] });
    i++;
  }
  return blocks;
}

// ── hivatkozások és járatok a szövegben ────────────────────────────────

const URL_RE = /https?:\/\/[^\s<>"'„”]+/g;

/** A szövegben csupaszon álló címek („https://mvkzrt.hu/…”) kattinthatók lesznek. */
function markLinks(runs: NewsRun[]): NewsRun[] {
  const out: NewsRun[] = [];
  for (const r of runs) {
    if (r.href) {
      out.push(r);
      continue;
    }
    let last = 0;
    for (const m of r.text.matchAll(URL_RE)) {
      const url = m[0].replace(/[.,;:!?)\]]+$/, "");
      const href = safeHref(url);
      if (!href) continue;
      out.push({ ...r, text: r.text.slice(last, m.index) });
      out.push({ ...r, text: url, href });
      last = m.index + url.length;
    }
    out.push({ ...r, text: r.text.slice(last) });
  }
  return mergeRuns(out);
}

/**
 * „34-es”, „20-as”, „12G-s”, „AU1-es”, „ZOO viszonylat”, „1V villamos”. A
 * csupa számjegyű jelzéshez kötőjeles rag kell (a „10 járat” darabszám),
 * időpont („07:40-től”) és évszám („2026-os”) elé nem nyúlunk.
 */
const ROUTE_RE = /(?<![\p{L}\p{N}.:/–-])(\d{1,3}(?:[A-Z]{1,2}\d?)?|[A-Z]{2,3}\d?)(?:(-[aeoöá]?s\p{Ll}*)|(?=\s+(?:villamos|autóbusz|busz|troli|viszonylat|járat|vonal)))/gu;
/** zárójeles járatfelsorolás: „(4, 18, 23, 32, 45, 54, 122)”, „(3/3B, 20, 20B)” */
const ROUTE_LIST_RE = /\((\d{1,3}[A-Z]{0,2}(?:\/\d{1,3}[A-Z]{0,2})*(?:,\s*\d{1,3}[A-Z]{0,2}(?:\/\d{1,3}[A-Z]{0,2})*)+)\)/g;

type Resolve = (token: string, tram: boolean) => string | null;

function routeResolver(routes: Iterable<RouteLike>): Resolve {
  const byShort = new Map<string, string>();
  for (const r of routes) if (!byShort.has(r.short)) byShort.set(r.short, r.id);
  return (token, tram) => {
    if (tram && /^\d+$/.test(token)) {
      const v = byShort.get(`${token}V`);
      if (v) return v;
    }
    return byShort.get(token) ?? null;
  };
}

type Span = { start: number; end: number; id: string };

function routeSpans(text: string, resolve: Resolve): Span[] {
  const spans: Span[] = [];
  for (const m of text.matchAll(ROUTE_RE)) {
    const token = m[1];
    if (m[2] === undefined && !/[A-Z]/.test(token)) continue;
    const tram = /^\s+villamos/.test(text.slice(m.index + m[0].length));
    const id = resolve(token, tram);
    if (id) spans.push({ start: m.index, end: m.index + token.length, id });
  }
  for (const m of text.matchAll(ROUTE_LIST_RE)) {
    const base = m.index + 1;
    const tokens = [...m[1].matchAll(/\d{1,3}[A-Z]{0,2}/g)].map((t) => ({ t, id: resolve(t[0], false) }));
    // csak ha tényleg járatlista (a fele ismert jelzés), nem pl. oldalszámok
    if (tokens.filter((x) => x.id).length * 2 < tokens.length) continue;
    for (const { t, id } of tokens) if (id) spans.push({ start: base + t.index, end: base + t.index + t[0].length, id });
  }
  spans.sort((a, b) => a.start - b.start);
  return spans.filter((s, k) => k === 0 || s.start >= spans[k - 1].end);
}

function markRoutes(runs: NewsRun[], resolve: Resolve): NewsRun[] {
  const out: NewsRun[] = [];
  for (const r of runs) {
    if (r.href || r.route) {
      out.push(r);
      continue;
    }
    let last = 0;
    for (const s of routeSpans(r.text, resolve)) {
      out.push({ ...r, text: r.text.slice(last, s.start) });
      out.push({ ...r, text: r.text.slice(s.start, s.end), route: s.id });
      last = s.end;
    }
    out.push({ ...r, text: r.text.slice(last) });
  }
  return mergeRuns(out);
}

function mapBlockRuns(b: NewsBlock, fn: (runs: NewsRun[]) => NewsRun[]): NewsBlock {
  if (b.kind !== "list") return { ...b, runs: fn(b.runs) };
  return { kind: "list", items: b.items.map((it) => ({ lead: it.lead ? fn(it.lead) : null, runs: fn(it.runs) })) };
}

function routesOf(blocks: NewsBlock[]): string[] {
  const seen = new Set<string>();
  const visit = (runs: NewsRun[] | null) => runs?.forEach((r) => r.route && seen.add(r.route));
  for (const b of blocks) {
    if (b.kind === "list") b.items.forEach((it) => (visit(it.lead), visit(it.runs)));
    else visit(b.runs);
  }
  return [...seen];
}

// ── egy hír ────────────────────────────────────────────────────────────

/** Az MVK zóna nélküli helyi ideje („2026-10-30T13:34:38.017”) unixként. */
export function budapestLocalToUnix(s: unknown): number | null {
  const m = typeof s === "string" ? /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s) : null;
  if (!m) return null;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) / 1000;
  if (!Number.isFinite(naive)) return null;
  return naive - budapestOffsetSec(naive - budapestOffsetSec(naive));
}

function summaryOf(blocks: NewsBlock[]): string {
  const first = blocks.find((b) => b.kind === "p") ?? blocks.find((b) => b.kind === "list") ?? blocks[0];
  const text = (first?.kind === "list" ? first.items.map((it) => plain([...(it.lead ?? []), ...it.runs])).join("; ") : first ? plain(first.runs) : "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= SUMMARY_MAX) return text;
  const cut = text.slice(0, SUMMARY_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > SUMMARY_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/, "")}…`;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Az MVK válasza → a kliensnek szánt lista: a legutóbb módosított elöl, a
 * lejártak nélkül, csak a ténylegesen említett járatok színeivel.
 */
export function normalizeNews(raw: unknown, routes: Iterable<RouteLike>, now: number): { items: NewsItem[]; routes: Record<string, NewsRoute> } {
  const all = [...routes];
  const resolve = routeResolver(all);
  const seen = new Set<number>();
  const items: NewsItem[] = [];
  for (const x of Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []) {
    const id = Number(x?.id);
    const title = decodeEntities(str(x?.title)).replace(/\s+/g, " ").trim();
    if (!Number.isInteger(id) || !title || seen.has(id)) continue;
    const validUntil = budapestLocalToUnix(x.validityEnd);
    if (validUntil != null && validUntil <= now) continue;
    seen.add(id);
    const body = str(x.longContent) || str(x.shortContent);
    const blocks = blocksOf(htmlParagraphs(body)).map((b) => mapBlockRuns(b, (r) => markRoutes(markLinks(r), resolve)));
    const type = decodeEntities(str(x.type)).trim();
    const validFrom = budapestLocalToUnix(x.validityStart);
    items.push({
      id,
      title,
      type: type && !GENERIC_TYPES.has(type.toLowerCase()) ? type : null,
      modifiedAt: budapestLocalToUnix(x.modifiedTime) ?? validFrom ?? now,
      validFrom,
      validUntil,
      summary: summaryOf(blocks),
      routes: [...new Set([...markRoutes([{ text: title }], resolve).flatMap((r) => (r.route ? [r.route] : [])), ...routesOf(blocks)])],
      blocks,
    });
  }
  items.sort((a, b) => b.modifiedAt - a.modifiedAt || b.id - a.id);
  const used = new Set(items.flatMap((it) => it.routes));
  const colors: Record<string, NewsRoute> = {};
  for (const r of all) if (used.has(r.id)) colors[r.id] = { short: r.short, color: r.color, text: r.text };
  return { items, routes: colors };
}
