import { describe, expect, it } from "vitest";
import { blocksOf, budapestLocalToUnix, decodeEntities, htmlParagraphs, normalizeNews, type NewsBlock, type NewsRun } from "../src/news.ts";

const ROUTES = [
  { id: "1", short: "1", color: "47897B", text: "FFFFFF" },
  { id: "1V", short: "1V", color: "FDEA00", text: "000000" },
  { id: "2V", short: "2V", color: "FDCC00", text: "000000" },
  { id: "4", short: "4", color: "54698E", text: "FFFFFF" },
  { id: "18", short: "18", color: "D55E20", text: "FFFFFF" },
  { id: "34", short: "34", color: "F5AA46", text: "000000" },
  { id: "12G", short: "12G", color: "625244", text: "FFFFFF" },
  { id: "AU1", short: "AU1", color: "CC7371", text: "FFFFFF" },
  { id: "ZOO", short: "ZOO", color: "8EBC2D", text: "000000" },
];
const NOW = Date.parse("2026-10-31T05:00:00Z") / 1000;

const plain = (runs: NewsRun[]) => runs.map((r) => r.text).join("");
const routesIn = (runs: NewsRun[]) => runs.filter((r) => r.route).map((r) => `${r.text}→${r.route}`);
const news = (over: Record<string, unknown>) => ({
  id: 1,
  title: "Cím",
  type: "Egyéb",
  shortContent: "Cím",
  longContent: "<p>Szöveg.</p>",
  modifiedTime: "2026-10-28T09:57:19.3",
  validityStart: "2026-10-28T00:00:00",
  validityEnd: "2026-11-28T00:00:00",
  ...over,
});
/** egyetlen hír blokkjai, a járatfelismeréssel együtt */
const blocks = (html: string): NewsBlock[] => normalizeNews([news({ longContent: html })], ROUTES, NOW).items[0].blocks;
const runsOf = (b: NewsBlock): NewsRun[] => (b.kind === "list" ? b.items.flatMap((it) => [...(it.lead ?? []), ...it.runs]) : b.runs);

describe("entitások", () => {
  it("a magyar ékezetek, a gondolatjel és a számos alak is visszajön", () => {
    expect(decodeEntities("okt&oacute;ber &ndash; h&eacute;tfő &Scaron;koda &#337; &#x171;")).toBe("október – hétfő Škoda ő ű");
  });

  it("az ismeretlen entitás érintetlen marad, az érvénytelen kódpont eltűnik", () => {
    expect(decodeEntities("&foo; &#xD800;x")).toBe("&foo; x");
  });
});

describe("HTML → bekezdések", () => {
  it("a formázás darabokra bomlik, az üres (&nbsp;) bekezdés elmarad", () => {
    const p = htmlParagraphs("<p>Az <strong>MVK</strong> <em>járatai</em></p><p>&nbsp;</p>");
    expect(p).toHaveLength(1);
    expect(p[0]).toEqual([{ text: "Az " }, { text: "MVK", bold: true }, { text: " " }, { text: "járatai", italic: true }]);
  });

  it("csak biztonságos hivatkozás marad; a script tartalma eltűnik", () => {
    const p = htmlParagraphs('<p><a href="javascript:alert(1)">rossz</a> <a target="_blank" href="https://mvkzrt.hu/x">jó</a><script>alert(2)</script></p>');
    expect(p[0]).toEqual([{ text: "rossz " }, { text: "jó", href: "https://mvkzrt.hu/x" }]);
  });

  it("a dupla <br> és a sima szövegben álló üres sor bekezdéshatár, a forrás sortörése szóköz", () => {
    expect(htmlParagraphs("<p>egy<br><br>kettő<br>három</p>").map(plain)).toEqual(["egy", "kettő\nhárom"]);
    expect(htmlParagraphs("<p>első\r\nsor\r\n\r\nmásodik</p>").map(plain)).toEqual(["első sor", "második"]);
  });
});

describe("bekezdések → blokkok", () => {
  const P = (...texts: string[]) => texts.map((text) => [{ text }]);

  it("a „;”-vel záruló bekezdések listát adnak, a záró ponttal együtt, írásjel nélkül", () => {
    const b = blocksOf(P("A tanszüneti menetrend ideje alatt:", "nem közlekednek a villamosok;", "a 16-os nem érinti a kórházat;", "a 35-ös nem áll meg."));
    expect(b.map((x) => x.kind)).toEqual(["label", "list"]);
    const list = b[1];
    expect(list.kind === "list" && list.items.map((it) => plain(it.runs))).toEqual(["nem közlekednek a villamosok", "a 16-os nem érinti a kórházat", "a 35-ös nem áll meg"]);
  });

  it("a „Végállomásról: időpontok” sorokból címkés lista lesz", () => {
    const b = blocksOf(P("34-es autóbusz-viszonylat", "Avas kilátó végállomásról: 15:20, 16:20;", "Bodótető végállomásról: 15:50, 16:50."));
    expect(b[0].kind).toBe("h");
    expect(b[1].kind === "list" && b[1].items.map((it) => [plain(it.lead ?? []), plain(it.runs)])).toEqual([
      ["Avas kilátó végállomásról", "15:20, 16:20"],
      ["Bodótető végállomásról", "15:50, 16:50"],
    ]);
  });

  it("időpontos vagy ponttal záruló rövid sor nem alcím; az utolsó bekezdés sem", () => {
    expect(blocksOf(P("Miskolci Állatkert végállomásról 19:05-kor", "induló járatok is közlekednek.")).map((x) => x.kind)).toEqual(["p", "p"]);
    expect(blocksOf(P("Kérjük megértésüket!", "MVK Zrt")).map((x) => x.kind)).toEqual(["p", "p"]);
  });

  it("vesszős sorozat csak ponttal lezárva lista (különben széttört mondat)", () => {
    expect(blocksOf(P("Emellett a közlekedő,", "Felső-Majláth végállomásról 18:55-kor,", "induló járatok")).map((x) => x.kind)).toEqual(["p", "p", "p"]);
    expect(blocksOf(P("Hejőcsabai városrész,", "Hejőcsabai gyógyszertár.")).map((x) => x.kind)).toEqual(["list"]);
  });
});

describe("járatok a szövegben", () => {
  it("a ragos jelzés a GTFS-ből; a villamos a V-s járat", () => {
    const [b] = blocks("<p>az 1-es, a 18-as és az AU1-es járatok, valamint az 1-es villamos és a 12G-s busz</p>");
    expect(routesIn(runsOf(b))).toEqual(["1→1", "18→18", "AU1→AU1", "1→1V", "12G→12G"]);
    expect(plain(runsOf(b))).toBe("az 1-es, a 18-as és az AU1-es járatok, valamint az 1-es villamos és a 12G-s busz");
  });

  it("évszám, időpont, darabszám és ismeretlen jelzés nem járat", () => {
    const [b] = blocks("<p>a 2026-os felmérés 07:40-től, 10 járat, a 122-es és a 203-as pályaszámú villamos</p>");
    expect(routesIn(runsOf(b))).toEqual([]);
  });

  it("betűs jelzés rag nélkül is, ha járat/viszonylat követi; zárójeles felsorolás", () => {
    const [b] = blocks("<p>extra ZOO járatok és az 1V villamosviszonylat, módosul (4, 18, 122)</p>");
    expect(routesIn(runsOf(b))).toEqual(["ZOO→ZOO", "1V→1V", "4→4", "18→18"]);
  });

  it("a csupasz cím hivatkozás lesz, a mondatzáró pont nélkül", () => {
    const [b] = blocks("<p>Részletek: https://mvkzrt.hu/hirek/a-b.</p>");
    expect(runsOf(b).find((r) => r.href)).toEqual({ text: "https://mvkzrt.hu/hirek/a-b", href: "https://mvkzrt.hu/hirek/a-b" });
  });
});

describe("normalizeNews", () => {
  it("a legutóbb módosított elöl, a lejárt nélkül; az „Egyéb” típus null", () => {
    const { items } = normalizeNews(
      [
        news({ id: 1, modifiedTime: "2026-10-21T15:03:34.18" }),
        news({ id: 2, modifiedTime: "2026-10-30T13:34:38.017", type: "Rendezvény" }),
        news({ id: 3, validityEnd: "2026-10-30T00:00:00" }),
        news({ id: 2 }),
        { id: "x", title: "" },
      ],
      ROUTES,
      NOW,
    );
    expect(items.map((x) => x.id)).toEqual([2, 1]);
    expect(items.map((x) => x.type)).toEqual(["Rendezvény", null]);
  });

  it("a kivonat az első bekezdésből, szóhatáron vágva", () => {
    const long = "Mindenszentek napján ".repeat(20);
    const [it] = normalizeNews([news({ longContent: `<p>${long}</p>` })], ROUTES, NOW).items;
    expect(it.summary.length).toBeLessThanOrEqual(171);
    expect(it.summary.endsWith("napján…")).toBe(true);
  });

  it("csak az említett járatok színei mennek ki; a címben lévő járat is számít", () => {
    const out = normalizeNews([news({ title: "Téli üzemszünet a ZOO viszonylaton", longContent: "<p>a 34-es is.</p>" })], ROUTES, NOW);
    expect(out.items[0].routes).toEqual(["ZOO", "34"]);
    expect(Object.keys(out.routes).sort()).toEqual(["34", "ZOO"]);
    expect(out.routes.ZOO).toEqual({ short: "ZOO", color: "8EBC2D", text: "000000" });
  });

  it("az MVK zóna nélküli ideje budapesti helyi idő (télen +1, nyáron +2 óra)", () => {
    expect(budapestLocalToUnix("2026-10-30T13:34:38.017")).toBe(Date.parse("2026-10-30T12:34:38Z") / 1000);
    expect(budapestLocalToUnix("2026-07-01T10:00:00")).toBe(Date.parse("2026-07-01T08:00:00Z") / 1000);
    expect(budapestLocalToUnix("tegnap")).toBeNull();
  });
});
