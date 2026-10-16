/**
 * The report of the public-dataset part of the nightly run (pure functions): the `publicDatasets` section of summary.json, the HTML of
 * its section, the alert lines and the CloudWatch metrics (new names only). The nightly REPORTS, it never fails: every finding below is an
 * alert (metric + log line + entry in the report), none of them changes an exit code.
 */
import { escapeHtml, emf } from "../nightly-report.js";
import type { EvalRow } from "../report.js";
import type { SourceReport } from "./sources.js";
import type { PublicConfig } from "./cases.js";
import type { PublicOutput, PublicVars } from "./provider.js";
import { verdictOf } from "./stage.js";

export interface BuildInfo {
  config: PublicConfig;
  sources: SourceReport[];
  /** "dataset/language" -> rows in the pool the sample was drawn from. */
  pools: Record<string, number>;
  dropped: number;
  tooShort: number;
  cases: number;
}

export interface StratumA {
  dataset: string;
  language: string;
  n: number;
  /** Rejected before the model: the input guard (block finding) or the language policy. */
  blocked: number;
  /** Flagged by a keyword rule (and not blocked). */
  rulesFlagged: number;
  pg2Flagged: number;
  either: number;
  passedBoth: number;
  /** Rules that fired, with counts. */
  rules: Record<string, number>;
  blockedBy: Record<string, number>;
  /** Rows the sampling drew from. */
  pool: number;
}

export interface CaseRef {
  dataset: string;
  language: string;
  /** The row text, cut to 400 characters. */
  text: string;
  detail: string;
}

export interface PublicSummary {
  schema: 1;
  config: PublicConfig;
  sources: SourceReport[];
  dropped: number;
  tooShort: number;
  cases: number;
  /** Cases that did not run (the harness answered "error"). */
  errors: number;
  stageA: StratumA[];
  stageB: { cases: number; rejectedBeforeModel: number; rejectedByRails: number; quizzes: number; errors: number; contaminated: number; byLanguage: Record<string, { cases: number; quizzes: number; contaminated: number }>; contaminatedCases: (CaseRef & { layers: string; quiz: string })[] };
  blockedLanguages: { languages: string[]; cases: number; rejectedBeforeModel: number; reachedModel: number; errors: number; byLanguage: Record<string, { cases: number; rejectedBeforeModel: number; reachedModel: number }>; reached: (CaseRef & { llmCalls: number; status: string })[] };
  foreignInSupported: { cases: number; blockedByGuard: number; rejectedByLanguage: number; flaggedOnly: number; passed: number; byHost: Record<string, { cases: number; rejected: number; passed: number }> };
  benign: { cases: number; blocked: number; rulesFlagged: number; pg2Flagged: number; either: number; flagged: CaseRef[] };
  encoded: Record<string, { cases: number; blockedBeforeModel: number; reachedModel: number; contaminated: number }>;
  /** Stage A attacks that passed every layer (for rule improvement). */
  unflagged: CaseRef[];
  totals: { stageA: number; rulesFlagged: number; pg2Flagged: number; passedBoth: number; contaminated: number; blockedLangReachedModel: number; sourcesFailed: number; benignFlagged: number; encodedReachedModel: number };
}

const cut = (s: string, n = 400): string => (s.length > n ? s.slice(0, n) + "..." : s);
const bump = (m: Record<string, number>, k: string): void => void (m[k] = (m[k] ?? 0) + 1);

export interface Item {
  vars: PublicVars;
  out: PublicOutput;
}

/** The rows of a promptfoo results file that are public cases, parsed. A row without a readable output is an error case. */
export function itemsOf(rows: EvalRow[]): Item[] {
  const items: Item[] = [];
  for (const r of rows) {
    const vars = r.testCase?.vars as PublicVars | undefined;
    if (!vars || vars.kind !== "public") continue;
    let out: PublicOutput;
    try {
      out = JSON.parse(r.response?.output ?? "") as PublicOutput;
    } catch {
      out = { stage: vars.stage, id: vars.id, dataset: vars.dataset, language: vars.language, status: "error", layers: { rules: [] }, reason: "no readable output" };
    }
    items.push({ vars, out });
  }
  return items;
}

const layersText = (o: PublicOutput): string =>
  [o.layers.rejectedBy ? `${o.layers.rejectedBy}: ${o.layers.rejectedWhy ?? ""}` : "admitted", o.layers.rules.length ? `rules: ${o.layers.rules.join(", ")}` : "no rule flagged", o.layers.pg2 ? `PG2 ${o.layers.pg2.score}${o.layers.pg2.flagged ? " (flagged)" : ""}` : "PG2 off"].join("; ");

const ref = (i: Item, detail: string): CaseRef => ({ dataset: i.vars.dataset, language: i.vars.language, text: cut(i.vars.text), detail });
const reachedModel = (o: PublicOutput): boolean => (o.llmCalls ?? 0) > 0 || o.status === "quiz" || o.status === "no_quiz";

export function summarize(rows: EvalRow[], build: BuildInfo): PublicSummary {
  const items = itemsOf(rows);
  const of = (stage: string): Item[] => items.filter((i) => i.out.stage === stage);

  // stage A: per dataset x language
  const strata = new Map<string, StratumA>();
  for (const i of of("A")) {
    const k = `${i.vars.dataset}/${i.vars.language}`;
    const s = strata.get(k) ?? { dataset: i.vars.dataset, language: i.vars.language, n: 0, blocked: 0, rulesFlagged: 0, pg2Flagged: 0, either: 0, passedBoth: 0, rules: {}, blockedBy: {}, pool: build.pools[k] ?? 0 };
    strata.set(k, s);
    if (i.out.status === "error") continue;
    const v = verdictOf(i.out.layers);
    s.n++;
    if (v.blocked) { s.blocked++; bump(s.blockedBy, i.out.layers.rejectedWhy ?? "?"); }
    if (v.rulesFlagged) s.rulesFlagged++;
    if (v.pg2Flagged) s.pg2Flagged++;
    if (v.either) s.either++;
    if (v.passedBoth) s.passedBoth++;
    for (const r of i.out.layers.rules) bump(s.rules, r);
  }
  const stageA = [...strata.values()].sort((a, b) => a.dataset.localeCompare(b.dataset) || a.language.localeCompare(b.language));
  const unflagged = of("A").filter((i) => i.out.status !== "error" && verdictOf(i.out.layers).passedBoth).map((i) => ref(i, layersText(i.out)));

  // stage B
  const b = of("B");
  const byLanguage: PublicSummary["stageB"]["byLanguage"] = {};
  for (const i of b) {
    const l = (byLanguage[i.vars.language] ??= { cases: 0, quizzes: 0, contaminated: 0 });
    l.cases++;
    if (i.out.outcome === "quiz") l.quizzes++;
    if (i.out.contaminated) l.contaminated++;
  }
  const contaminatedCases = b.filter((i) => i.out.contaminated).map((i) => ({ ...ref(i, (i.out.reasons ?? []).join("; ")), layers: layersText(i.out), quiz: i.out.quiz ?? "" }));
  const outcomeCount = (o: string): number => b.filter((i) => i.out.outcome === o).length;

  // blocked languages
  const bl = of("blocked");
  const blByLang: PublicSummary["blockedLanguages"]["byLanguage"] = {};
  for (const i of bl) {
    const l = (blByLang[i.vars.language] ??= { cases: 0, rejectedBeforeModel: 0, reachedModel: 0 });
    l.cases++;
    if (reachedModel(i.out)) l.reachedModel++;
    else if (i.out.status !== "error") l.rejectedBeforeModel++;
  }
  const reached = bl.filter((i) => reachedModel(i.out)).map((i) => ({ ...ref(i, layersText(i.out)), llmCalls: i.out.llmCalls ?? 0, status: i.out.status }));

  // foreign sentence inside a supported README (informational)
  const fo = of("foreign").filter((i) => i.out.status !== "error");
  const byHost: PublicSummary["foreignInSupported"]["byHost"] = {};
  for (const i of fo) {
    const h = (byHost[i.vars.readmeLanguage ?? "?"] ??= { cases: 0, rejected: 0, passed: 0 });
    h.cases++;
    const v = verdictOf(i.out.layers);
    if (v.blocked) h.rejected++;
    if (v.passedBoth) h.passed++;
  }

  // benign control
  const be = of("benign").filter((i) => i.out.status !== "error");
  const beV = be.map((i) => ({ i, v: verdictOf(i.out.layers) }));

  // encoded public texts
  const encoded: PublicSummary["encoded"] = {};
  for (const i of of("E")) {
    const e = (encoded[i.vars.encoding ?? "?"] ??= { cases: 0, blockedBeforeModel: 0, reachedModel: 0, contaminated: 0 });
    e.cases++;
    if (reachedModel(i.out)) e.reachedModel++;
    else if (i.out.status !== "error") e.blockedBeforeModel++;
    if (i.out.contaminated) e.contaminated++;
  }

  const sourcesFailed = build.sources.filter((s) => s.status === "failed").length;
  const aSum = (f: (s: StratumA) => number): number => stageA.reduce((n, s) => n + f(s), 0);
  const encodedReached = Object.values(encoded).reduce((n, e) => n + e.reachedModel, 0);
  const contaminated = contaminatedCases.length + of("E").filter((i) => i.out.contaminated).length;
  return {
    schema: 1,
    config: build.config,
    sources: build.sources,
    dropped: build.dropped,
    tooShort: build.tooShort,
    cases: items.length,
    errors: items.filter((i) => i.out.status === "error").length,
    stageA,
    stageB: { cases: b.length, rejectedBeforeModel: outcomeCount("rejected_before_model"), rejectedByRails: outcomeCount("rejected_by_rails"), quizzes: outcomeCount("quiz"), errors: b.filter((i) => i.out.status === "error").length, contaminated: contaminatedCases.length, byLanguage, contaminatedCases },
    blockedLanguages: {
      languages: Object.keys(blByLang).sort(),
      cases: bl.length,
      rejectedBeforeModel: bl.filter((i) => !reachedModel(i.out) && i.out.status !== "error").length,
      reachedModel: reached.length,
      errors: bl.filter((i) => i.out.status === "error").length,
      byLanguage: Object.fromEntries(Object.entries(blByLang).sort(([x], [y]) => x.localeCompare(y))),
      reached,
    },
    foreignInSupported: {
      cases: fo.length,
      blockedByGuard: fo.filter((i) => i.out.layers.rejectedBy === "guard").length,
      rejectedByLanguage: fo.filter((i) => i.out.layers.rejectedBy === "language").length,
      flaggedOnly: fo.filter((i) => { const v = verdictOf(i.out.layers); return !v.blocked && (v.rulesFlagged || v.pg2Flagged); }).length,
      passed: fo.filter((i) => verdictOf(i.out.layers).passedBoth).length,
      byHost,
    },
    benign: { cases: be.length, blocked: beV.filter((x) => x.v.blocked).length, rulesFlagged: beV.filter((x) => x.v.rulesFlagged).length, pg2Flagged: beV.filter((x) => x.v.pg2Flagged).length, either: beV.filter((x) => x.v.either).length, flagged: beV.filter((x) => x.v.either).map((x) => ref(x.i, layersText(x.i.out))) },
    encoded,
    unflagged,
    totals: { stageA: aSum((s) => s.n), rulesFlagged: aSum((s) => s.rulesFlagged), pg2Flagged: aSum((s) => s.pg2Flagged), passedBoth: aSum((s) => s.passedBoth), contaminated, blockedLangReachedModel: reached.length, sourcesFailed, benignFlagged: beV.filter((x) => x.v.either).length, encodedReachedModel: encodedReached },
  };
}

/** A summary for a part that did not run at all (no results file): the run still reports it. */
export function skippedSummary(build: BuildInfo | undefined, reason: string): PublicSummary {
  const empty = summarize([], build ?? { config: { seed: 0, perGroupSupported: 0, perGroupBlocked: 0, modelCases: 0, benign: 0, foreign: 0, encodedPerStrategy: 0 }, sources: [], pools: {}, dropped: 0, tooShort: 0, cases: 0 });
  return { ...empty, sources: empty.sources.length ? empty.sources : [{ key: "all", id: reason, license: "", pinnedRevision: "", drifted: false, status: "failed", rows: 0, error: reason }], totals: { ...empty.totals, sourcesFailed: Math.max(1, empty.totals.sourcesFailed) } };
}

// ------------------------------------------------------------------------------------------------------------- alerts + metrics

/** One WARN line per finding that needs a look (never an exit code). */
export function alertLines(s: PublicSummary, unflaggedMax = 50): string[] {
  const lines: string[] = [];
  for (const c of s.stageB.contaminatedCases) lines.push(`WARN redteam-public contaminated-quiz dataset=${c.dataset} lang=${c.language} why="${c.detail}" layers="${c.layers}" text="${cut(c.text, 160)}"`);
  for (const r of s.blockedLanguages.reached) lines.push(`WARN redteam-public blocked-language-reached-model dataset=${r.dataset} lang=${r.language} status=${r.status} llmCalls=${r.llmCalls} text="${cut(r.text, 160)}"`);
  for (const src of s.sources.filter((x) => x.status !== "ok")) lines.push(`WARN redteam-public source-${src.status} source=${src.key} ${src.error ?? (src.failedQueries ?? []).join("; ")}`);
  for (const src of s.sources.filter((x) => x.drifted)) lines.push(`WARN redteam-public source-revision-drifted source=${src.key} pinned=${src.pinnedRevision.slice(0, 12)} observed=${(src.observedRevision ?? "").slice(0, 12)}`);
  for (const [enc, e] of Object.entries(s.encoded)) if (e.reachedModel > 0) lines.push(`WARN redteam-public encoded-reached-model encoding=${enc} count=${e.reachedModel} contaminated=${e.contaminated}`);
  s.unflagged.slice(0, unflaggedMax).forEach((u) => lines.push(`WARN redteam-public attack-not-flagged dataset=${u.dataset} lang=${u.language} text="${cut(u.text, 160)}"`));
  if (s.unflagged.length > unflaggedMax) lines.push(`WARN redteam-public attack-not-flagged ... and ${s.unflagged.length - unflaggedMax} more (see public-unflagged.json)`);
  if (s.errors > 0) lines.push(`WARN redteam-public ${s.errors} case(s) could not run (harness error)`);
  return lines;
}

/** New metric names only (the existing ones belong to the alarms). One line for the run, one per dataset. */
export function emfLines(s: PublicSummary, now = Date.now()): string[] {
  const c = (value: number): { value: number; unit: "Count" } => ({ value, unit: "Count" });
  const lines = [
    emf(now, { Service: "redteam" }, {
      RedteamPublicCases: c(s.cases),
      RedteamPublicStageACases: c(s.totals.stageA),
      RedteamPublicRulesFlagged: c(s.totals.rulesFlagged),
      RedteamPublicPg2Flagged: c(s.totals.pg2Flagged),
      RedteamPublicPassedBoth: c(s.totals.passedBoth),
      RedteamPublicModelCases: c(s.stageB.cases),
      RedteamPublicContaminated: c(s.totals.contaminated),
      RedteamBlockedLangCases: c(s.blockedLanguages.cases),
      RedteamBlockedLangReachedModel: c(s.totals.blockedLangReachedModel),
      RedteamPublicBenignCases: c(s.benign.cases),
      RedteamPublicBenignFlagged: c(s.totals.benignFlagged),
      RedteamPublicSourcesFailed: c(s.totals.sourcesFailed),
      RedteamPublicErrors: c(s.errors),
      RedteamEncodedPublicReachedModel: c(s.totals.encodedReachedModel),
    }),
  ];
  const byDataset = new Map<string, { n: number; rules: number; pg2: number; passed: number }>();
  for (const a of s.stageA) {
    const d = byDataset.get(a.dataset) ?? { n: 0, rules: 0, pg2: 0, passed: 0 };
    byDataset.set(a.dataset, { n: d.n + a.n, rules: d.rules + a.rulesFlagged, pg2: d.pg2 + a.pg2Flagged, passed: d.passed + a.passedBoth });
  }
  for (const [dataset, d] of byDataset) lines.push(emf(now, { Service: "redteam", Dataset: dataset }, { RedteamPublicDatasetCases: c(d.n), RedteamPublicDatasetRulesFlagged: c(d.rules), RedteamPublicDatasetPg2Flagged: c(d.pg2), RedteamPublicDatasetPassedBoth: c(d.passed) }));
  return lines;
}

/** The alerts that go into new-failures.json (the same shape as the existing entries: description, prompt, vars, outcome, reason). */
export function newFailureEntries(s: PublicSummary): { description: string; prompt: string; vars: Record<string, unknown>; outcome: string; reason: string }[] {
  return [
    ...s.stageB.contaminatedCases.map((c) => ({ description: `PUBLIC ${c.language} ${c.dataset} contaminated`, prompt: c.text, vars: { dataset: c.dataset, language: c.language, layers: c.layers }, outcome: "contaminated", reason: c.detail })),
    ...s.blockedLanguages.reached.map((r) => ({ description: `PUBLIC blocked language ${r.language} ${r.dataset} reached the model`, prompt: r.text, vars: { dataset: r.dataset, language: r.language, status: r.status, llmCalls: r.llmCalls }, outcome: "blocked_language_reached_model", reason: r.detail })),
  ];
}

// ------------------------------------------------------------------------------------------------------------------ HTML

const pct = (n: number, of: number): string => (of === 0 ? "0%" : `${Math.round((n / of) * 100)}%`);
const td = (v: string | number, cls = ""): string => `<td${cls ? ` class="${cls}"` : ""}>${escapeHtml(String(v))}</td>`;
const th = (v: string): string => `<th scope="row">${escapeHtml(v)}</th>`;
const head = (cols: string[]): string => `<thead><tr>${cols.map((c, i) => `<th scope="col"${i === 0 ? "" : ""}>${escapeHtml(c)}</th>`).join("")}</tr></thead>`;
const table = (cols: string[], rows: string[]): string => `<div class="scroll"><table>${head(cols)}<tbody>${rows.join("") || `<tr><td colspan="${cols.length}" class="muted">No cases.</td></tr>`}</tbody></table></div>`;

/** The HTML section added to report.html (the page's own styles apply). */
export function renderSection(s: PublicSummary): string {
  const t = s.totals;
  const alerts = t.contaminated + t.blockedLangReachedModel;
  const sources = table(["Source", "Licence", "Status", "Rows read", "Pinned revision", "Read revision"], s.sources.map((x) => `<tr>${th(x.id)}${td(x.license + (x.credit ? " (credit: " + x.credit + ")" : ""))}${td(x.status + (x.error ? ": " + x.error : "") + (x.failedQueries ? ` (${x.failedQueries.length} queries failed)` : ""), x.status === "ok" ? "" : "warn")}${td(x.rows)}${td(x.pinnedRevision.slice(0, 12))}${td((x.observedRevision ?? "unknown").slice(0, 12) + (x.drifted ? " (drifted)" : ""), x.drifted ? "warn" : "")}</tr>`));
  const a = table(["Dataset / language", "Pool", "Sampled", "Blocked", "Rules flag", "Prompt Guard 2 flags", "Either", "Passed both"], s.stageA.map((x) => `<tr>${th(`${x.dataset} / ${x.language}`)}${td(x.pool)}${td(x.n)}${td(x.blocked)}${td(`${x.rulesFlagged} (${pct(x.rulesFlagged, x.n)})`)}${td(`${x.pg2Flagged} (${pct(x.pg2Flagged, x.n)})`)}${td(`${x.either} (${pct(x.either, x.n)})`)}${td(`${x.passedBoth} (${pct(x.passedBoth, x.n)})`, x.passedBoth ? "warn" : "")}</tr>`));
  const bl = s.blockedLanguages;
  const blocked = table(["Language", "Cases", "Rejected before the model", "Reached the model"], Object.entries(bl.byLanguage).map(([l, c]) => `<tr>${th(l)}${td(c.cases)}${td(c.rejectedBeforeModel)}${td(c.reachedModel, c.reachedModel ? "bad" : "")}</tr>`));
  const cont = s.stageB.contaminatedCases.length
    ? s.stageB.contaminatedCases.map((c) => `<article class="leak"><dl><dt>Dataset</dt><dd>${escapeHtml(c.dataset)} / ${escapeHtml(c.language)}</dd><dt>Why</dt><dd>${escapeHtml(c.detail)}</dd><dt>Layers</dt><dd>${escapeHtml(c.layers)}</dd></dl><div class="muted">Attack text</div><pre>${escapeHtml(c.text)}</pre><div class="muted">Quiz (start)</div><pre>${escapeHtml(c.quiz)}</pre></article>`).join("")
    : `<p class="muted">No contaminated quiz.</p>`;
  const reached = bl.reached.length ? bl.reached.map((r) => `<article class="leak"><dl><dt>Language</dt><dd>${escapeHtml(r.language)} (${escapeHtml(r.dataset)})</dd><dt>Status</dt><dd>${escapeHtml(r.status)}, model calls ${r.llmCalls}</dd></dl><pre>${escapeHtml(r.text)}</pre></article>`).join("") : `<p class="muted">Every blocked-language document was rejected before the model.</p>`;
  const f = s.foreignInSupported;
  const enc = table(["Encoding", "Cases", "Blocked before the model", "Reached the model", "Contaminated"], Object.entries(s.encoded).map(([k, e]) => `<tr>${th(k)}${td(e.cases)}${td(e.blockedBeforeModel)}${td(e.reachedModel, e.reachedModel ? "warn" : "")}${td(e.contaminated, e.contaminated ? "bad" : "")}</tr>`));
  const credits = s.sources.filter((x) => x.credit).map((x) => escapeHtml(x.credit!)).join("; ");
  return `<section id="public-datasets"><h2>Public datasets (${s.cases} cases, ${alerts ? `${alerts} alert(s)` : "no alerts"})</h2>
<p class="muted">Seed ${s.config.seed}: ${s.config.perGroupSupported} attacks per dataset and supported language, ${s.config.perGroupBlocked} per blocked language, ${s.config.modelCases} cases with the real model. These findings are alerts for later investigation; the run does not fail on them.</p>
${sources}
<h3>Supported languages, before the model (stage A)</h3>${a}
<h3>Supported languages, real model (stage B): ${s.stageB.cases} cases, ${s.stageB.quizzes} quizzes, ${s.stageB.contaminated} contaminated</h3>${cont}
<h3>Blocked languages: ${bl.cases} documents, ${bl.reachedModel} reached the model</h3>${blocked}${reached}
<h3>Informational: a foreign sentence inside a supported-language README</h3><p class="muted">${f.cases} documents: ${f.blockedByGuard} blocked by the guard, ${f.rejectedByLanguage} refused by the language policy, ${f.flaggedOnly} flagged only, ${f.passed} passed every layer.</p>
<h3>Encoded dataset texts</h3>${enc}
<h3>Benign control (false positives, informational)</h3><p class="muted">${s.benign.cases} benign documents: ${s.benign.blocked} blocked, ${s.benign.rulesFlagged} flagged by a rule, ${s.benign.pg2Flagged} by Prompt Guard 2.</p>
<p class="muted">Texts: ${credits ? credits + "; " : ""}other sources under Apache-2.0 or MIT as listed above. Attacks that passed every layer: ${t.passedBoth} (public-unflagged.json).</p></section>`;
}

/** Puts the section before "How to promote" (or before the footer) of report.html. */
export function injectSection(html: string, section: string): string {
  for (const marker of ['<section><h2>How to promote', "<footer>"]) {
    const at = html.indexOf(marker);
    if (at >= 0) return html.slice(0, at) + section + "\n" + html.slice(at);
  }
  return html + section;
}
