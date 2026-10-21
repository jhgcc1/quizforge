/**
 * Real Portuguese and Spanish READMEs (false-positive check of the guard).
 *
 *   pnpm exec tsx promptfoo/redteam/research/studies/fetch-real-readmes.ts                 download the READMEs of docs/security/real-readmes-pt-es.json into .local/real-readmes-pt-es/ and check every sha256
 *   pnpm exec tsx promptfoo/redteam/research/studies/fetch-real-readmes.ts --build FILE    BUILD the manifest from a candidates file (one "pt|es translation|native owner/repo path" per line):
 *                                                                                resolves the HEAD commit, downloads the file at that commit, keeps it only if `acceptReadme` says yes.
 *
 * The texts are never committed (the licences differ): only the manifest is. Needs the network (GitHub raw + `gh api` for --build). Not part of coverage.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LOCAL_DIR, acceptReadme, localName, rawUrl, sha256Hex, verifyEntry, type PtEs, type RealReadmeEntry } from "./real-readmes.js";

const MANIFEST = "docs/security/real-readmes-pt-es.json";


async function get(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

async function build(candidatesFile: string): Promise<void> {
  const lines = readFileSync(candidatesFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const entries: RealReadmeEntry[] = [];
  const rejected: string[] = [];
  for (const line of lines) {
    const [language, kind, repo, ...rest] = line.split(/\s+/);
    const path = rest.join(" ");
    try {
      const commit = execFileSync("gh", ["api", `repos/${repo}/commits/HEAD`, "--jq", ".sha"], { encoding: "utf8" }).trim();
      const url = rawUrl(repo!, commit, path);
      const text = await get(url);
      const a = acceptReadme(text, language as PtEs);
      if (!a.ok) { rejected.push(`${repo} ${path}: ${a.reason}`); continue; }
      const id = `${repo!.replace("/", "__")}${path === "README.md" ? "" : "__" + path.replace(/[^A-Za-z0-9.-]+/g, "_")}`;
      entries.push({ id, language: language as PtEs, kind: kind as "translation" | "native", repo: repo!, path, commit, url, bytes: a.bytes, sha256: sha256Hex(text), proseWords: a.proseWords });
    } catch (err) {
      rejected.push(`${repo} ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  writeFileSync(MANIFEST, JSON.stringify({
    about: "Pointers to real, popular open-source READMEs in Portuguese (pt) and Spanish (es), used to check the guard for false positives. The texts are NOT in the repository (their licences differ): fetch them with promptfoo/redteam/research/studies/fetch-real-readmes.ts. Each entry has the commit and the sha256 of the text.",
    builtAt: new Date().toISOString(),
    entries,
  }, null, 1) + "\n");
  console.log(`${entries.length} accepted (${entries.filter((e) => e.language === "pt").length} pt, ${entries.filter((e) => e.language === "es").length} es); rejected:\n${rejected.join("\n")}`);
}

async function fetchAll(): Promise<void> {
  const { entries } = JSON.parse(readFileSync(MANIFEST, "utf8")) as { entries: RealReadmeEntry[] };
  let bad = 0;
  for (const e of entries) {
    const file = join(LOCAL_DIR, localName(e));
    mkdirSync(dirname(file), { recursive: true });
    const text = await get(e.url);
    const problem = verifyEntry(e, text);
    if (problem) { bad++; console.error(problem); continue; }
    writeFileSync(file, text);
  }
  console.log(`${entries.length - bad}/${entries.length} READMEs in ${LOCAL_DIR}`);
  if (bad) process.exit(1);
}

const i = process.argv.indexOf("--build");
await (i >= 0 ? build(process.argv[i + 1]!) : fetchAll());
