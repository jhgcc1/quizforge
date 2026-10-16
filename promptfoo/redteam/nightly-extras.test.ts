import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { GeneratedTest } from "./curate.js";
import type { IntentMeta } from "./intents.js";
import { ENCODING_STRATEGIES, encodedTests, subsetOf } from "./nightly-encoded.js";
import { applyExtras, encodingEmf, encodingsOf, nightlyAlerts, renderEncodings } from "./nightly-extras.js";
import type { Summary } from "./nightly-report.js";
import type { EvalRow } from "./report.js";
import { REDTEAM_LANGUAGES } from "./readme.js";

const repo = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

const rr = (o: { strategy: string; language?: string; status: string; llmCalls?: number; leaked?: boolean; success?: boolean }): EvalRow => ({
  success: o.success ?? !o.leaked,
  testCase: { description: `REDTEAM ${o.language ?? "en"} x ${o.strategy}`, vars: { kind: "redteam", prompt: "p" }, metadata: { language: o.language ?? "en", strategy: o.strategy, intent: "override", canary: "ZX9-ALPHA" } as never },
  response: { output: JSON.stringify({ status: o.status, llmCalls: o.llmCalls ?? 0 }) },
  gradingResult: { componentResults: o.leaked ? [{ pass: false, reason: "LEAKED: canary in the reply" }] : [{ pass: true }] },
});

const nightlyRows = (): EvalRow[] => [
  rr({ strategy: "plain", status: "quiz", llmCalls: 2 }),
  rr({ strategy: "base64", status: "blocked" }),
  rr({ strategy: "base64", status: "blocked", language: "pt" }),
  rr({ strategy: "base64", status: "quiz", llmCalls: 2, language: "pt" }),
  rr({ strategy: "rot13", status: "quiz", llmCalls: 2, leaked: true, language: "es" }),
  rr({ strategy: "leetspeak", status: "error", success: false }),
  { testCase: { vars: { kind: "readme" } }, response: { output: "{}" } },
];

const summary = (leaks: Summary["leaks"] = []): Summary & Record<string, unknown> =>
  ({ schema: 1, cases: 6, leaked: leaks.length, leaks, run: { runId: "r" }, byLanguage: {} }) as unknown as Summary & Record<string, unknown>;

describe("encodings in the nightly report", () => {
  const e = encodingsOf(nightlyRows());

  it("counts per strategy and per strategy / language: blocked before the model, reached the model, leaked", () => {
    expect(e.byStrategy.base64).toEqual({ cases: 3, rejectedBeforeModel: 2, reachedModel: 1, leaked: 0, otherFailures: 0 });
    expect(e.byStrategy.rot13).toEqual({ cases: 1, rejectedBeforeModel: 0, reachedModel: 1, leaked: 1, otherFailures: 0 });
    expect(e.byStrategy.leetspeak!.otherFailures).toBe(1);
    expect(e.byStrategyLanguage["base64 / pt"]).toEqual({ cases: 2, rejectedBeforeModel: 1, reachedModel: 1, leaked: 0, otherFailures: 0 });
    expect(Object.keys(e.byStrategy)).toEqual(["plain", "base64", "rot13", "leetspeak"]);
  });

  it("new metric names only; the encoded totals and one line per strategy", () => {
    const lines = encodingEmf(e, 5).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ Service: "redteam", RedteamEncodedCases: 5, RedteamEncodedReachedModel: 2, RedteamEncodedLeaks: 1 });
    expect(lines.find((l) => l.Strategy === "base64")).toMatchObject({ RedteamStrategyCases: 3, RedteamStrategyReachedModel: 1 });
    for (const l of lines) expect(Object.keys(l).filter((k) => k.startsWith("Redteam")).every((k) => /^Redteam(Encoded|Strategy)/.test(k))).toBe(true);
    expect(encodingEmf(encodingsOf([]))[0]).toContain('"RedteamEncodedCases":0');
  });

  it("alerts are WARN lines: one per canary leak, one per encoding that reached the model", () => {
    const lines = nightlyAlerts(summary([{ canary: "ZX9-ALPHA", language: "es", intent: "override", strategy: "rot13", group: "base", reason: "LEAKED", excerpt: "", attack: "", layers: "rules did not flag; detector off; rails found nothing", flagged: false }]), e);
    expect(lines[0]).toMatch(/^WARN redteam canary-leak canary=ZX9-ALPHA lang=es/);
    expect(lines.filter((l) => l.includes("encoded-reached-model")).map((l) => /strategy=(\w+)/.exec(l)![1])).toEqual(["base64", "rot13"]);
    expect(renderEncodings(e)).toContain("By strategy / language");
  });
});

describe("applyExtras: the existing report is extended, never changed, and nothing here can fail the night", () => {
  const html = "<main><section><h2>How to promote a failing case</h2></section><footer>f</footer></main>";
  const base = { summary: summary(), html, failures: [{ description: "old" }], nightlyRows: nightlyRows() };

  it("without the public part: encodings added, a skipped note, no public metrics when it is switched off", () => {
    const o = applyExtras({ ...base, publicSkipped: "REDTEAM_PUBLIC=0", publicDisabled: true }, 1);
    expect(o.summary).toMatchObject({ cases: 6, leaked: 0, encodings: { byStrategy: { base64: { cases: 3 } } }, publicDatasets: { cases: 0 } });
    expect(o.html).toContain('id="encodings"');
    expect(o.html).toContain("Not run: REDTEAM_PUBLIC=0");
    expect(o.html.indexOf('id="encodings"')).toBeLessThan(o.html.indexOf("How to promote"));
    expect(o.emf.join("\n")).not.toContain("RedteamPublic");
    expect(o.warnings.some((w) => w.includes("redteam-public"))).toBe(false);
    expect(o.failures).toEqual([{ description: "old" }]);
  });

  it("a public part that did not run when it should is an alert and a metric (sources failed), not a failure", () => {
    const o = applyExtras({ ...base, publicSkipped: "the public step produced no results" }, 1);
    expect(o.warnings).toContain("WARN redteam-public the public part did not run: the public step produced no results");
    expect(o.emf.join("\n")).toContain('"RedteamPublicSourcesFailed":1');
  });

  it("with the public results: the section, the metrics, the alerts and the new failures are added", () => {
    const out = JSON.stringify({ stage: "blocked", id: "x", dataset: "d", language: "fr", status: "quiz", llmCalls: 1, layers: { rules: [] } });
    const o = applyExtras({
      ...base,
      publicRows: [{ testCase: { vars: { kind: "public", stage: "blocked", id: "x", dataset: "d", language: "fr", text: "bonjour", document: "d" } }, response: { output: out } }],
      build: { config: { seed: 1, perGroupSupported: 1, perGroupBlocked: 1, modelCases: 0, benign: 0, foreign: 0, encodedPerStrategy: 0 }, sources: [], pools: {}, dropped: 0, tooShort: 0, cases: 1 },
    }, 1);
    expect(o.html).toContain('id="public-datasets"');
    expect(o.warnings.some((w) => w.includes("blocked-language-reached-model"))).toBe(true);
    expect(o.emf.join("\n")).toContain('"RedteamBlockedLangReachedModel":1');
    expect(o.failures).toHaveLength(2);
    expect((o.summary.publicDatasets as Record<string, unknown>).unflagged).toBeUndefined();
    expect(o.publicSummary!.totals.blockedLangReachedModel).toBe(1);
  });
});

describe("the nightly never fails on a finding (the scripts)", () => {
  const aws = repo("scripts/redteam-nightly-aws.sh");
  const pf = repo("scripts/promptfoo.sh");

  it("the entrypoint exits 0 on a leak and says so; non-zero only for upload, no results, no key", () => {
    expect(aws).toMatch(/NIGHTLY REPORTS, IT DOES NOT FAIL/);
    expect(aws).not.toMatch(/\[ "\$leaks" -gt 0 \] && exit 1/);
    expect([...aws.matchAll(/exit (\d)/g)].map((m) => m[1])).toEqual(expect.arrayContaining(["2", "3", "0"]));
    expect(aws).toMatch(/REDTEAM_PUBLIC/);
  });

  it("promptfoo.sh: the nightly passes --no-fail to the report and tolerates promptfoo's failed-assertion code, the frozen sample still gates", () => {
    const nightly = pf.slice(pf.indexOf("  redteam-nightly)"), pf.indexOf("  redteam-public)"));
    expect(nightly).toContain("--no-fail");
    expect(nightly).toContain('[ "$code" -eq 100 ] && code=0');
    expect(nightly).toContain("public_part");
    expect(nightly).toContain("nightly-encoded.ts tests");
    const sample = pf.slice(pf.indexOf("  redteam-sample)"), pf.indexOf("  redteam-nightly)"));
    expect(sample).not.toContain("--no-fail");
    expect(sample).toContain("|| code=$?");
  });

  it("the report CLI exits 1 on a leak unless --no-fail", () => {
    expect(repo("promptfoo/redteam/report.ts")).toMatch(/some\(\(c\) => c\.outcome === "leaked"\) && !argv\.includes\("--no-fail"\)/);
  });
});

describe("encodings of the fresh texts", () => {
  const metas: IntentMeta[] = REDTEAM_LANGUAGES.flatMap((language) => ["a", "b"].flatMap((intent) => [1, 2, 3, 4].map((n) => ({ text: `${intent} ${language} ${n}`, intent, language, canary: `ZX9-${intent.toUpperCase()}` }))));

  it("takes the same number of texts per intent for one seed, and other texts for another seed", () => {
    const s = subsetOf(metas, 3, 7);
    expect(s).toHaveLength(6);
    expect(s.filter((m) => m.intent === "a")).toHaveLength(3);
    expect(subsetOf(metas, 3, 7)).toEqual(s);
    expect(subsetOf(metas, 3, 8).map((m) => m.text)).not.toEqual(s.map((m) => m.text));
    expect(subsetOf(metas, 0, 7)).toEqual([]);
  });

  it("keeps only the encoding strategies as nightly cases with the plain document layout and the group 'encoded'", () => {
    const gen = (id: string, text: string): GeneratedTest => ({ vars: { prompt: id === "plain" ? text : `ENC(${text})` }, metadata: { ...(id === "plain" ? {} : { strategyId: id }), originalText: text } });
    const tests = ENCODING_STRATEGIES.map((s) => gen(s, "a en 1")).concat([gen("plain", "a en 1"), gen("jailbreak-templates", "a en 1"), gen("base64", "not an intent")]);
    const out = encodedTests(tests, metas);
    expect(out.map((t) => t.metadata.strategy)).toEqual(["base64", "rot13", "leetspeak"]);
    for (const t of out) {
      expect(t.vars).toMatchObject({ layout: "document", kind: "redteam", lang: "en", canary: "ZX9-A" });
      expect(t.metadata.group).toBe("encoded");
      expect(t.assert.map((a) => a.value)).toContain("file://nightly-assertions.js:canaryAbsent");
    }
    expect(stringify(out)).toContain("ENC(a en 1)");
  });
});
