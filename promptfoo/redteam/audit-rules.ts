/**
 * Rule usage audit: for every keyword rule of the input guard, how many lines of each source it matches.
 *   pnpm exec tsx promptfoo/redteam/audit-rules.ts [--readmes=DIR] [--dataset=.local/ds/deepset.json] [--out=docs/security/guard-audit.json]
 * Sources: the 500-sample of deepset/prompt-injections (injections and benign apart), the frozen red-team sample and the nightly intents,
 * the replay attacks, every evals/fixtures/*.md, real READMEs downloaded into --readmes (not committed), the corpus packages/core/src/attacks.ts.
 * A line counts for a rule like in guard.ts (lowercase text or the normalised text), and decoded candidates (base64, hex...) are searched too.
 * Not part of coverage: a reporting script over the committed data.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ATTACK_TECHNIQUES, BAD_TOPICS, DEFAULT_PAYLOAD, decodeCandidates, INJECTION_RULES, normalizeForMatching, matchingRules } from "@quizforge/core";
import { benchmarkSample, type DatasetRow } from "./replay/sample.js";

const arg = (k: string, d: string): string => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const READMES = arg("readmes", "");
const DS = arg("dataset", ".local/ds/deepset.json");
const OUT = arg("out", "docs/security/guard-audit.json");

/** The rules that match one text, searched like the guard does (per line, lower and normalised) and in decoded candidates. */
export function rulesHitting(doc: string): Set<string> {
  const hit = new Set<string>();
  const texts = [doc, ...decodeCandidates(doc).map(([, d]) => d)];
  for (const t of texts) {
    for (const l of t.split("\n")) for (const r of [...matchingRules(l.toLowerCase()), ...matchingRules(normalizeForMatching(l))]) hit.add(r.id);
  }
  return hit;
}

const groups: Record<string, string[]> = {};
const add = (group: string, docs: string[]): void => { (groups[group] ??= []).push(...docs); };

const rows = JSON.parse(readFileSync(DS, "utf8")) as DatasetRow[];
const sample = benchmarkSample(rows);
add("dataset injections (500 sample)", sample.filter((s) => s.label === 1).map((s) => s.text));
add("dataset benign (500 sample)", sample.filter((s) => s.label === 0).map((s) => s.text));
// the 59 of the replay are the ones the ORIGINAL rules missed; read them from the frozen replay result (the rules may have changed since)
const replay = JSON.parse(readFileSync("docs/security/replay-deepset.json", "utf8")) as { attacks: { text: string; decision: { keep: boolean } }[] };
add("replay attacks kept (59)", replay.attacks.filter((a) => a.decision.keep).map((a) => a.text));
const sampleYaml = parse(readFileSync("promptfoo/redteam/sample.yaml", "utf8")) as { vars: { prompt: string } }[];
add("red-team sample (50)", sampleYaml.map((t) => t.vars.prompt));
add("nightly intents (72)", JSON.parse(readFileSync("promptfoo/redteam/intents.json", "utf8")) as string[]);
const fx = "evals/fixtures";
add("fixtures (benign)", readdirSync(fx).filter((f) => f.endsWith(".md") && !f.startsWith("injection")).map((f) => readFileSync(join(fx, f), "utf8")));
add("fixture injection.md", readdirSync(fx).filter((f) => f.startsWith("injection") && f.endsWith(".md")).map((f) => readFileSync(join(fx, f), "utf8"))); // injection.md, injection-pt.md, injection-es.md
if (READMES && existsSync(READMES)) add("real READMEs", readdirSync(READMES).filter((f) => f.endsWith(".md")).map((f) => readFileSync(join(READMES, f), "utf8")));
add("attacks.ts techniques", ATTACK_TECHNIQUES.map((t) => t.embed(DEFAULT_PAYLOAD)));
add("attacks.ts bad topics", BAD_TOPICS.map((t) => t.topic));

const count: Record<string, Record<string, number>> = {};
const fired: Record<string, Record<string, string[]>> = {};
for (const r of INJECTION_RULES) { count[r.id] = {}; fired[r.id] = {}; }
for (const [g, docs] of Object.entries(groups)) {
  for (const d of docs) for (const id of rulesHitting(d)) {
    count[id]![g] = (count[id]![g] ?? 0) + 1;
    const shown = (fired[id]![g] ??= []);
    if (shown.length < 3) shown.push(d.replace(/\s+/g, " ").slice(0, 110));
  }
}
// overlap: documents of the attack groups where a rule is the ONLY one that fires, and rules that always fire together
const ATTACK_GROUPS = ["dataset injections (500 sample)", "red-team sample (50)", "nightly intents (72)", "attacks.ts techniques", "attacks.ts bad topics", "fixture injection.md"];
const sole: Record<string, number> = {};
const docsOf: Record<string, Set<string>> = {};
for (const g of ATTACK_GROUPS) groups[g]!.forEach((d, i) => {
  const hit = rulesHitting(d);
  if (hit.size === 1) { const id = [...hit][0]!; sole[id] = (sole[id] ?? 0) + 1; }
  for (const id of hit) (docsOf[id] ??= new Set()).add(`${g}#${i}`);
});
const together: string[] = [];
const ids = Object.keys(docsOf);
for (const a of ids) for (const b of ids) if (a < b && docsOf[a]!.size >= 2 && [...docsOf[a]!].every((x) => docsOf[b]!.has(x)) && [...docsOf[b]!].every((x) => docsOf[a]!.has(x))) together.push(`${a} = ${b} (${docsOf[a]!.size} docs)`);
const out = INJECTION_RULES.map((r) => ({ id: r.id, category: r.category, soleHits: sole[r.id] ?? 0, total: Object.values(count[r.id]!).reduce((a, b) => a + b, 0), counts: count[r.id], samples: fired[r.id] }));
writeFileSync(OUT, JSON.stringify({ groups: Object.fromEntries(Object.entries(groups).map(([g, d]) => [g, d.length])), rules: out }, null, 1) + "\n");
console.log("groups:", Object.fromEntries(Object.entries(groups).map(([g, d]) => [g, d.length])));
console.log("never the only rule on an attack:", out.filter((r) => r.total > 0 && r.soleHits === 0).map((r) => r.id).join(" "));
console.log("fire on exactly the same documents:", together.join("; "));
console.log("never fire:", out.filter((r) => r.total === 0).map((r) => r.id).join(" "));
const BENIGN = ["dataset benign (500 sample)", "fixtures (benign)", "real READMEs"];
console.log("fire on benign:", out.filter((r) => BENIGN.some((b) => r.counts![b])).map((r) => `${r.id}:${BENIGN.map((b) => r.counts![b] ?? 0).join("/")}`).join(" "));
