/**
 * The PUBLIC prompt-injection datasets of the nightly run (Hugging Face) and how they are read.
 *
 * Rows come from the datasets-server API at run time (`/rows` for the small datasets, `/filter` with a `where` clause for the large ones).
 * The server always serves the CURRENT version of a dataset (it takes no revision), so every source has a PINNED commit hash (the version
 * this code was written against) and the run asks the Hub for the commit it actually read (`/api/datasets/<id>`): the report shows both and
 * says "drifted" when they differ. Nothing here is committed from the datasets: rows live in memory and in the run folder only.
 *
 * A source that cannot be read (HTTP errors, timeouts after the retries) is reported as failed and the run goes on without it.
 * Not used on purpose: Weni/prompt-injections-1.0.0 (no licence), edithngalame/prompt-injection-en-es (licence "other").
 */
import { fnv1a } from "../readme.js";

export type Role = "attack" | "benign";
export interface SourceRow {
  source: string;
  text: string;
  /** The declared language (ISO 639-1) or undefined: the language is then detected from the text. */
  lang?: string;
  role: Role;
}

export interface SourceSpec {
  /** Short key used in the report and in the test names. */
  key: string;
  /** Hugging Face dataset id. */
  id: string;
  license: string;
  /** Credit line (CC-BY-4.0 requires it). */
  credit?: string;
  /** The commit this code was written against. */
  pinnedRevision: string;
  textColumn: string;
  /** "full": every row is read (small datasets). "windowed": per language, a window of rows at a random offset of a `/filter` query.
   *  "scan": `/rows` windows at seeded offsets over the whole dataset, filtered here (for a dataset whose `/filter` answers HTTP 500: `/rows` is fast). */
  mode: "full" | "windowed" | "scan";
  /** Column with the declared language (windowed sources query by it). */
  langColumn?: string;
  /** Languages asked for in windowed mode. */
  languages?: readonly string[];
  /** The column and value that mean attack / benign (absent: every row is an attack). */
  label?: { column: string; attack: string | number; benign?: string | number };
  /** The only declared language of a dataset without a language column. */
  declaredLang?: string;
  split: string;
  /** scan mode: how many windows of 100 rows. */
  windows?: number;
}

/** Languages the windowed sources are asked for: the three supported ones and the blocked ones franc can tell apart. */
export const WINDOW_LANGUAGES = ["en", "pt", "es", "fr", "de", "it", "nl", "pl", "ru", "tr", "hi", "th", "zh", "ja", "ar"] as const;

export const SOURCES: SourceSpec[] = [
  { key: "deepset", id: "deepset/prompt-injections", license: "Apache-2.0", pinnedRevision: "4f61ecb038e9c3fb77e21034b22511b523772cdd", textColumn: "text", mode: "full", label: { column: "label", attack: 1, benign: 0 }, split: "train" },
  { key: "yanismiraoui", id: "yanismiraoui/prompt_injections", license: "Apache-2.0", pinnedRevision: "bd55359f2f332afc35f277ac3dd08f7111b024c9", textColumn: "prompt_injections", mode: "full", split: "train" },
  { key: "prevenia", id: "PrevenIA/red-teaming-prevenia", license: "Apache-2.0", pinnedRevision: "384d345eaccf1cd6d63e4afb7d23bc6a517b79c0", textColumn: "prompt", mode: "full", declaredLang: "es", split: "train" },
  {
    key: "zn", id: "usezn/zn-prompt-injection-bench", license: "CC-BY-4.0", credit: "ZN prompt-injection benchmark (usezn/zn-prompt-injection-bench), CC-BY-4.0",
    pinnedRevision: "e084653e45f2518a39cc926296b9655a6f3b9114", textColumn: "text", mode: "windowed", langColumn: "lang", languages: ["", ...WINDOW_LANGUAGES], label: { column: "label", attack: "ataque" }, split: "train",
  },
  { key: "shieldlm", id: "dmilush/shieldlm-prompt-injection", license: "MIT", pinnedRevision: "dd660ae7670a793e886dbf3f7cdb5f597df180c8", textColumn: "text", mode: "scan", langColumn: "language", windows: 24, label: { column: "label_binary", attack: 1 }, split: "train" },
];

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export interface FetchDeps {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  /** Attempts per request (default 5), first wait in ms (doubles each time, default 2000). */
  attempts?: number;
  backoffMs?: number;
  /** Clock in ms (injectable for tests) and the time one windowed source may spend (default 5 minutes). */
  now?: () => number;
  sourceBudgetMs?: number;
}

export const realDeps: FetchDeps = {
  fetch: (url) => fetch(url, { signal: AbortSignal.timeout(90_000) }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const API = "https://datasets-server.huggingface.co";

/** GET JSON with retry and exponential backoff (the datasets-server times out on large datasets). Throws after the last attempt. */
export async function getJson(url: string, deps: FetchDeps): Promise<unknown> {
  const attempts = deps.attempts ?? 5;
  let last = "";
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await deps.fetch(url);
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (i < attempts - 1) await deps.sleep((deps.backoffMs ?? 2000) * 2 ** i);
  }
  throw new Error(`${last} after ${attempts} attempts: ${url.replace(/\?.*/, "")}`);
}

interface Page {
  rows?: { row: Record<string, unknown> }[];
  num_rows_total?: number;
}

const pageUrl = (spec: SourceSpec, offset: number, length: number, where?: string): string =>
  where
    ? `${API}/filter?dataset=${spec.id}&config=default&split=${spec.split}&where=${encodeURIComponent(where)}&offset=${offset}&length=${length}`
    : `${API}/rows?dataset=${spec.id}&config=default&split=${spec.split}&offset=${offset}&length=${length}`;

const q = (v: string | number): string => (typeof v === "number" ? String(v) : `'${v}'`);

/** The role of a raw row: attack, benign, or undefined (skipped). */
export function roleOf(spec: SourceSpec, row: Record<string, unknown>): Role | undefined {
  if (!spec.label) return "attack";
  const v = row[spec.label.column];
  if (v === spec.label.attack) return "attack";
  if (spec.label.benign !== undefined && v === spec.label.benign) return "benign";
  return undefined;
}

function toRows(spec: SourceSpec, page: Page, lang?: string): SourceRow[] {
  const out: SourceRow[] = [];
  for (const { row } of page.rows ?? []) {
    const text = String(row[spec.textColumn] ?? "").replace(/\s+/g, " ").trim();
    const role = roleOf(spec, row);
    if (!text || !role) continue;
    const col = spec.langColumn ? row[spec.langColumn] : undefined;
    const declared = lang ?? spec.declaredLang ?? (typeof col === "string" && col ? col.toLowerCase() : undefined);
    out.push({ source: spec.key, text, role, ...(declared ? { lang: declared } : {}) });
  }
  return out;
}

/** Every row of a small dataset (pages of 100). */
async function readFull(spec: SourceSpec, deps: FetchDeps): Promise<SourceRow[]> {
  const rows: SourceRow[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = (await getJson(pageUrl(spec, offset, 100), deps)) as Page;
    rows.push(...toRows(spec, page));
    const got = page.rows?.length ?? 0;
    if (got < 100 || offset + got >= (page.num_rows_total ?? Infinity)) return rows;
  }
}

/**
 * Per language, ONE query of 100 rows (`/filter`; the datasets-server is slow on the big datasets: 25 to 70 seconds and HTTP 500 are normal).
 * The first window starts at an offset taken from the seed; when the filtered set is larger than 200 rows, a second window at another seed offset
 * is read too. Supported languages go first, the blocked ones are rotated by the seed, and a source stops asking when its time budget is spent:
 * the languages not reached are listed as failed queries (the source is "partial") and come first on another night.
 */
async function readWindowed(spec: SourceSpec, seed: number, deps: FetchDeps): Promise<{ rows: SourceRow[]; failedQueries: string[]; population: Record<string, number> }> {
  const rows: SourceRow[] = [];
  const failedQueries: string[] = [];
  const population: Record<string, number> = {};
  const all = spec.languages ?? [];
  const first: string[] = all.filter((l) => l === "" || l === "en" || l === "pt" || l === "es"); // "": rows with no declared language (detected from the text)
  const rest = all.filter((l) => !first.includes(l));
  const turn = rest.length ? seed % rest.length : 0;
  const languages = [...first, ...rest.slice(turn), ...rest.slice(0, turn)];
  const now = deps.now ?? Date.now;
  const started = now();
  const budget = deps.sourceBudgetMs ?? 5 * 60_000;
  const quick = { ...deps, attempts: Math.min(deps.attempts ?? 5, 2) };
  let answered = 0;
  for (const lang of languages) {
    if (now() - started > budget) {
      failedQueries.push(`${lang}: not asked (time budget of ${Math.round(budget / 1000)} s spent)`);
      continue;
    }
    const where = `"${spec.langColumn}"=${q(lang)} AND "${spec.label!.column}"=${q(spec.label!.attack)}`;
    try {
      const startAt = fnv1a(`${seed}/${spec.key}/${lang}/a`) % 60;
      const head = (await getJson(pageUrl(spec, startAt, 100, where), quick)) as Page;
      const total = head.num_rows_total ?? 0;
      answered++;
      if (total === 0) continue;
      population[lang || "(none)"] = total;
      rows.push(...toRows(spec, head, lang || undefined));
      if (total > 200) rows.push(...toRows(spec, (await getJson(pageUrl(spec, 100 + (fnv1a(`${seed}/${spec.key}/${lang}/b`) % (total - 199)), 100, where), quick)) as Page, lang || undefined));
    } catch (err) {
      failedQueries.push(`${lang}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (languages.length > 0 && answered === 0) throw new Error(`every query failed (${failedQueries[0]})`);
  return { rows, failedQueries, population };
}

/** `/rows` windows of 100 at seeded offsets over the whole dataset (the first one tells the size); the language and label are filtered here. Stops at the time budget. */
async function readScan(spec: SourceSpec, seed: number, deps: FetchDeps): Promise<{ rows: SourceRow[]; failedQueries: string[]; population: Record<string, number> }> {
  const rows: SourceRow[] = [];
  const failedQueries: string[] = [];
  const now = deps.now ?? Date.now;
  const started = now();
  const budget = deps.sourceBudgetMs ?? 5 * 60_000;
  const quick = { ...deps, attempts: Math.min(deps.attempts ?? 5, 2) };
  let total = 0;
  let answered = 0;
  const windows = spec.windows ?? 10;
  for (let i = 0; i < windows; i++) {
    if (now() - started > budget) {
      failedQueries.push(`window ${i}..${windows - 1}: not asked (time budget of ${Math.round(budget / 1000)} s spent)`);
      break;
    }
    const offset = total > 100 ? fnv1a(`${seed}/${spec.key}/w${i}`) % (total - 99) : fnv1a(`${seed}/${spec.key}/w${i}`) % 1000;
    try {
      const page = (await getJson(pageUrl(spec, offset, 100), quick)) as Page;
      total = page.num_rows_total ?? total;
      answered++;
      rows.push(...toRows(spec, page));
    } catch (err) {
      failedQueries.push(`window ${i}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (answered === 0) throw new Error(`every window failed (${failedQueries[0]})`);
  return { rows, failedQueries, population: { "(all rows)": total } };
}

export interface SourceReport {
  key: string;
  id: string;
  license: string;
  credit?: string;
  pinnedRevision: string;
  observedRevision?: string;
  drifted: boolean;
  status: "ok" | "partial" | "failed";
  rows: number;
  error?: string;
  failedQueries?: string[];
  /** windowed sources: rows of the filtered set per language (the sampling population). */
  population?: Record<string, number>;
}

/** The commit the Hub serves now. Never throws: an unknown revision is reported as such. */
export async function observedRevision(spec: SourceSpec, deps: FetchDeps): Promise<string | undefined> {
  try {
    const j = (await getJson(`https://huggingface.co/api/datasets/${spec.id}`, { ...deps, attempts: 2 })) as { sha?: string };
    return j.sha;
  } catch {
    return undefined;
  }
}

/** Read one source; never throws (a failure becomes `status: "failed"`). */
export async function readSource(spec: SourceSpec, seed: number, deps: FetchDeps): Promise<{ rows: SourceRow[]; report: SourceReport }> {
  const observed = await observedRevision(spec, deps);
  const base = { key: spec.key, id: spec.id, license: spec.license, ...(spec.credit ? { credit: spec.credit } : {}), pinnedRevision: spec.pinnedRevision, ...(observed ? { observedRevision: observed } : {}), drifted: observed !== undefined && observed !== spec.pinnedRevision };
  try {
    if (spec.mode === "full") {
      const rows = await readFull(spec, deps);
      return { rows, report: { ...base, status: "ok", rows: rows.length } };
    }
    const w = spec.mode === "scan" ? await readScan(spec, seed, deps) : await readWindowed(spec, seed, deps);
    return { rows: w.rows, report: { ...base, status: w.failedQueries.length ? "partial" : "ok", rows: w.rows.length, population: w.population, ...(w.failedQueries.length ? { failedQueries: w.failedQueries } : {}) } };
  } catch (err) {
    return { rows: [], report: { ...base, status: "failed", rows: 0, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) } };
  }
}

/** All sources, one after the other (the server is slow and does not like parallel requests). */
export async function readAll(specs: SourceSpec[], seed: number, deps: FetchDeps): Promise<{ rows: SourceRow[]; reports: SourceReport[] }> {
  const rows: SourceRow[] = [];
  const reports: SourceReport[] = [];
  for (const spec of specs) {
    const r = await readSource(spec, seed, deps);
    rows.push(...r.rows);
    reports.push(r.report);
  }
  return { rows, reports };
}
