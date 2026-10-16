import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkGrounding, visibleText } from "./quiz-schema.js";

const ok = (quote: string, doc: string) => checkGrounding({ questions: [{ sourceQuote: quote }] }, doc).ok;
const fixtures = join(__dirname, "../../../evals/fixtures");
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf8");

describe("grounding: what a reader SEES in the rendered document is matchable (real minimal reproducers)", () => {
  const supabase = fixture("supabase-es.md");
  const brazilian = fixture("brazilian-utils-pt.md");

  const accepted: [string, string, string][] = [
    ["inline code span skipped (brazilian-utils line 22)", brazilian, "Node.js, Bun, Deno e navegadores modernos, todos testados no CI."],
    ["inline code span kept", brazilian, "Node.js ^20.19.0 || >=22.12.0, Bun, Deno e navegadores modernos"],
    ["html table cell and the link label next to it (supabase)", supabase, "JavaScript (TypeScript) supabase-js postgrest-js auth-js"],
    ["html table cells joined with commas", supabase, "JavaScript (TypeScript), supabase-js, postgrest-js, auth-js"],
    ["html row: link attributes never leak into the text", supabase, "Flutter supabase-flutter postgrest-dart gotrue-dart"],
    ["html table: the row break is only a separator", "<table><tr><td>Alfa one</td><td>Beta two</td></tr><tr><td>Gamma three</td></tr></table>", "Beta two Gamma three"],
    ["markdown table cells with pipes", "| Node.js | `^20.19.0 \\|\\| >=22.12.0` | 20, 22, 24, 26 |\n| Bun | mais recente | mais recente |", "Bun mais recente mais recente"],
    ["inline tags glue words, entities decode", "<p>Use <b>Super</b>base &amp; Caf&eacute; &#233; &nbsp;now please</p>", "Use Superbase & Café é now please"],
    ["heading quoted with the marker", "# Title\n\n## Instalación rápida del paquete\n\nTexto.", "## Instalación rápida del paquete"],
    ["emphasis and code markers", "Esto es **muy importante** y `no` se puede __omitir__ nunca.", "Esto es muy importante y no se puede omitir nunca"],
    ["ordered list items joined without their numerals", "3. Returns blobs or performs analysis.\n4. Renders output in one of many supported formats.", "Returns blobs or performs analysis. Renders output in one"],
    ["ordered list item quoted with its numeral", "3. Returns blobs or performs analysis.\n4. Renders output in one of many supported formats.", "4. Renders output in one of many supported formats."],
    ["reference-style links", "Follow us on [GitHub][14], [Twitter][15] and [Facebook][16].\n\n[14]: https://github.com/x\n[15]: https://twitter.com/x", "Follow us on GitHub, Twitter and Facebook"],
    ["code fence language is not text", "Then run:\n\n```bash\npod install\n```\n\nAfter installing the cocoapod, import it.", "Then run: pod install After installing the cocoapod"],
    ["image alt text is not text", "## Palettes\n\n![badge](https://x.io/b.svg)\n\nI saved you from boring plots.", "Palettes I saved you from boring plots"],
    ["a comment is not text", "Primera línea del texto.<!-- nota interna --> Segunda línea del texto.", "Primera línea del texto. Segunda línea del texto"],
    ["a literal < is not a tag", "Made with QC <3 Open Source and a lot of love > everything.", "Made with QC <3 Open Source and a lot of love > everything"],
  ];
  it.each(accepted)("accepts: %s", (_n, doc, quote) => expect(ok(quote, doc)).toBe(true));

  const rejected: [string, string, string][] = [
    ["a verb the document does not have (supabase pg_graphql line)", supabase, "pg_graphql es una extensión de PostgreSQL que expone una API GraphQL"],
    ["a one-cell quote (2 words) stays too short", supabase, "JavaScript (TypeScript)"],
    ["a heading alone stays too short", brazilian, "## Licença"],
    ["a changed word inside a table row", supabase, "JavaScript (TypeScript), supabase-js, postgrest-py, auth-js"],
    ["cells of a row reordered", supabase, "postgrest-js supabase-js JavaScript (TypeScript)"],
    ["a word from inside a tag attribute is not text", supabase, "supabase-flutter noopener noreferrer postgrest-dart"],
    ["html entity decoding does not invent words", "<p>Caf&eacute; abierto ahora mismo</p>", "Cafe abierto ahora mismo"],
    ["code span removal does not allow a changed word", brazilian, "Node.js, Bun, Deno e navegadores antigos"],
    ["spliced from non adjacent table rows", "<table><tr><td>Alfa one</td></tr><tr><td>Mid x</td></tr><tr><td>Gamma three</td></tr></table>", "Alfa one Gamma three"],
    ["list numerals do not allow a reorder", "3. Returns blobs or performs analysis.\n4. Renders output in one of many supported formats.", "Renders output in one of many supported formats. Returns blobs or performs analysis"],
    ["fabricated words in a comment", "Primera línea del texto.<!-- nota interna --> Segunda línea del texto.", "Primera línea del texto nota interna Segunda línea"],
  ];
  it.each(rejected)("rejects: %s", (_n, doc, quote) => expect(ok(quote, doc)).toBe(false));

  it("visibleText on the supabase table row reads as the rendered row", () => {
    expect(visibleText('<tr><td>JavaScript (TypeScript)</td><td><a href="https://x.dev/a" target="_blank">supabase-js</a></td></tr>')).toBe("javascript typescript supabase js");
  });
});

/** An independent, deliberately simple "renderer": what a reader reads, as space-separated tokens (it shares no code with visibleText). */
function renderedTokens(md: string): string[] {
  const BLOCK = /<\/?(?:p|div|li|ul|ol|tr|td|th|table|thead|tbody|h[1-6]|br|hr|pre|blockquote|details|summary|section|center)\b[^>]*>/gi;
  const ENT: Record<string, string> = { amp: "&", nbsp: " ", lt: "<", gt: ">", quot: '"' };
  const text = md
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^[ \t]*(?:`{3,}|~{3,})[^\n]*$/gm, " ")
    .replace(/^ {0,3}\[[^\]]+\]:[ \t]+\S.*$/gm, " ")
    .replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(BLOCK, "\n")
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g, "")
    .replace(/&(amp|nbsp|lt|gt|quot);/g, (_m, n: string) => ENT[n]!)
    .replace(/[*`~]+/g, "");
  return text
    .split(/\s+/)
    .map((w) => w.replace(/^[#>|_]+/, "").replace(/[|_]+$/, ""))
    .filter((w) => /[\p{L}\p{N}]/u.test(w) && !/^https?:/.test(w));
}

function lcg(seed: number) {
  let x = seed;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Acceptance of random 6-25 word spans of the rendered text, and rejection of spans with one invented word or joined from distant places. */
function measure(docs: { name: string; md: string }[], perDoc: number) {
  const rnd = lcg(20260716);
  const m = { spans: 0, accepted: 0, replaced: 0, replacedAccepted: 0, joined: 0, joinedAccepted: 0, missed: [] as string[] };
  for (const { name, md } of docs) {
    const words = renderedTokens(md);
    if (words.length < 80) continue;
    for (let k = 0; k < perDoc; k++) {
      const len = 6 + Math.floor(rnd() * 20);
      const st = Math.floor(rnd() * (words.length - len));
      const span = words.slice(st, st + len);
      m.spans++;
      if (ok(span.join(" "), md)) m.accepted++;
      else if (m.missed.length < 15) m.missed.push(`${name}: ${span.join(" ").slice(0, 100)}`);
      const bad = span.slice();
      bad[Math.floor(rnd() * len)] = "zzqxkw";
      m.replaced++;
      if (ok(bad.join(" "), md)) m.replacedAccepted++;
      const st2 = (st + Math.floor(words.length / 2)) % (words.length - len);
      if (Math.abs(st2 - st) > len) {
        const h = Math.floor(len / 2);
        const joined = [...span.slice(0, h), ...words.slice(st2, st2 + len - h)];
        m.joined++;
        if (ok(joined.join(" "), md)) m.joinedAccepted++;
      }
    }
  }
  return m;
}

describe("grounding property: random spans of the rendered document", () => {
  it("fixtures: >= 99% of the spans a reader could quote are accepted; invented or spliced spans never are", () => {
    const docs = readdirSync(fixtures).filter((f) => f.endsWith(".md") && !f.startsWith("injection")).map((f) => ({ name: f, md: fixture(f) }));
    const m = measure(docs, 60);
    expect(m.spans).toBeGreaterThan(300);
    expect(m.accepted / m.spans, m.missed.join("\n")).toBeGreaterThanOrEqual(0.99);
    expect(m.replacedAccepted).toBe(0);
    expect(m.joinedAccepted).toBe(0);
  });

  // Texts are git-ignored (never committed); the wide base lives next to the repo or wherever QF_README_CORPUS points.
  const corpus = process.env.QF_README_CORPUS ?? "/home/jhgcc1/qf-benign-wide";
  it.skipIf(!existsSync(corpus))("real READMEs (when present): >= 98% accepted; one invented word never accepted", () => {
    const docs = ["en", "pt", "es"].flatMap((lang) => {
      const dir = join(corpus, lang);
      return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => ({ name: `${lang}/${f}`, md: readFileSync(join(dir, f), "utf8") })) : [];
    });
    const m = measure(docs, 25);
    expect(m.accepted / m.spans, m.missed.join("\n")).toBeGreaterThanOrEqual(0.98);
    // The only legitimate acceptances of a replaced word: an explicit truncation (ellipsis) and words inside a link target.
    expect(m.replacedAccepted / m.replaced).toBeLessThan(0.001);
    expect(m.joinedAccepted / Math.max(m.joined, 1)).toBeLessThan(0.001);
  });
});
