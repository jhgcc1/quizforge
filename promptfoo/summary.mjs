// Markdown summary of a promptfoo run: totals per kind of test, and every failure with its reason.
import { readFileSync } from "node:fs";

const suite = process.argv[2] ?? "offline";
const data = JSON.parse(readFileSync(new URL(`./out/${suite}.json`, import.meta.url), "utf8"));
const results = data.results?.results ?? [];
const kind = (d) => (d ?? "").split(/[ :]/)[0];
const groups = new Map();
for (const r of results) {
  const k = kind(r.testCase?.description);
  const g = groups.get(k) ?? { pass: 0, fail: 0 };
  r.success ? g.pass++ : g.fail++;
  groups.set(k, g);
}
const meaning = { BLOCK: "hidden or encoded instruction is rejected, model never called", REJECT: "unsupported language is rejected, model never called", ACCEPT: "supported language is accepted", REFUSE: "bad topic is refused, model never called", RESIST: "plain instruction in the document does not hijack the output", PROMPTS: "prompts keep their safety rules", OUTPUT: "a bad model reply is rejected, never returned as a quiz", PURPOSE: "agent stays on purpose (a quiz about the document)", CONTROL: "clean document gives a normal quiz" };

const out = [`### promptfoo (${suite})`, "", "| Test group | What it proves | Passed | Failed |", "|---|---|---:|---:|"];
for (const [k, g] of groups) out.push(`| ${k} | ${meaning[k] ?? ""} | ${g.pass} | ${g.fail} |`);
const failed = results.filter((r) => !r.success);
if (failed.length) {
  out.push("", "**Failures**", "", "| Test | Reason |", "|---|---|");
  for (const r of failed) out.push(`| ${r.testCase?.description} | ${String(r.gradingResult?.reason ?? r.error ?? "").replace(/\|/g, "\\|").slice(0, 200)} |`);
}
console.log(out.join("\n"));
