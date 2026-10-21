/**
 * False-positive check of the WHOLE input guard (`inspectText`, not only the keyword rules) on every benign text we have:
 *   pnpm exec tsx promptfoo/redteam/research/checks/guard-fp.ts [--wide=DIR (en/ pt/ es/ subfolders of real READMEs)] [--public=.local/public.json] [--out=FILE]
 * Sets: real pt/es READMEs, real English READMEs, benign dataset rows, evals fixtures, red-team README templates, the benign rows of
 * the public datasets (`--public`, made from redteam-public.json), and the wide base of real READMEs (`--wide`). Prints, per set, the
 * documents BLOCKED and the documents FLAGGED (an `injection_phrase` or `mixed_script_word` finding). A block on a benign text is the
 * serious one: the user cannot generate a quiz. The bar for every change to the guard: neither count goes up on any set.
 * Not part of coverage: a reporting script (the downloaded data is git-ignored, see `.local/`).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { benignDocument, inspectText } from "@quizforge/core";
import { readmeBlocks } from "../../readme.js";
import { benchmarkSample, type DatasetRow } from "../../lib/sample.js";
import { LOCAL_DIR, type RealReadmeEntry } from "../studies/real-readmes.js";

const arg = (k: string, d: string): string => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const read = (f: string): string => readFileSync(f, "utf8");
const EN_DIR = arg("en", ".local/en-readmes");
const DS = arg("dataset", ".local/ds/deepset.json");
const WIDE = arg("wide", "");
const PUBLIC = arg("public", ".local/public.json");
const OUT = arg("out", "");

const sets: Record<string, { name: string; text: string }[]> = {};
const named = (names: string[], texts: string[]) => texts.map((text, i) => ({ name: names[i] ?? String(i), text }));
const { entries } = JSON.parse(read("docs/security/real-readmes-pt-es.json")) as { entries: RealReadmeEntry[] };
const ptes = entries.map((e) => ({ id: e.id, f: join(LOCAL_DIR, e.language, `${e.id}.md`) })).filter((x) => existsSync(x.f));
sets["real pt/es READMEs"] = named(ptes.map((x) => x.id), ptes.map((x) => read(x.f)));
if (existsSync(EN_DIR)) { const fs = readdirSync(EN_DIR).filter((f) => f.endsWith(".md")); sets["real English READMEs"] = named(fs, fs.map((f) => read(join(EN_DIR, f)))); }
if (existsSync(DS)) sets["benign dataset rows"] = benchmarkSample(JSON.parse(read(DS)) as DatasetRow[]).filter((r) => r.label === 0).map((r, i) => ({ name: `row${i}`, text: r.text }));
const fx = readdirSync("evals/fixtures").filter((f) => f.endsWith(".md") && !f.startsWith("injection"));
sets["evals fixtures"] = named(fx, fx.map((f) => read(join("evals/fixtures", f))));
sets["red-team README templates"] = named(["benign", "en", "pt", "es"], [benignDocument(), ...["en", "pt", "es"].map((l) => readmeBlocks(l).join("\n\n"))]);
if (existsSync(PUBLIC)) {
  const rows = (JSON.parse(read(PUBLIC)) as { text: string; stage: string }[]).filter((r) => r.stage === "benign");
  sets["public datasets, benign rows"] = rows.map((r, i) => ({ name: `row${i}`, text: r.text }));
}
if (WIDE) {
  for (const l of ["en", "pt", "es"]) {
    const dir = join(WIDE, l);
    if (existsSync(dir)) { const fs = readdirSync(dir); (sets["wide base of real READMEs"] ??= []).push(...fs.map((f) => ({ name: `${l}/${f}`, text: read(join(dir, f)) }))); }
  }
}

const report: Record<string, { documents: number; blocked: string[]; flagged: string[] }> = {};
for (const [set, docs] of Object.entries(sets)) {
  const blocked: string[] = [], flagged: string[] = [];
  for (const d of docs) {
    const r = inspectText(d.text);
    if (r.blocked) blocked.push(`${d.name}: ${r.findings.filter((f) => f.severity === "block").map((f) => f.detail).join("; ")}`);
    const f = r.findings.find((x) => x.kind === "injection_phrase" || x.kind === "mixed_script_word");
    if (f) flagged.push(`${d.name}: ${f.rule ?? f.kind}`);
  }
  report[set] = { documents: docs.length, blocked, flagged };
  console.log(`${set}: ${docs.length} documents, ${blocked.length} blocked, ${flagged.length} flagged`);
  for (const b of blocked) console.log(`  BLOCKED ${b.slice(0, 200)}`);
}
if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 1) + "\n");
