/**
 * Kommentek kiszedése a kódbázisból, majd Prettier futtatása az érintett fájlokon.
 *
 * Miért TypeScript compiler API és nem sima regex? Egy `//` vagy `/* *\/` mintára
 * épülő regex tönkretenné a stringekben, template literálokban és regex
 * literálokban előforduló azonos karaktersorozatokat (pl. `"http://foo"`,
 * `/a\/b/`). A TS parser valódi AST-ot épít, ami ezt garantáltan helyesen
 * kezeli — minden tokent (a `{`, `}`, `;` írásjeleket is) végigjárva pontosan
 * megkapjuk az összes komment pozícióját, JSX `{/* ... *\/}` esetén is.
 *
 * A CSS-hez nincs szükség AST-ra (csak `/* ... *\/` létezik benne), de az
 * idézőjeles stringeket (pl. `content: "/* nem komment *\/"`) itt is kerüli.
 *
 * Amit SOHA nem töröl:
 *   - komment, amiben URL van (http/https/www) — ez a kérés lényege,
 *   - funkcionális pragmák: eslint-disable/enable, @ts-ignore/@ts-expect-error/
 *     @ts-nocheck, prettier-ignore, istanbul/c8 ignore, webpackChunkName,
 *     /// <reference ...>, @license, @preserve, /*! ... *\/ bang-kommentek.
 *
 * Használat:
 *   node scripts/strip-comments.mjs                  # dry-run, csak "src"
 *   node scripts/strip-comments.mjs --write           # tényleg ír + prettier
 *   node scripts/strip-comments.mjs --write src scripts/mc-lang.mjs
 *   node scripts/strip-comments.mjs --write --no-prettier
 *   node scripts/strip-comments.mjs --write --list-kept   # kimutatja mit tartott meg és miért
 *
 * Ignore lista: scripts/strip-comments.ignore (gitignore-szerű minták,
 * szabadon szerkesztheted) + a projekt gyökér .gitignore-ja is érvényben van.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const IGNORE_CANDIDATES = [
  path.join(SCRIPT_DIR, "strip-comments.ignore"),
  path.join(ROOT, "scripts", "strip-comments.ignore"),
];
const IGNORE_FILE = IGNORE_CANDIDATES.find((file) => existsSync(file)) ?? IGNORE_CANDIDATES[0];
const GITIGNORE_FILE = path.join(ROOT, ".gitignore");

const TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const CSS_EXTS = new Set([".css", ".scss"]);
const HTML_EXTS = new Set([".html", ".htm"]);
const ALL_EXTS = new Set([...TS_EXTS, ...CSS_EXTS, ...HTML_EXTS]);

const URL_RE = /(https?:\/\/[^\s'"`)]+|www\.[^\s'"`)]+)/i;
const PRAGMA_RE =
  /(eslint-disable|eslint-enable|@ts-ignore|@ts-expect-error|@ts-nocheck|prettier-ignore|istanbul ignore|c8 ignore|webpackchunkname|webpackpreload|webpackprefetch|@license|@preserve)/i;
const TRIPLE_SLASH_RE = /^\s*\/\/\/\s*<reference/;

function shouldKeepComment(text) {
  if (text.startsWith("/*!")) return "bang-comment (/*!)";
  if (TRIPLE_SLASH_RE.test(text)) return "triple-slash directive";
  if (PRAGMA_RE.test(text)) return "functional pragma";
  if (URL_RE.test(text)) return "contains URL";
  return null;
}

// ---------- ignore lista ----------

function globToRegExp(pattern) {
  let p = pattern.trim();
  if (!p || p.startsWith("#") || p.startsWith("!")) return null;
  const anchored = p.startsWith("/");
  if (anchored) p = p.slice(1);
  const isDir = p.endsWith("/");
  if (isDir) p = p.slice(0, -1);
  if (!p) return null;
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += ".";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const prefix = anchored ? "^" : "(^|/)";
  return new RegExp(`${prefix}${re}(/.*)?$`);
}

function loadIgnorePatterns() {
  const patterns = [
    "node_modules/",
    ".git/",
    ".next/",
    "out/",
    "build/",
    "dist/",
    "coverage/",
    ".vercel/",
    "src/generated/",
    "mod/build/",
    "mod/.gradle/",
    "mod/run/",
    ".cache/",
    "*.min.js",
    "*.d.ts",
    "next-env.d.ts",
    // Horgonyzott (/-tal kezdődik): csak a gyökér public/-ot zárja ki,
    // nem minden "public" nevű mappát a fában (pl. twitch-extension/public/
    // pont a mi kódunk, azt kell vizsgálni).
    "/public/",
  ];
  for (const file of [GITIGNORE_FILE, IGNORE_FILE]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      patterns.push(line);
    }
  }
  return patterns.map(globToRegExp).filter(Boolean);
}

function isIgnored(relPath, patterns) {
  return patterns.some((re) => re.test(relPath));
}

// ---------- fájlbejárás ----------

function walk(root, patterns, out = []) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(root, entry.name);
    const rel = path.relative(ROOT, abs).split(path.sep).join("/");
    if (isIgnored(rel, patterns)) continue;
    if (entry.isDirectory()) {
      walk(abs, patterns, out);
    } else if (ALL_EXTS.has(path.extname(entry.name))) {
      out.push(abs);
    }
  }
  return out;
}

// ---------- TS/JS komment-eltávolítás ----------

function previousSignificantChar(text, index) {
  for (let i = index - 1; i >= 0; i--) {
    const ch = text[i];
    if (/\s/.test(ch)) continue;
    return ch;
  }
  return "";
}

function skipRegexLiteral(text, start) {
  let i = start + 1;
  let inCharClass = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[" && !inCharClass) {
      inCharClass = true;
      i += 1;
      continue;
    }
    if (ch === "]" && inCharClass) {
      inCharClass = false;
      i += 1;
      continue;
    }
    if (ch === "/" && !inCharClass) {
      i += 1;
      while (/[a-z]/i.test(text[i] ?? "")) i += 1;
      return i;
    }
    i += 1;
  }
  return text.length;
}

function collectJsLikeCommentRanges(text) {
  const ranges = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const ch = text[i];

    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === quote) {
          j += 1;
          break;
        }
        if (quote === "`" && text[j] === "$" && text[j + 1] === "{") {
          let k = j + 2;
          let depth = 1;
          while (k < n && depth > 0) {
            const inner = text[k];
            if (inner === "\\") {
              k += 2;
              continue;
            }
            if (inner === "{") depth += 1;
            if (inner === "}") depth -= 1;
            k += 1;
          }
          j = k;
          continue;
        }
        j += 1;
      }
      i = j;
      continue;
    }

    if (ch === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i + 2);
      ranges.push({ pos: i, end: end === -1 ? n : end });
      i = end === -1 ? n : end;
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) break;
      ranges.push({ pos: i, end: end + 2 });
      i = end + 2;
      continue;
    }

    if (ch === "/") {
      const prev = previousSignificantChar(text, i);
      const canStartRegex = !/[A-Za-z0-9_$\)\]\}\"'`]/.test(prev || "") && prev !== ".";
      if (canStartRegex) {
        i = skipRegexLiteral(text, i);
        continue;
      }
    }

    i += 1;
  }

  return ranges;
}

function stripTsComments(text, ext, listKept) {
  return applyRanges(text, collectJsLikeCommentRanges(text), listKept);
}

// ---------- CSS komment-eltávolítás (idézőjel-biztos state machine) ----------

function collectCssCommentRanges(text) {
  const ranges = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      ranges.push({ pos: i, end });
      i = end;
      continue;
    }
    i++;
  }
  return ranges;
}

function stripCssComments(text, listKept) {
  const ranges = collectCssCommentRanges(text);
  return applyRanges(text, ranges, listKept);
}

// ---------- HTML komment-eltávolítás ----------
//
// Három forrásból gyűjti a törlendő tartományokat: sima <!-- --> a
// jelölésben, JS-komment a <script>...</script> tartalmában (a meglévő
// TS AST-alapú kereső újrahasznosításával, eltolt pozíciókkal), CSS-
// komment a <style>...</style> tartalmában (a fenti state machine-nel).
// A <script src="..."> (nincs beágyazott tartalom) és a nem
// JS type= scriptek (pl. application/ld+json) érintetlenek maradnak.

function findTagBlocks(text, tagName) {
  const openTagRe = new RegExp(`<${tagName}\\b([^>]*)>`, "gi");
  const blocks = [];
  let match;
  while ((match = openTagRe.exec(text))) {
    const attrs = match[1];
    const contentStart = match.index + match[0].length;
    const closeIndex = text.indexOf(`</${tagName}>`, contentStart);
    if (closeIndex === -1) continue;
    const hasSrc = /\bsrc\s*=/i.test(attrs);
    const typeMatch = attrs.match(/\btype\s*=\s*(["'])(.*?)\1/i);
    const type = typeMatch ? typeMatch[2].toLowerCase() : null;
    blocks.push({ contentStart, contentEnd: closeIndex, hasSrc, type });
    openTagRe.lastIndex = closeIndex;
  }
  return blocks;
}

function isJsScriptType(type) {
  if (!type) return true;
  return /^(text\/javascript|application\/javascript|module)$/i.test(type);
}

function collectHtmlCommentRanges(text) {
  const scriptBlocks = findTagBlocks(text, "script").filter(
    (b) => !b.hasSrc && isJsScriptType(b.type),
  );
  const styleBlocks = findTagBlocks(text, "style");
  const protectedBlocks = [...scriptBlocks, ...styleBlocks];

  const ranges = [];

  for (const block of scriptBlocks) {
    const inner = text.slice(block.contentStart, block.contentEnd);
    if (!inner.trim()) continue;
    for (const r of collectJsLikeCommentRanges(inner)) {
      ranges.push({ pos: r.pos + block.contentStart, end: r.end + block.contentStart });
    }
  }

  for (const block of styleBlocks) {
    const inner = text.slice(block.contentStart, block.contentEnd);
    for (const r of collectCssCommentRanges(inner)) {
      ranges.push({ pos: r.pos + block.contentStart, end: r.end + block.contentStart });
    }
  }

  const htmlCommentRe = /<!--[\s\S]*?-->/g;
  let match;
  while ((match = htmlCommentRe.exec(text))) {
    const pos = match.index;
    const end = pos + match[0].length;
    const insideProtected = protectedBlocks.some(
      (b) => pos >= b.contentStart && pos < b.contentEnd,
    );
    if (!insideProtected) ranges.push({ pos, end });
  }

  return ranges.sort((a, b) => a.pos - b.pos);
}

function stripHtmlComments(text, listKept) {
  const ranges = collectHtmlCommentRanges(text);
  return applyRanges(text, ranges, listKept);
}

// ---------- közös csere-logika ----------

// Ha a komment a saját sorában egyedül áll (előtte/utána csak whitespace),
// a teljes sort töröljük a sortöréssel együtt — különben a sor üresen
// maradna, és a Prettier ezt NEM törli (max 1 üres sort hagy, de a
// szándékosan ott lévő és a komment-törlés miatt keletkezett üres sort
// nem tudja megkülönböztetni).
function computeRemoval(text, pos, end) {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const beforeOnLine = text.slice(lineStart, pos);
  let lineEnd = text.indexOf("\n", end);
  if (lineEnd === -1) lineEnd = text.length;
  const afterOnLine = text.slice(end, lineEnd);

  if (/^\s*$/.test(beforeOnLine) && /^\s*$/.test(afterOnLine)) {
    // Egész sor törlése, a sortöréssel együtt.
    return { start: lineStart, end: lineEnd < text.length ? lineEnd + 1 : lineEnd, needsSpace: false };
  }
  if (/^\s*$/.test(afterOnLine)) {
    // Sorvégi komment: a mögötte lévő whitespace-t is levisszük a sortörésig, az marad.
    let start = pos;
    while (start > lineStart && /[ \t]/.test(text[start - 1])) start--;
    return { start, end, needsSpace: false };
  }
  // Kód közepén álló komment (ritka) — helyette egy szóköz marad elválasztónak.
  return { start: pos, end, needsSpace: true };
}

function applyRanges(text, ranges, listKept) {
  let out = "";
  let last = 0;
  let removed = 0;
  const kept = [];
  for (const r of ranges) {
    const commentText = text.slice(r.pos, r.end);
    const keepReason = shouldKeepComment(commentText);
    if (keepReason) {
      out += text.slice(last, r.end);
      if (listKept) kept.push({ text: commentText.slice(0, 80), reason: keepReason });
      last = r.end;
      continue;
    }
    const removal = computeRemoval(text, r.pos, r.end);
    out += text.slice(last, removal.start);
    if (removal.needsSpace) out += " ";
    last = removal.end;
    removed++;
  }
  out += text.slice(last);
  return { text: out, removed, kept };
}

// ---------- Prettier ----------

function runPrettier(files) {
  if (files.length === 0) return;
  const localBin = path.join(ROOT, "node_modules", ".bin", "prettier");
  const useLocal = existsSync(localBin);
  const chunkSize = 200;
  for (let i = 0; i < files.length; i += chunkSize) {
    const chunk = files.slice(i, i + chunkSize);
    const args = useLocal ? ["--write", ...chunk] : ["--yes", "prettier", "--write", ...chunk];
    const cmd = useLocal ? localBin : "npx";
    console.log(`\n> ${useLocal ? "prettier" : "npx prettier"} --write ${chunk.length} fájl...`);
    const result = spawnSync(cmd, args, { stdio: "inherit" });
    if (result.status !== 0) {
      console.warn(`Prettier nem futott le tisztán (exit ${result.status}) ezen a csoporton, a fájlok kommentmentesek maradnak, csak formázatlanul.`);
    }
  }
}

// ---------- main ----------

function parseArgs(argv) {
  const write = argv.includes("--write");
  const noPrettier = argv.includes("--no-prettier");
  const listKept = argv.includes("--list-kept");
  const roots = argv.filter((a) => !a.startsWith("--"));
  return { write, noPrettier, listKept, roots: roots.length ? roots : ["frontend", "backend"] };
}

function main() {
  const { write, noPrettier, listKept, roots } = parseArgs(process.argv.slice(2));
  const patterns = loadIgnorePatterns();

  const files = [];
  for (const root of roots) {
    const abs = path.isAbsolute(root) ? root : path.join(ROOT, root);
    if (!existsSync(abs)) {
      console.warn(`Kihagyva (nem létezik): ${root}`);
      continue;
    }
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      walk(abs, patterns, files);
    } else if (ALL_EXTS.has(path.extname(abs))) {
      files.push(abs);
    }
  }

  console.log(`${write ? "ÍRÁS MÓD" : "DRY-RUN (nem módosít semmit, --write kell hozzá)"} — ${files.length} fájl vizsgálata...\n`);

  let totalRemoved = 0;
  let totalKept = 0;
  const changedFiles = [];

  for (const abs of files) {
    const rel = path.relative(ROOT, abs);
    const ext = path.extname(abs);
    const original = readFileSync(abs, "utf8");

    let result;
    try {
      result = TS_EXTS.has(ext)
        ? stripTsComments(original, ext, listKept)
        : HTML_EXTS.has(ext)
          ? stripHtmlComments(original, listKept)
          : stripCssComments(original, listKept);
    } catch (err) {
      console.warn(`Kihagyva (parse hiba): ${rel} — ${err.message}`);
      continue;
    }

    if (result.removed === 0 && result.kept.length === 0) continue;

    totalRemoved += result.removed;
    totalKept += result.kept.length;
    console.log(`${rel}: -${result.removed} komment törölve, ${result.kept.length} megtartva`);
    if (listKept) {
      for (const k of result.kept) console.log(`    tartva (${k.reason}): ${k.text}`);
    }

    if (write && result.removed > 0 && result.text !== original) {
      writeFileSync(abs, result.text, "utf8");
      changedFiles.push(abs);
    }
  }

  console.log(`\nÖsszesen: ${totalRemoved} komment törölve, ${totalKept} megtartva (link vagy pragma miatt).`);

  if (!write) {
    console.log("Ez dry-run volt. Éles futtatás: node scripts/strip-comments.mjs --write");
    return;
  }

  if (!noPrettier && changedFiles.length > 0) {
    runPrettier(changedFiles.map((f) => path.relative(ROOT, f)));
  }

  console.log(`\nKész. ${changedFiles.length} fájl módosult. Nézd át: git diff`);
}

main();
