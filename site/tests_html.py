"""Rows of the coverage table, shared by both reports. Numbers: site/measured.json (scripts/measure-facts.sh) and vitest.coverage.config.ts."""
import facts as F


def _names(pkgs):
    return ", ".join(f"<code>{p}</code>" for p in pkgs)


def coverage_rows():
    rows = [[_names(F.COV_FULL_PKGS), "100%", f"Every statement. The floor in CI is {F.cov_floor(F.COV_FULL_PKGS[0])}% of statements and lines for each of them"]]
    for pkg, v in F.COV_PARTIAL.items():
        rows.append([f"<code>{pkg}</code>", f"{v}%", f"Floor in CI: {F.cov_floor(pkg)}%. Start-up guards and scripts that call the real model are left out or partly covered, with a written reason in <code>vitest.coverage.config.ts</code>"])
    rows.append(["All back end and shared code", f"<b>{F.COV['statements']}%</b> of statements, {F.COV['lines']}% of lines, {F.COV['functions']}% of functions, {F.COV['branches']}% of branches",
                 f"Measured on {F.TESTS_DATE} over {F.TESTS_TOTAL:,} tests ({F.TESTS_TOTAL - F.TESTS_SKIPPED:,} run, {F.TESTS_SKIPPED} skipped). <b>Enforced in CI:</b> the run fails if a package drops below its floor"])
    rows.append(["Front end (<code>quizforge-web</code>)", f"{F.WEB_TESTS} unit and jsdom component tests", "In its own repository, with coverage floors for the helpers, the components and the route handlers. The end-to-end test here covers the screens in a real browser"])
    return rows
