/**
 * False positives of the semantic detectors on every benign text we have, side by side with the keyword rules:
 *   - Llama Prompt Guard 2 86M (the detector in use, threshold 0.5) and the previous one, protectai/deberta-v3-base-prompt-injection-v2
 *     (English only), on real pt/es READMEs, real English READMEs, benign dataset rows, evals fixtures that are not injection, red-team templates.
 *   DEBERTA_DIR=<local copy of the DeBERTa model: config.json, tokenizer files, onnx/model.onnx> pnpm exec tsx promptfoo/redteam/research/checks/detector-fp.ts [--en=.local/en-readmes] [--dataset=.local/ds/deepset.json] [--out=docs/security/detector-fp.json]
 * Not part of coverage: a reporting script (needs the models, 1.1 GB and 0.7 GB, downloaded once into the transformers cache).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { benignDocument, inspectText } from "@quizforge/core";
import { createOnnxDetector } from "../../../../packages/detector/src/index.js"; // the provider loads it dynamically (optional dependency); here a direct import
import { readmeBlocks } from "../../readme.js";
import { benchmarkSample, type DatasetRow } from "../../lib/sample.js";
import { LOCAL_DIR, type RealReadmeEntry } from "../studies/real-readmes.js";

const arg = (k: string, d: string): string => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const EN_DIR = arg("en", ".local/en-readmes");
const DS = arg("dataset", ".local/ds/deepset.json");
const OUT = arg("out", "docs/security/detector-fp.json");
const read = (f: string): string => readFileSync(f, "utf8");

const benign: Record<string, string[]> = {};
const { entries } = JSON.parse(read("docs/security/real-readmes-pt-es.json")) as { entries: RealReadmeEntry[] };
benign["real pt/es READMEs"] = entries.map((e) => join(LOCAL_DIR, e.language, `${e.id}.md`)).filter(existsSync).map(read);
benign["real English READMEs"] = existsSync(EN_DIR) ? readdirSync(EN_DIR).filter((f) => f.endsWith(".md")).map((f) => read(join(EN_DIR, f))) : [];
if (existsSync(DS)) benign["benign dataset rows"] = benchmarkSample(JSON.parse(read(DS)) as DatasetRow[]).filter((r) => r.label === 0).map((r) => r.text);
benign["evals fixtures (not injection)"] = readdirSync("evals/fixtures").filter((f) => f.endsWith(".md") && !f.startsWith("injection")).map((f) => read(join("evals/fixtures", f)));
benign["red-team README templates"] = [benignDocument(), ...["en", "pt", "es"].map((l) => readmeBlocks(l).join("\n\n"))];

const pg2 = createOnnxDetector({ threshold: 0.5 });
const deberta = createOnnxDetector({ prepare: (md) => md /* the previous detector as it was run: without the preparation */, model: "protectai/deberta-v3-base-prompt-injection-v2", ...(process.env.DEBERTA_DIR ? { modelDir: process.env.DEBERTA_DIR } : {}), threshold: 0.5 });
const rules = (t: string): boolean => inspectText(t).findings.some((f) => f.severity !== "sanitize");
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

const out: Record<string, unknown> = {};
for (const [name, docs] of Object.entries(benign)) {
  let nRules = 0, nPg2 = 0, nDeb = 0, maxPg2 = 0, maxDeb = 0;
  const examples: { detector: string; score: number; text: string }[] = [];
  for (const d of docs) {
    if (rules(d)) nRules++;
    const a = await pg2.detect(d);
    const b = await deberta.detect(d);
    maxPg2 = Math.max(maxPg2, a.score); maxDeb = Math.max(maxDeb, b.score);
    if (a.flagged) { nPg2++; examples.push({ detector: "pg2", score: r3(a.score), text: (a.excerpt ?? d).replace(/\s+/g, " ").slice(0, 110) }); }
    if (b.flagged) { nDeb++; examples.push({ detector: "deberta", score: r3(b.score), text: (b.excerpt ?? d).replace(/\s+/g, " ").slice(0, 110) }); }
  }
  out[name] = { documents: docs.length, rules: nRules, promptGuard2: nPg2, deberta: nDeb, maxScorePg2: r3(maxPg2), maxScoreDeberta: r3(maxDeb), examples: examples.slice(0, 12) };
  console.log(name.padEnd(34), `docs ${docs.length}`.padEnd(10), `rules ${nRules}`.padEnd(9), `PG2 ${nPg2} (max ${r3(maxPg2)})`.padEnd(22), `DeBERTa ${nDeb} (max ${r3(maxDeb)})`);
}
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), threshold: 0.5, sets: out }, null, 1) + "\n");
console.log(`written: ${OUT}`);
