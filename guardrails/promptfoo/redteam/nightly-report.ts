/**
 * The report of ONE nightly red team run: summary.json, report.html (a standalone page), new-failures.json and the CloudWatch
 * metrics in Embedded Metric Format. Pure functions plus a small CLI; guardrails/run-nightly.sh runs the CLI and does the AWS part.
 *
 *   tsx guardrails/promptfoo/redteam/nightly-report.ts guardrails/promptfoo/out/redteam-nightly.json --out-dir DIR --run-id 2026-10-14T06-00-12Z \
 *       --started 2026-10-14T06:00:12Z --finished 2026-10-14T06:41:03Z --git-sha abc123 --model MiniMax-M2.7 --detector flag \
 *       --promptfoo-version 0.124.1 --num-tests 10 [--known known-failures.json]
 *
 * A LEAK is a failed hijack check (the canary is in the reply) or a prompt leak; all checks are plain code (assertions.js).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildLayerSummary, describeLayers, layersOf, type LayerSummary } from "./layers.js";
import { classify, newFailures, readResults, type Classified, type EvalRow, type Outcome } from "./report.js";

export interface Counts {
  cases: number;
  rejectedBeforeModel: number;
  rejectedByRails: number;
  validQuiz: number;
  leaked: number;
  otherFailures: number;
}

export interface RunInfo {
  runId: string;
  startedAt: string;
  finishedAt: string;
  gitSha: string;
  model: string;
  detector: string;
  promptfooVersion: string;
  numTests: number;
}

export interface LeakCase {
  canary: string;
  language: string;
  intent: string;
  strategy: string;
  group: string;
  reason: string;
  /** The part of the reply around the canary (or the start of the reply), cut to 300 characters. Plain text: the HTML escapes it. */
  excerpt: string;
  /** The start of the attack text, cut to 200 characters. */
  attack: string;
  /** Which layers had marked this document (rules, detector) and what the rails saw, in one line. */
  layers: string;
  /** True when a keyword rule or the detector had marked the document and it leaked anyway. */
  flagged: boolean;
}

export interface Summary extends Counts {
  schema: 1;
  run: RunInfo & { durationSeconds: number };
  modelCalls: number;
  byLanguage: Record<string, Counts>;
  byStrategy: Record<string, Counts>;
  byIntent: Record<string, Counts>;
  byGroup: Record<string, Counts>;
  leaks: LeakCase[];
  /** Per-layer attribution: who stopped each case, what each layer marked, which leaked cases had been marked. */
  layers: LayerSummary;
}

const OUTCOME_FIELD: Record<Outcome, keyof Omit<Counts, "cases">> = {
  rejected: "rejectedBeforeModel",
  rails: "rejectedByRails",
  resisted: "validQuiz",
  leaked: "leaked",
  failed: "otherFailures",
};

const empty = (): Counts => ({ cases: 0, rejectedBeforeModel: 0, rejectedByRails: 0, validQuiz: 0, leaked: 0, otherFailures: 0 });

const parseOutput = (row: EvalRow): { status?: string; llmCalls?: number; questions?: { prompt?: string; options?: string[]; explanation?: string; sourceQuote?: string }[] } => {
  try {
    return JSON.parse(row.response?.output ?? "{}") as ReturnType<typeof parseOutput>;
  } catch {
    return {};
  }
};

/** report.ts classification, plus one outcome it does not know: a bad `topic` refused before the model (status invalid_input). */
export function classifyNightly(row: EvalRow): Classified {
  const c = classify(row);
  return c.outcome === "resisted" && parseOutput(row).status === "invalid_input" ? { ...c, outcome: "rejected" } : c;
}

function tallyBy(items: Classified[], key: (c: Classified) => string): Record<string, Counts> {
  const out: Record<string, Counts> = {};
  for (const c of items) {
    const k = key(c);
    const t = (out[k] ??= empty());
    t.cases++;
    t[OUTCOME_FIELD[c.outcome]]++;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

const metaOf = (c: Classified): { group?: string; canary?: string } => (c.row.testCase?.metadata ?? {}) as { group?: string; canary?: string };

/** The text of the reply (questions, options, explanations, quotes), one string. */
function replyOf(row: EvalRow): string {
  const out = parseOutput(row);
  return (out.questions ?? []).map((q) => [q.prompt, ...(q.options ?? []), q.explanation, q.sourceQuote].filter(Boolean).join(" | ")).join("\n");
}

export function excerptOf(text: string, canary: string, max = 300): string {
  if (!text) return "";
  const at = canary ? text.toUpperCase().indexOf(canary.toUpperCase()) : -1;
  const start = at < 0 ? 0 : Math.max(0, at - Math.floor(max / 3));
  const cut = text.slice(start, start + max);
  return (start > 0 ? "..." : "") + cut + (start + max < text.length ? "..." : "");
}

export function leakOf(c: Classified): LeakCase {
  const m = metaOf(c);
  const canary = m.canary ?? "";
  return {
    canary,
    language: c.language,
    intent: c.intent,
    strategy: c.strategy,
    group: m.group ?? "base",
    reason: c.reason.slice(0, 300),
    excerpt: excerptOf(replyOf(c.row), canary),
    attack: String(c.row.testCase?.vars?.prompt ?? "").slice(0, 200),
    layers: describeLayers(layersOf(c)),
    flagged: layersOf(c).anyFlag,
  };
}

export function buildSummary(items: Classified[], info: RunInfo): Summary {
  const totals = empty();
  for (const c of items) {
    totals.cases++;
    totals[OUTCOME_FIELD[c.outcome]]++;
  }
  const seconds = Math.max(0, Math.round((Date.parse(info.finishedAt) - Date.parse(info.startedAt)) / 1000));
  return {
    schema: 1,
    run: { ...info, durationSeconds: Number.isFinite(seconds) ? seconds : 0 },
    ...totals,
    modelCalls: items.reduce((n, c) => n + (parseOutput(c.row).llmCalls ?? 0), 0),
    byLanguage: tallyBy(items, (c) => c.language),
    byStrategy: tallyBy(items, (c) => c.strategy),
    byIntent: tallyBy(items, (c) => c.intent),
    byGroup: tallyBy(items, (c) => metaOf(c).group ?? "base"),
    leaks: items.filter((c) => c.outcome === "leaked").map(leakOf),
    layers: buildLayerSummary(items),
  };
}

// ------------------------------------------------------------------------------------------ CloudWatch (Embedded Metric Format)

export type EmfValue = { value: number; unit: "Count" | "Seconds" };

export function emf(timestamp: number, dimensions: Record<string, string>, metrics: Record<string, EmfValue>): string {
  return JSON.stringify({
    _aws: { Timestamp: timestamp, CloudWatchMetrics: [{ Namespace: "QuizForge", Dimensions: [Object.keys(dimensions)], Metrics: Object.entries(metrics).map(([Name, m]) => ({ Name, Unit: m.unit })) }] },
    ...dimensions,
    ...Object.fromEntries(Object.entries(metrics).map(([k, m]) => [k, m.value])),
  });
}

/** One line for the run (Service=redteam) and one per language with its leaks (Service=redteam, Language=...). */
export function emfLines(s: Summary, now = Date.now()): string[] {
  const lines = [
    emf(now, { Service: "redteam" }, {
      RedteamRuns: { value: 1, unit: "Count" },
      RedteamCases: { value: s.cases, unit: "Count" },
      RedteamLeaks: { value: s.leaked, unit: "Count" },
      RedteamRejectedBeforeModel: { value: s.rejectedBeforeModel, unit: "Count" },
      RedteamDurationSeconds: { value: s.run.durationSeconds, unit: "Seconds" },
    }),
  ];
  // the per-layer counters: new names on their own line, so the names and the line above never change (alarms use them)
  const st = s.layers.stoppedBy;
  lines.push(
    emf(now, { Service: "redteam" }, {
      RedteamStoppedByRails: { value: st.railsRejected + st.railsRepaired, unit: "Count" },
      RedteamModelResistedAlone: { value: st.modelAlone, unit: "Count" },
      RedteamMarkedByAnyLayer: { value: s.layers.marked.either, unit: "Count" },
      RedteamLeakedMarked: { value: s.layers.leaked.flaggedButLeaked, unit: "Count" },
      RedteamLeakedNotMarked: { value: s.layers.leaked.notFlaggedAtAll, unit: "Count" },
    }),
  );
  for (const [language, c] of Object.entries(s.byLanguage)) lines.push(emf(now, { Service: "redteam", Language: language }, { RedteamLeaks: { value: c.leaked, unit: "Count" } }));
  return lines;
}

// ------------------------------------------------------------------------------------------------------------------ HTML

export const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const pct = (n: number, of: number): string => (of === 0 ? "0%" : `${Math.round((n / of) * 100)}%`);

function tableHtml(title: string, rows: Record<string, Counts>): string {
  const names = Object.keys(rows);
  const body = names.length
    ? names
        .map((k) => {
          const c = rows[k]!;
          return `<tr><th scope="row">${escapeHtml(k)}</th><td>${c.cases}</td><td>${c.rejectedBeforeModel}</td><td>${c.rejectedByRails}</td><td>${c.validQuiz}</td><td class="${c.leaked ? "bad" : ""}">${c.leaked}</td><td class="${c.otherFailures ? "warn" : ""}">${c.otherFailures}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="muted">No cases.</td></tr>`;
  return `<section><h2>${escapeHtml(title)}</h2><div class="scroll"><table><thead><tr><th scope="col">${escapeHtml(title.replace(/^By /, ""))}</th><th scope="col">Cases</th><th scope="col">Rejected before the model</th><th scope="col">Rejected by the output rails</th><th scope="col">Valid quiz</th><th scope="col">LEAKED</th><th scope="col">Other failures</th></tr></thead><tbody>${body}</tbody></table></div></section>`;
}

/** "Which layer acted": who stopped the cases, what each layer marked, and the leaked cases that were or were not marked. */
export function layersHtml(s: Summary): string {
  const L = s.layers;
  const st = L.stoppedBy;
  const n = s.cases;
  const row = (label: string, value: number, note = "", cls = ""): string => `<tr><th scope="row">${escapeHtml(label)}</th><td class="${cls}">${value}</td><td>${pct(value, n)}</td><td class="note-cell">${escapeHtml(note)}</td></tr>`;
  const checks = Object.entries(L.inputGuardChecks).map(([k, v]) => `${k} ${v}`).join(", ");
  const rails = Object.entries(L.railProblems).map(([k, v]) => `${k} ${v}`).join(", ");
  const rules = Object.entries(L.rules).sort(([, a], [, b]) => b.marked - a.marked);
  const ruleRows = rules.length
    ? rules.slice(0, 40).map(([k, v]) => `<tr><th scope="row">${escapeHtml(k)}</th><td>${v.marked}</td><td class="${v.leaked ? "bad" : ""}">${v.leaked}</td></tr>`).join("")
    : `<tr><td colspan="3" class="muted">No rule marked a case.</td></tr>`;
  const detail = L.detectorOn
    ? `The detector scanned ${L.detector.scanned} documents and flagged ${L.detector.flagged}. Of the ${L.leaked.total} leaked cases it had flagged ${L.detector.flaggedLeaked} and had not flagged ${L.detector.notFlaggedLeaked}.`
    : "The detector was off in this run.";
  const caseRows = L.cases
    .map((c) => `<tr><td>${escapeHtml(c.language)}</td><td>${escapeHtml(c.intent)}</td><td>${escapeHtml(c.strategy)}</td><td>${escapeHtml(c.stoppedBy)}</td><td>${escapeHtml(c.rules.join(", ") || "-")}</td><td>${escapeHtml(c.detector)}${c.score === null ? "" : ` ${c.score}`}</td><td>${escapeHtml(c.rejectedBefore ?? "-")}</td><td>${c.repairRounds ? `${c.repairRounds}x ${escapeHtml(c.railProblems.join(", "))}` : "-"}</td></tr>`)
    .join("");
  const railsStops = st.railsRejected + st.railsRepaired;
  return `<section><h2>Which layer acted</h2>
<p class="headline"><b>Stopped by:</b> input guard ${st.inputGuard}, rules + rail ${L.railsStopsMarked.marked}, rail alone ${L.railsStopsMarked.notMarked}${st.qualityGate ? `, quality gate ${st.qualityGate}` : ""}, model resisted on its own ${st.modelAlone}, <b class="${st.leaked ? "badtxt" : ""}">leaked ${st.leaked}</b> (${L.leaked.flaggedButLeaked} flagged but still leaked, ${L.leaked.notFlaggedAtAll} not flagged at all)${st.failed ? `, other failures ${st.failed}` : ""}. Rails stops: ${railsStops}.</p>
<div class="scroll"><table><thead><tr><th scope="col">Stopped by</th><th scope="col">Cases</th><th scope="col">Share</th><th scope="col">Detail</th></tr></thead><tbody>
${row("Input guard (rejected before the model)", st.inputGuard, checks || "none")}
${row("Output rails, reply rejected", st.railsRejected, rails ? `problems: ${rails}` : "")}
${row("Output rails, reply sent back and repaired", st.railsRepaired, `of the ${st.railsRejected + st.railsRepaired} rails stops, ${L.railsStopsMarked.marked} had been marked by a rule or the detector (rules + rail), ${L.railsStopsMarked.notMarked} had not (rail alone)`)}
${row("Quality gate (quote not in the document)", st.qualityGate, "grounding check, not a security rail")}
${row("Model resisted on its own", st.modelAlone, "valid quiz, no rail had to act")}
${row("LEAKED", st.leaked, `${L.leaked.flaggedButLeaked} flagged but still leaked, ${L.leaked.notFlaggedAtAll} not flagged at all`, st.leaked ? "bad" : "")}
${row("Other failures", st.failed, "errors, not a verdict", st.failed ? "warn" : "")}
</tbody></table></div>
<p class="muted">Marked by a layer: rules ${L.marked.rules}, detector ${L.marked.detector}, both ${L.marked.both}, either ${L.marked.either}, neither ${L.marked.neither} (of ${n}). ${escapeHtml(detail)}</p>
<h3>By keyword rule</h3>
<div class="scroll"><table><thead><tr><th scope="col">Rule</th><th scope="col">Cases it marked</th><th scope="col">Of those, leaked</th></tr></thead><tbody>${ruleRows}</tbody></table></div>
<details><summary>All ${n} cases with their layers</summary>
<div class="scroll"><table><thead><tr><th scope="col">Lang</th><th scope="col">Intent</th><th scope="col">Strategy</th><th scope="col">Stopped by</th><th scope="col">Rules</th><th scope="col">Detector</th><th scope="col">Rejected by</th><th scope="col">Rails</th></tr></thead><tbody>${caseRows}</tbody></table></div></details>
</section>`;
}

const CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--ink:#14181f;--muted:#5b6573;--line:#dfe3e8;--ok:#13795b;--bad:#b42318;--badbg:#fdecea;--warn:#9a6700;--accent:#2457d6}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f1218;--card:#181c24;--ink:#e8ebf0;--muted:#9aa4b2;--line:#2a303b;--ok:#4cc9a0;--bad:#ff8077;--badbg:#3a1a18;--warn:#e3b341;--accent:#8ab0ff}}
:root[data-theme="dark"]{--bg:#0f1218;--card:#181c24;--ink:#e8ebf0;--muted:#9aa4b2;--line:#2a303b;--ok:#4cc9a0;--bad:#ff8077;--badbg:#3a1a18;--warn:#e3b341;--accent:#8ab0ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:980px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.1rem;margin:28px 0 8px}
.meta{color:var(--muted);font-size:.9rem;overflow-wrap:anywhere}.meta b{color:var(--ink);font-weight:600}
.status{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:600;font-size:.85rem;margin-bottom:8px}
.status.ok{background:color-mix(in srgb,var(--ok) 18%,transparent);color:var(--ok)}.status.bad{background:var(--badbg);color:var(--bad)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:16px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.kpi .n{font-size:1.7rem;font-weight:700;line-height:1.2}.kpi .l{color:var(--muted);font-size:.85rem}.kpi.bad .n{color:var(--bad)}.kpi.ok .n{color:var(--ok)}
.scroll{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:560px;font-size:.9rem}
th,td{padding:8px 10px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}
th:first-child,td:first-child{text-align:left}thead th{color:var(--muted);font-weight:600;white-space:normal;vertical-align:bottom}
tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}tbody th{font-weight:600}
td.bad{color:var(--bad);font-weight:700}td.warn{color:var(--warn);font-weight:700}.muted{color:var(--muted)}
.leak{background:var(--card);border:1px solid var(--bad);border-radius:10px;padding:12px 14px;margin:10px 0}
.leak dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0 0 8px}.leak dt{color:var(--muted)}.leak dd{margin:0;overflow-wrap:anywhere}
.headline{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:0 0 10px}.badtxt{color:var(--bad)}h3{font-size:1rem;margin:18px 0 6px}.note-cell{text-align:left;white-space:normal;color:var(--muted);min-width:180px}details{margin-top:14px}summary{cursor:pointer;color:var(--accent)}
pre{margin:6px 0 0;padding:10px;background:var(--bg);border:1px solid var(--line);border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
.note{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.note ol{margin:6px 0 0;padding-left:22px}
footer{margin-top:28px;color:var(--muted);font-size:.8rem}
`;

export function renderHtml(s: Summary): string {
  const r = s.run;
  const leaked = s.leaked > 0;
  const kpi = (n: number | string, label: string, cls = ""): string => `<div class="kpi ${cls}"><div class="n">${escapeHtml(String(n))}</div><div class="l">${escapeHtml(label)}</div></div>`;
  const minutes = (r.durationSeconds / 60).toFixed(1);
  const leakList = s.leaks.length
    ? s.leaks
        .map(
          (l) =>
            `<article class="leak"><dl><dt>Canary</dt><dd><code>${escapeHtml(l.canary)}</code></dd><dt>Language</dt><dd>${escapeHtml(l.language)}</dd><dt>Intent</dt><dd>${escapeHtml(l.intent)} (${escapeHtml(l.group)})</dd><dt>Strategy</dt><dd>${escapeHtml(l.strategy)}</dd><dt>Why</dt><dd>${escapeHtml(l.reason)}</dd></dl><div class="muted">Layers</div><div>${l.flagged ? "Marked by the input guard and still leaked: " : "Not marked by any layer: "}${escapeHtml(l.layers)}</div><div class="muted">Reply excerpt</div><pre>${escapeHtml(l.excerpt || "(no reply text)")}</pre><div class="muted">Attack (start)</div><pre>${escapeHtml(l.attack)}</pre></article>`,
        )
        .join("")
    : `<p class="muted">No canary leaked. Every case was rejected before the model, rejected by the output rails, or answered with a valid quiz.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QuizForge red team ${escapeHtml(r.runId)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header>
<span class="status ${leaked ? "bad" : "ok"}">${leaked ? `${s.leaked} LEAKED` : "No leaks"}</span>
<h1>QuizForge nightly red team</h1>
<div class="meta"><b>${escapeHtml(r.runId)}</b> &middot; commit <code>${escapeHtml(r.gitSha.slice(0, 12))}</code> &middot; model <b>${escapeHtml(r.model)}</b> &middot; detector <b>${escapeHtml(r.detector)}</b><br>
started ${escapeHtml(r.startedAt)} &middot; finished ${escapeHtml(r.finishedAt)} &middot; ${escapeHtml(minutes)} min &middot; promptfoo ${escapeHtml(r.promptfooVersion)} &middot; ${escapeHtml(String(r.numTests))} texts per intent</div>
</header>
<div class="kpis">
${kpi(s.cases, "cases")}
${kpi(s.rejectedBeforeModel, `rejected before the model (${pct(s.rejectedBeforeModel, s.cases)})`)}
${kpi(s.rejectedByRails, `rejected by output rails (${pct(s.rejectedByRails, s.cases)})`)}
${kpi(s.validQuiz, `valid quiz (${pct(s.validQuiz, s.cases)})`)}
${kpi(s.leaked, "LEAKED", s.leaked ? "bad" : "ok")}
${kpi(s.otherFailures, "other failures")}
${kpi(s.modelCalls, "model calls")}
</div>
<section><h2>Leaked cases (${s.leaks.length})</h2>${leakList}</section>
${layersHtml(s)}
${tableHtml("By language", s.byLanguage)}
${tableHtml("By strategy", s.byStrategy)}
${tableHtml("By threat group", s.byGroup)}
${tableHtml("By intent", s.byIntent)}
<section><h2>How to promote a failing case</h2><div class="note">A case that failed should never come back unnoticed.<ol>
<li>Open <code>new-failures.json</code> in the same folder (every failing case that is not already known, with its attack text).</li>
<li>Fix the cause: the guard (<code>packages/core/src/injection-rules.ts</code>), the prompts or the output rails (<code>packages/llm/src/output-guard.ts</code>).</li>
<li>Add the attack to the frozen sample (<code>guardrails/promptfoo/redteam/sample.yaml</code>, see <code>docs/redteam-nightly.md</code>) so the pull request job <code>redteam-sample</code> catches it from now on.</li>
</ol></div></section>
<footer>Rejected before the model = guard, language policy, detector or a refused topic. Valid quiz = it passed the output rails and the grounding check. All checks are plain code; no model grades another model.</footer>
</main>
</body>
</html>
`;
}

// ------------------------------------------------------------------------------------------------------------------ files + CLI

export interface Written {
  summary: Summary;
  files: string[];
}

export function writeReport(rows: EvalRow[], info: RunInfo, outDir: string, known: { description: string; prompt: string }[] = []): Written {
  mkdirSync(outDir, { recursive: true });
  // the language policy group and other non-attack rows are not part of the red team report
  const items = rows.filter((r) => r.testCase?.vars?.kind === "redteam").map(classifyNightly);
  const summary = buildSummary(items, info);
  const files = [
    ["summary.json", JSON.stringify(summary, null, 2) + "\n"],
    ["report.html", renderHtml(summary)],
    ["new-failures.json", JSON.stringify(newFailures(items, known), null, 2) + "\n"],
  ] as const;
  for (const [name, content] of files) writeFileSync(resolve(outDir, name), content);
  return { summary, files: files.map(([n]) => n) };
}

export function parseCli(argv: string[]): { results: string; outDir: string; known?: string; info: RunInfo } {
  const results = argv[0];
  if (!results || results.startsWith("--")) throw new Error("usage: nightly-report.ts <results.json> --out-dir DIR --run-id ID --started ISO --finished ISO [--git-sha S --model M --detector D --promptfoo-version V --num-tests N --known known.json]");
  const get = (n: string, d?: string): string => {
    const i = argv.indexOf(n);
    const v = i >= 0 ? argv[i + 1] : d;
    if (v === undefined) throw new Error(`missing ${n}`);
    return v;
  };
  const known = argv.includes("--known") ? get("--known") : undefined;
  return {
    results,
    outDir: get("--out-dir"),
    ...(known ? { known } : {}),
    info: {
      runId: get("--run-id"),
      startedAt: get("--started"),
      finishedAt: get("--finished"),
      gitSha: get("--git-sha", "unknown"),
      model: get("--model", "unknown"),
      detector: get("--detector", "off"),
      promptfooVersion: get("--promptfoo-version", "unknown"),
      numTests: Number(get("--num-tests", "0")),
    },
  };
}

function main(): void {
  const a = parseCli(process.argv.slice(2));
  const known = a.known ? (JSON.parse(readFileSync(a.known, "utf8")) as { description: string; prompt: string }[]) : [];
  const { summary } = writeReport(readResults(a.results), a.info, a.outDir, known);
  console.error(`red team ${a.info.runId}: ${summary.cases} cases, ${summary.rejectedBeforeModel} rejected before the model, ${summary.rejectedByRails} by the rails, ${summary.validQuiz} valid, ${summary.leaked} LEAKED, ${summary.otherFailures} other failures; by layer: input guard ${summary.layers.stoppedBy.inputGuard}, rails ${summary.layers.stoppedBy.railsRejected + summary.layers.stoppedBy.railsRepaired}, model alone ${summary.layers.stoppedBy.modelAlone}, leaked ${summary.layers.stoppedBy.leaked} (${summary.layers.leaked.flaggedButLeaked} flagged, ${summary.layers.leaked.notFlaggedAtAll} not flagged)`);
  for (const line of emfLines(summary)) console.log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
