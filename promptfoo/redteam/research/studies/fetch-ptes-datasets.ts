/**
 * Downloads the public Portuguese / Spanish prompt-injection datasets into .local/ds/ptes/ (git-ignored; the raw texts are never committed).
 *   pnpm exec tsx promptfoo/redteam/research/studies/fetch-ptes-datasets.ts
 * Sources (Hugging Face datasets-server): yanismiraoui/prompt_injections (Apache-2.0), PrevenIA/red-teaming-prevenia (Apache-2.0),
 * usezn/zn-prompt-injection-bench (CC-BY-4.0, only lang pt and es, label "ataque"), Weni/prompt-injections-1.0.0 (no declared licence: local evaluation only).
 * Writes one JSON file per dataset: [{ text, lang? , split? }]. Needs the network. Not part of coverage.
 */
import { mkdirSync, writeFileSync } from "node:fs";

export const OUT_DIR = ".local/ds/ptes";
const API = "https://datasets-server.huggingface.co/rows";
const FILTER = "https://datasets-server.huggingface.co/filter";

interface Source { id: string; file: string; textColumn: string; splits: string[]; where?: string[] }
const SOURCES: Source[] = [
  { id: "yanismiraoui/prompt_injections", file: "yanismiraoui.json", textColumn: "prompt_injections", splits: ["train"] },
  { id: "PrevenIA/red-teaming-prevenia", file: "prevenia.json", textColumn: "prompt", splits: ["train"] },
  { id: "usezn/zn-prompt-injection-bench", file: "zn.json", textColumn: "text", splits: ["train", "validation", "test"], where: [`"lang"='pt'`, `"lang"='es'`] },
  { id: "Weni/prompt-injections-1.0.0", file: "weni.json", textColumn: "text", splits: ["train"] },
];

async function rows(id: string, split: string, where?: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 100) {
    let body: { rows?: { row: Record<string, unknown> }[]; num_rows_total?: number } = {};
    for (let attempt = 0; attempt < 10; attempt++) {
      const url = where ? `${FILTER}?dataset=${id}&config=default&split=${split}&where=${encodeURIComponent(where)}&offset=${offset}&length=100` : `${API}?dataset=${id}&config=default&split=${split}&offset=${offset}&length=100`;
      const res = await fetch(url);
      const json = res.ok ? ((await res.json()) as typeof body) : undefined;
      if (json?.rows) { body = json; break; }
      if (attempt === 9) throw new Error(`${id} ${split}: no rows after 10 tries (HTTP ${res.status})`);
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
    const page = body.rows ?? [];
    out.push(...page.map((r) => r.row));
    if (page.length < 100 || out.length >= (body.num_rows_total ?? Infinity)) return out;
  }
}

mkdirSync(OUT_DIR, { recursive: true });
for (const s of SOURCES) {
  const all: { text: string; lang?: string; label?: string; split: string }[] = [];
  for (const split of s.splits) {
    for (const r of (await Promise.all((s.where ?? [undefined]).map((w) => rows(s.id, split, w)))).flat()) all.push({ text: String(r[s.textColumn] ?? ""), split, ...(typeof r.lang === "string" ? { lang: r.lang } : {}), ...(typeof r.label === "string" ? { label: r.label } : {}) });
  }
  writeFileSync(`${OUT_DIR}/${s.file}`, JSON.stringify(all));
  console.log(`${s.id}: ${all.length} rows`);
}
