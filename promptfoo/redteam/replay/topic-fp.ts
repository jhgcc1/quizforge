/**
 * False positives of the TOPIC check (`checkShortText`) on real topics: every Markdown heading of the real READMEs we have is a plausible
 * thing for a person to type as the quiz topic ("Installation", "Configuração", "¿Cómo contribuir?").
 *   pnpm exec tsx promptfoo/redteam/replay/topic-fp.ts [--wide=DIR (en/ pt/ es/)] [--en=.local/en-readmes]
 * Prints, per language folder, the headings tried and the ones refused (with the reason), exit code 1 when any is refused. Not part of coverage.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkShortText } from "@quizforge/core";
import { LOCAL_DIR, type RealReadmeEntry } from "./real-readmes.js";

const arg = (k: string, d: string): string => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const dirs: string[] = [];
const WIDE = arg("wide", "");
if (WIDE) for (const l of ["en", "pt", "es"]) dirs.push(join(WIDE, l));
dirs.push(arg("en", ".local/en-readmes"));
if (existsSync("docs/security/real-readmes-pt-es.json")) {
  const { entries } = JSON.parse(readFileSync("docs/security/real-readmes-pt-es.json", "utf8")) as { entries: RealReadmeEntry[] };
  for (const l of ["pt", "es"]) if (entries.some((e) => e.language === l)) dirs.push(join(LOCAL_DIR, l));
}

const headings = new Set<string>();
for (const d of dirs) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d).filter((x) => x.endsWith(".md"))) {
    for (const line of readFileSync(join(d, f), "utf8").split("\n")) {
      const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
      if (!m) continue;
      const h = m[1]!.replace(/[*_`]/g, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "").trim();
      if (h.length >= 2 && h.length <= 200) headings.add(h);
    }
  }
}
let refused = 0;
for (const h of headings) {
  const issue = checkShortText(h);
  if (issue) { refused++; console.log(`REFUSED (${issue.code}): ${h}`); }
}
console.log(`${headings.size} distinct headings, ${refused} refused`);
process.exitCode = refused ? 1 : 0;
