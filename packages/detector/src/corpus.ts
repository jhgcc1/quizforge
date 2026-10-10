// pnpm --filter @quizforge/detector corpus   : scores the attack corpus and the real fixtures with the classifier (model cached after the first run)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ATTACK_TECHNIQUES, DEFAULT_PAYLOAD, SUPPORTED_LANGUAGE_DOCS } from "@quizforge/core";
import { createOnnxDetector } from "./index.js";

const d = createOnnxDetector();
const rows: [string, string, number, number][] = [];
for (const t of ATTACK_TECHNIQUES) {
  const r = await d.detect(t.embed(DEFAULT_PAYLOAD));
  rows.push(["attack", `${t.id} (${t.expect})`, r.score, r.ms]);
}
const dir = join(process.cwd(), "../../evals/fixtures");
for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
  const r = await d.detect(readFileSync(join(dir, f), "utf8"));
  rows.push(["fixture", f, r.score, r.ms]);
}
for (const s of SUPPORTED_LANGUAGE_DOCS) rows.push(["lang-doc", s.id, (await d.detect(s.text)).score, 0]);
for (const [kind, name, score, ms] of rows) console.log(`${kind.padEnd(8)} ${name.padEnd(46)} ${score.toFixed(3)}  ${ms}ms`);
