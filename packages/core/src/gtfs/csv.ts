/**
 * RFC 4180-es CSV-olvasó. A régi kód egyszerűen vesszőnél vágott, ami egy
 * idézőjeles, vesszőt tartalmazó mezőnél (pl. „Miskolctapolca, Barlangfürdő”)
 * eltolta volna az összes oszlopot.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  if (!rows.length) return [];

  const head = rows[0].map((h) => h.trim());
  const out: Record<string, string>[] = new Array(rows.length - 1);
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    const obj: Record<string, string> = {};
    for (let j = 0; j < head.length; j++) obj[head[j]] = (cols[j] ?? "").trim();
    out[r - 1] = obj;
  }
  return out;
}
