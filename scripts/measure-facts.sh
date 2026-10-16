#!/usr/bin/env bash
# Measures the numbers of the architecture reports that only a run can give (test counts, coverage) and writes site/measured.json.
# The reports read that file (site/facts.py); nothing is typed by hand. Run it before regenerating the reports when code changed:
#
#   docker run -d --rm --name qf-pg -e POSTGRES_USER=quizforge -e POSTGRES_PASSWORD=quizforge -e POSTGRES_DB=postgres -p 55432:5432 postgres:16-alpine
#   TEST_ADMIN_DATABASE_URL=postgres://quizforge:quizforge@localhost:55432/postgres WEB_DIR=/path/to/quizforge-web scripts/measure-facts.sh
#
# WEB_DIR (optional): a checkout of the front end (its main), with its dependencies installed; its unit tests are counted too.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${TEST_ADMIN_DATABASE_URL:?set TEST_ADMIN_DATABASE_URL (a Postgres that tests may create databases in)}"
out=site/measured.json
tmp="$(mktemp -d)"

# unit + integration tests with coverage: the same command as the CI job `integration`
pnpm exec vitest run --config vitest.coverage.config.ts --coverage --reporter=json --outputFile="$tmp/vitest.json" >"$tmp/vitest.log" 2>&1 || { tail -40 "$tmp/vitest.log"; echo "tests failed: nothing written" >&2; exit 1; }

# promptfoo suites: the number of cases each one generates
pf="$(pnpm exec tsx -e 'import { offline, live } from "./promptfoo/tests.ts"; console.log(JSON.stringify({ offline: offline().length, live: live().length }))')"

# the strategy router (chooseStrategy) applied to every test document: what `auto` decides for real files
router="$(pnpm exec tsx -e 'import { readdirSync, readFileSync } from "node:fs"; import { chooseStrategy } from "./packages/llm/src/router.ts"; const dir = "evals/fixtures"; const rows = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => { const d = chooseStrategy(readFileSync(dir + "/" + f, "utf8")); return { fixture: f, strategy: d.strategy, reason: d.reason, tokens: d.stats.tokens, sections: d.stats.sections, codePct: Math.round(d.stats.codeRatio * 100) }; }); console.log(JSON.stringify(rows))')"

web=null
if [ -n "${WEB_DIR:-}" ]; then
  (cd "$WEB_DIR" && pnpm exec vitest run --reporter=json --outputFile="$tmp/web.json" >"$tmp/web.log" 2>&1) || { tail -20 "$tmp/web.log"; echo "front end tests failed" >&2; exit 1; }
  web="$(node -p "const r=require('$tmp/web.json'); JSON.stringify({tests:r.numTotalTests,passed:r.numPassedTests})")"
fi

node -e '
const fs = require("fs");
const [tmp, pf, web, sha, router] = process.argv.slice(1);
const v = JSON.parse(fs.readFileSync(tmp + "/vitest.json", "utf8"));
const c = JSON.parse(fs.readFileSync("coverage/coverage-summary.json", "utf8")).total;
const pct = (k) => c[k].pct;
// statements per package: sum the files of the coverage summary by folder
const files = JSON.parse(fs.readFileSync("coverage/coverage-summary.json", "utf8"));
const groups = {};
for (const [file, m] of Object.entries(files)) {
  if (file === "total") continue;
  const rel = file.slice(file.indexOf(process.cwd()) === 0 ? process.cwd().length + 1 : 0);
  const g = rel.split("/").slice(0, 2).join("/").replace(/^evals\/src$/, "evals");
  groups[g] ??= { covered: 0, total: 0 };
  groups[g].covered += m.statements.covered;
  groups[g].total += m.statements.total;
}
const byPackage = Object.fromEntries(Object.entries(groups).map(([g, v]) => [g, Math.round((10000 * v.covered) / v.total) / 100]));
const out = {
  measuredOn: new Date().toISOString().slice(0, 10),
  commit: sha,
  command: "scripts/measure-facts.sh",
  tests: { total: v.numTotalTests, passed: v.numPassedTests, skipped: v.numPendingTests, failed: v.numFailedTests, files: v.numTotalTestSuites },
  coverage: { statements: pct("statements"), lines: pct("lines"), functions: pct("functions"), branches: pct("branches"), statementsByPackage: byPackage },
  promptfoo: JSON.parse(pf),
  web: JSON.parse(web),
  router: JSON.parse(router),
};
fs.writeFileSync("site/measured.json", JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
' "$tmp" "$pf" "$web" "$(git rev-parse --short HEAD)" "$router"
rm -rf "$tmp"
