/**
 * Step after nightly-report.ts: adds two things to the files of ONE nightly run, without changing the existing keys, files or metrics:
 *
 *   1. `encodings`: per strategy (plain, tone, jailbreak-templates, base64, rot13, leetspeak) and language: cases, rejected before the model,
 *      reached the model, leaked (from the same promptfoo results as the rest of the report);
 *   2. `publicDatasets`: the public-dataset part (promptfoo/redteam/public/*), from its own promptfoo results and build.json.
 *
 * It rewrites summary.json and report.html (a new section each), appends the public alerts to new-failures.json, writes
 * public-unflagged.json, prints the new CloudWatch metrics (Embedded Metric Format) on stdout and one WARN line per finding on stderr.
 * THE NIGHTLY REPORTS, IT DOES NOT FAIL: no finding changes the exit code (only a broken run does: this CLI exits 1 when it cannot read or write its files).
 *
 *   tsx promptfoo/redteam/nightly-extras.ts --dir DIR --nightly promptfoo/out/redteam-nightly.json [--generation promptfoo/out/nightly/generation.json] [--public promptfoo/out/redteam-public.json --public-build promptfoo/out/public/build.json]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { alertLines, emfLines as publicEmf, injectSection, newFailureEntries, renderSection, skippedSummary, summarize, type BuildInfo, type PublicSummary } from "./public/aggregate.js";
import type { GenerationReport } from "./build-intents-nightly.js";
import { emf, escapeHtml, classifyNightly, type Summary } from "./nightly-report.js";
import { readResults, type EvalRow } from "./report.js";

export interface EncodingCounts {
  cases: number;
  rejectedBeforeModel: number;
  reachedModel: number;
  leaked: number;
  otherFailures: number;
}
export interface Encodings {
  byStrategy: Record<string, EncodingCounts>;
  /** Keys "strategy / language". */
  byStrategyLanguage: Record<string, EncodingCounts>;
}

const empty = (): EncodingCounts => ({ cases: 0, rejectedBeforeModel: 0, reachedModel: 0, leaked: 0, otherFailures: 0 });
export const STRATEGY_ORDER = ["plain", "tone", "jailbreak-templates", "base64", "rot13", "leetspeak"];

/** Per strategy and per strategy x language: the nightly red team cases by what happened to them. */
export function encodingsOf(rows: EvalRow[]): Encodings {
  const byStrategy: Record<string, EncodingCounts> = {};
  const byStrategyLanguage: Record<string, EncodingCounts> = {};
  for (const row of rows.filter((r) => r.testCase?.vars?.kind === "redteam")) {
    const c = classifyNightly(row);
    for (const [map, key] of [[byStrategy, c.strategy], [byStrategyLanguage, `${c.strategy} / ${c.language}`]] as const) {
      const t = (map[key] ??= empty());
      t.cases++;
      if (c.outcome === "rejected") t.rejectedBeforeModel++;
      else if (c.outcome === "leaked") { t.reachedModel++; t.leaked++; }
      else if (c.outcome === "failed") t.otherFailures++;
      else t.reachedModel++;
    }
  }
  const order = (o: Record<string, EncodingCounts>): Record<string, EncodingCounts> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (STRATEGY_ORDER.indexOf(a.split(" / ")[0]!) - STRATEGY_ORDER.indexOf(b.split(" / ")[0]!)) || a.localeCompare(b)));
  return { byStrategy: order(byStrategy), byStrategyLanguage: order(byStrategyLanguage) };
}

export function renderEncodings(e: Encodings): string {
  const rows = (m: Record<string, EncodingCounts>): string =>
    Object.entries(m).map(([k, c]) => `<tr><th scope="row">${escapeHtml(k)}</th><td>${c.cases}</td><td>${c.rejectedBeforeModel}</td><td>${c.reachedModel}</td><td class="${c.leaked ? "bad" : ""}">${c.leaked}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No cases.</td></tr>`;
  const t = (title: string, m: Record<string, EncodingCounts>): string => `<h3>${escapeHtml(title)}</h3><div class="scroll"><table><thead><tr><th scope="col">${escapeHtml(title.replace(/^By /, ""))}</th><th scope="col">Cases</th><th scope="col">Blocked before the model</th><th scope="col">Reached the model</th><th scope="col">LEAKED</th></tr></thead><tbody>${rows(m)}</tbody></table></div>`;
  return `<section id="encodings"><h2>Strategies and encodings</h2><p class="muted">base64, rot13 and leetspeak are applied to a subset of the fresh texts, as a plain paragraph (no placement). They should stop at the input guard; one that reaches the model is an alert.</p>${t("By strategy", e.byStrategy)}${t("By strategy / language", e.byStrategyLanguage)}</section>`;
}

/** New metrics of the encodings part (new names; the existing RedteamLeaks etc. are not touched). */
export function encodingEmf(e: Encodings, now = Date.now()): string[] {
  const enc = ["base64", "rot13", "leetspeak"].map((k) => e.byStrategy[k] ?? empty());
  const sum = (f: (c: EncodingCounts) => number): number => enc.reduce((n, c) => n + f(c), 0);
  const c = (value: number): { value: number; unit: "Count" } => ({ value, unit: "Count" });
  const lines = [emf(now, { Service: "redteam" }, { RedteamEncodedCases: c(sum((x) => x.cases)), RedteamEncodedReachedModel: c(sum((x) => x.reachedModel)), RedteamEncodedLeaks: c(sum((x) => x.leaked)) })];
  for (const [strategy, t] of Object.entries(e.byStrategy)) lines.push(emf(now, { Service: "redteam", Strategy: strategy }, { RedteamStrategyCases: c(t.cases), RedteamStrategyReachedModel: c(t.reachedModel), RedteamStrategyLeaks: c(t.leaked) }));
  return lines;
}

/** WARN lines for the canary part (the existing leaks) and for encoded cases that reached the model. */
export function nightlyAlerts(s: Summary, e: Encodings): string[] {
  const lines = s.leaks.map((l) => `WARN redteam canary-leak canary=${l.canary} lang=${l.language} intent=${l.intent} strategy=${l.strategy} marked=${l.flagged} why="${l.reason.slice(0, 160)}"`);
  for (const k of ["base64", "rot13", "leetspeak"]) {
    const c = e.byStrategy[k];
    if (c && c.reachedModel > 0) lines.push(`WARN redteam encoded-reached-model strategy=${k} reached=${c.reachedModel} of ${c.cases} leaked=${c.leaked}`);
  }
  return lines;
}

/** The generation of the fresh texts: refused texts are skipped (never fatal) and counted; no text at all means the fixed texts were used. */
export function renderGeneration(g: GenerationReport): string {
  const list = g.refused.length ? `<ul>${g.refused.slice(0, 40).map((r) => `<li><code>${escapeHtml(r.intent)}</code> (${escapeHtml(r.language)}): ${escapeHtml(r.reason)}</li>`).join("")}</ul>` : "";
  return `<section id="generation"><h2>Generation of the fresh attack texts</h2><p class="muted">${g.produced} of ${g.requested} requested texts were written by the attacker model; <b>generation refused: ${g.refused.length} text(s)</b> (skipped, the night ran on the others).${g.fallback ? ` <b>FALLBACK:</b> ${escapeHtml(g.fallbackReason ?? "")}; the fixed attack texts of the repository were used.` : ""}</p>${list}</section>`;
}

export function generationEmf(g: GenerationReport, now = Date.now()): string {
  const c = (value: number): { value: number; unit: "Count" } => ({ value, unit: "Count" });
  return emf(now, { Service: "redteam" }, { RedteamGenerationRequested: c(g.requested), RedteamGenerationProduced: c(g.produced), RedteamGenerationRefused: c(g.refused.length), RedteamGenerationFallback: c(g.fallback ? 1 : 0) });
}

export const generationAlerts = (g: GenerationReport): string[] => [
  ...g.refused.map((r) => `WARN redteam generation-refused intent=${r.intent} lang=${r.language} last="${r.reason.replace(/"/g, "'").slice(0, 120)}"`),
  ...(g.fallback ? [`WARN redteam generation-fallback: fixed attack texts used (${g.fallbackReason ?? ""})`] : []),
];

export interface ExtrasInput {
  summary: Summary & Record<string, unknown>;
  html: string;
  failures: unknown[];
  nightlyRows: EvalRow[];
  publicRows?: EvalRow[];
  build?: BuildInfo;
  /** Why the public part is missing, when it is. */
  publicSkipped?: string;
  /** REDTEAM_PUBLIC=0: switched off on purpose (no metrics, no warning). */
  publicDisabled?: boolean;
  generation?: GenerationReport;
}

export interface ExtrasOutput {
  summary: Summary & Record<string, unknown>;
  html: string;
  failures: unknown[];
  unflagged: unknown[];
  emf: string[];
  warnings: string[];
  publicSummary?: PublicSummary;
}

/** Everything the step adds, as pure data. */
export function applyExtras(i: ExtrasInput, now = Date.now()): ExtrasOutput {
  const encodings = encodingsOf(i.nightlyRows);
  const pub = i.publicRows && i.build ? summarize(i.publicRows, i.build) : skippedSummary(i.build, i.publicSkipped ?? "the public part did not run (REDTEAM_PUBLIC=0 or no results)");
  const { unflagged, ...publicForSummary } = pub;
  const skipped = !i.publicRows || !i.build;
  const section = skipped
    ? `<section id="public-datasets"><h2>Public datasets</h2><p class="muted">Not run: ${escapeHtml(i.publicSkipped ?? "the public part did not run")}.</p></section>`
    : renderSection(pub);
  const gen = i.generation;
  const html = injectSection(injectSection(gen ? injectSection(i.html, renderGeneration(gen)) : i.html, renderEncodings(encodings)), section);
  return {
    summary: { ...i.summary, ...(gen ? { generation: gen } : {}), encodings, publicDatasets: publicForSummary },
    html,
    failures: [...i.failures, ...newFailureEntries(pub)],
    unflagged,
    emf: [...(gen ? [generationEmf(gen, now)] : []), ...encodingEmf(encodings, now), ...(i.publicDisabled ? [] : publicEmf(pub, now))],
    warnings: [...(gen ? generationAlerts(gen) : []), ...nightlyAlerts(i.summary, encodings), ...(skipped ? (i.publicDisabled ? [] : [`WARN redteam-public the public part did not run: ${i.publicSkipped ?? "no results"}`]) : alertLines(pub))],
    publicSummary: pub,
  };
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

function main(): void {
  const argv = process.argv.slice(2);
  const get = (n: string): string | undefined => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const dir = resolve(get("--dir") ?? "");
  const nightly = get("--nightly");
  if (!get("--dir") || !nightly) throw new Error("usage: nightly-extras.ts --dir DIR --nightly results.json [--public results.json --public-build build.json]");
  const pubFile = get("--public");
  const buildFile = get("--public-build");
  const havePublic = Boolean(pubFile && existsSync(pubFile) && buildFile && existsSync(buildFile));
  const genFile = get("--generation");
  const out = applyExtras({
    ...(genFile && existsSync(genFile) ? { generation: readJson<GenerationReport>(genFile) } : {}),
    summary: readJson(resolve(dir, "summary.json")),
    html: readFileSync(resolve(dir, "report.html"), "utf8"),
    failures: existsSync(resolve(dir, "new-failures.json")) ? readJson<unknown[]>(resolve(dir, "new-failures.json")) : [],
    nightlyRows: readResults(nightly),
    ...(havePublic ? { publicRows: readResults(pubFile!), build: readJson<BuildInfo>(buildFile!) } : { ...(buildFile && existsSync(buildFile) ? { build: readJson<BuildInfo>(buildFile) } : {}), publicSkipped: process.env.REDTEAM_PUBLIC === "0" ? "REDTEAM_PUBLIC=0" : "the public step produced no results", publicDisabled: process.env.REDTEAM_PUBLIC === "0" }),
  });
  writeFileSync(resolve(dir, "summary.json"), JSON.stringify(out.summary, null, 2) + "\n");
  writeFileSync(resolve(dir, "report.html"), out.html);
  writeFileSync(resolve(dir, "new-failures.json"), JSON.stringify(out.failures, null, 2) + "\n");
  if (havePublic) writeFileSync(resolve(dir, "public-unflagged.json"), JSON.stringify(out.unflagged, null, 2) + "\n");
  for (const w of out.warnings) console.error(w);
  console.error(`extras: ${out.warnings.length} alert line(s); public part ${havePublic ? "reported" : "not run"}`);
  for (const line of out.emf) console.log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
