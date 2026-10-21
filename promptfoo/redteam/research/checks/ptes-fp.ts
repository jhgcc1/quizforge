/**
 * False-positive check of the guard on the real pt/es READMEs (downloaded by fetch-real-readmes.ts into .local/real-readmes-pt-es/).
 *   pnpm exec tsx promptfoo/redteam/research/checks/ptes-fp.ts [--out=docs/security/guard-pt-es-readmes.json]
 * Counts the `injection_phrase` findings (flag or block) per rule and lists every hit line, so a person can read each one.
 * Not part of coverage: a reporting script.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeCandidates, matchingRules, normalizeForMatching } from "@quizforge/core";

import { LOCAL_DIR, type RealReadmeEntry } from "../studies/real-readmes.js";

const OUT = process.argv.find((a) => a.startsWith("--out="))?.split("=")[1] ?? "docs/security/guard-pt-es-readmes.json";

export interface Hit { id: string; rule: string; line: string }

/** Every (rule, line) the guard would flag in a document: per line on the lowercase and normalised text, plus decoded candidates. */
export function hitsOf(doc: string): { rule: string; line: string }[] {
  const out: { rule: string; line: string }[] = [];
  for (const t of [doc, ...decodeCandidates(doc).map(([, d]) => d)]) {
    for (const l of t.split("\n")) {
      const ids = new Set([...matchingRules(l.toLowerCase()), ...matchingRules(normalizeForMatching(l))].map((r) => r.id));
      for (const rule of ids) out.push({ rule, line: l.trim().slice(0, 240) });
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("ptes-fp.ts")) {
  const { entries } = JSON.parse(readFileSync("docs/security/real-readmes-pt-es.json", "utf8")) as { entries: RealReadmeEntry[] };
  const hits: (Hit)[] = [];
  const perRule: Record<string, number> = {};
  let docs = 0;
  for (const e of entries) {
    const f = join(LOCAL_DIR, e.language, `${e.id}.md`);
    if (!existsSync(f)) continue;
    docs++;
    for (const h of hitsOf(readFileSync(f, "utf8"))) { hits.push({ id: e.id, ...h }); perRule[h.rule] = (perRule[h.rule] ?? 0) + 1; }
  }
  writeFileSync(OUT, JSON.stringify({ documents: docs, perRule, hits }, null, 1) + "\n");
  console.log(`${docs} documents, ${hits.length} hits`, perRule);
  for (const h of hits) console.log(`${h.id} [${h.rule}] ${h.line}`);
  void readdirSync;
}
