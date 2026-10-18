"""Numbers of the guardrails report that come from the measured files in docs/security (never typed by hand).

facts.py already reads the rule counts, the detector settings, the public benchmark and the pt/es validation. This module adds
the files the architecture reports do not use: the input preparation of the detector (detector-prep.json), the polite rules
(polite-rules.json), the planted-words rail on benign READMEs (planted-words-benign.json), the public-dataset part of the
nightly (public-datasets-nightly.json), the topic check (topic-check.json), the rule audit (guard-audit.json) and the CPU cost
of the guard (guard-cost.json, written by scripts/measure-guard-cost.mjs).

Every table of the report is built here from those files, so a number can only change when a measurement changes.
"""
import json
from pathlib import Path

from lib import table

ROOT = Path(__file__).resolve().parent.parent
SEC = ROOT / "docs" / "security"


def _json(name):
    p = SEC / name
    return json.loads(p.read_text(encoding="utf8")) if p.exists() else None


PREP = _json("detector-prep.json")
POLITE = _json("polite-rules.json")
PLANTED = _json("planted-words-benign.json")
PUBLIC = _json("public-datasets-nightly.json")
TOPIC = _json("topic-check.json")
AUDIT = _json("guard-audit.json")
COST = _json("guard-cost.json")
PTES_READMES = _json("guard-pt-es-readmes.json")
DEEPSET = _json("replay-deepset.json")

SHIPPED = "after: badges + cut-link clean-up (shipped)"
BEFORE = "before (as in production)"


def _kb(b):
    return f"{round(b / 1024)} KB"


# ---------------------------------------------------------------- cost of the guard


def cost_table():
    """CPU time of inspectText by document shape, at the largest size the API accepts, in both measured CPU profiles."""
    profiles = COST["profiles"]
    biggest = COST["maxSourceBytes"]
    order = ["cpu-100", "cpu-50"]
    heads = ["Shape of the document", "What it is", "Verdict"] + [
        ("full CPU core" if p == "cpu-100" else f"{profiles[p]['cpuQuotaPct']}% of a core (as in production)") for p in order if p in profiles
    ]
    rows = []
    for case in profiles[order[0]]["cases"]:
        if case["bytes"] != biggest:
            continue
        cells = [f"<code>{case['shape']}</code>", case["what"], case["verdict"]]
        for p in order:
            if p in profiles:
                ms = next(c["ms"] for c in profiles[p]["cases"] if c["shape"] == case["shape"] and c["bytes"] == biggest)
                cells.append(f"<b>{ms / 1000:.1f} s</b>" if ms >= 10_000 else f"{ms / 1000:.1f} s")
        rows.append(cells)
    rows.sort(key=lambda r: float(r[-1].replace("<b>", "").replace("</b>", "").removesuffix(" s")))
    return table(heads, rows, widths=["18%", "34%", "14%", "17%", "17%"])


def cost_scaling_table():
    """The same shapes by size: the cost grows with the bytes, in the production CPU profile."""
    p = COST["profiles"].get("cpu-50") or COST["profiles"]["cpu-100"]
    sizes = sorted({c["bytes"] for c in p["cases"]})
    rows = []
    for shape in dict.fromkeys(c["shape"] for c in p["cases"]):
        cells = [f"<code>{shape}</code>"]
        for b in sizes:
            ms = next(c["ms"] for c in p["cases"] if c["shape"] == shape and c["bytes"] == b)
            cells.append(f"{ms / 1000:.1f} s")
        rows.append(cells)
    return table(["Shape"] + [_kb(b) for b in sizes], rows)


def cost_facts():
    profiles = COST["profiles"]
    biggest = COST["maxSourceBytes"]
    out = {"gc_max_kb": _kb(biggest), "gc_commit": COST["commit"], "gc_repeats": COST["repeats"]}
    for p, suffix in (("cpu-100", "full"), ("cpu-50", "half")):
        if p not in profiles:
            continue
        at_max = [c for c in profiles[p]["cases"] if c["bytes"] == biggest]
        worst = max(at_max, key=lambda c: c["ms"])
        prose = next(c for c in at_max if c["shape"] == "prose")
        out[f"gc_{suffix}_prose"] = f"{prose['ms'] / 1000:.1f} s"
        out[f"gc_{suffix}_worst"] = f"{worst['ms'] / 1000:.1f} s"
        out[f"gc_{suffix}_worst_shape"] = worst["shape"]
    out["gc_cpu_pct"] = profiles.get("cpu-50", {}).get("cpuQuotaPct", 50)
    return out


# ---------------------------------------------------------------- detector: input preparation


def prep_fp_table():
    """False positives of Prompt Guard 2 per document set, as the pipeline runs today."""
    sets = PREP["falsePositives"]["sets"]
    rows = [[name, str(v["documents"]), str(v[SHIPPED]["flagged"]), f"{v[SHIPPED]['maxScore']:.2f}"] for name, v in sets.items()]
    tot = PREP["falsePositives"]["totals"]
    rows.append(["<b>All of them</b>", f"<b>{PREP['falsePositives']['documents']}</b>", f"<b>{tot[SHIPPED]}</b>", ""])
    return table(["Benign documents", "Documents", "Flagged", "Highest score"], rows, widths=["40%", "16%", "22%", "22%"])


def prep_recall_table():
    """What the detector catches on each attack set, as it runs today."""
    rows = [[name, str(v["documents"]), str(v[SHIPPED]["flagged"]), f"{v[SHIPPED]['recallPct']}%"] for name, v in PREP["recall"].items()]
    return table(["Attack set", "Documents", "Caught", "Recall"], rows, widths=["46%", "18%", "18%", "18%"])


def prep_wide_table():
    """The wide benign measurement: real READMEs in three languages, detector and rules side by side."""
    rows = []
    s = PREP["wideBenign"]["sets"]
    for lang, v in s.items():
        rows.append([lang, str(v["documents"]), str(v["flaggedAfter"]), str(v["rulesFlag"]), str(v["both"])])
    rows.append(["<b>all</b>"] + [f"<b>{sum(v[k] for v in s.values())}</b>" for k in ("documents", "flaggedAfter", "rulesFlag", "both")])
    return table(["Language", "READMEs", "Flagged by the detector", "Flagged by a keyword rule", "Both"], rows)


def two_signals_table():
    """Could a policy block on agreement? The measured answer, benign and attacks side by side."""
    ts = PREP["twoSignals"]
    cols = [k for k in ts["benign"] if k != "documents"]
    rows = []
    for key, label in (("benign", "Benign documents (false positives)"), ("nightly640", "One nightly run of attacks (recall)")):
        if key not in ts:
            continue
        rows.append([f"{label}, n={ts[key]['documents']}"] + [f"{ts[key][c]}%" for c in cols])
    label = lambda c: c.replace("rulesAlone", "Rules alone").replace("detector", "PG2").replace(">=", " ≥ ").replace("both(", "both: ").replace("either(", "either: ").replace(")", "").replace(" AND ", " and ").replace(" OR ", " or ")  # noqa: E731
    return table(["Policy"] + [label(c) for c in cols], rows)


def prep_facts():
    fp, wide, ts = PREP["falsePositives"], PREP["wideBenign"]["sets"], PREP["twoSignals"]
    out = {
        "dp_model": PREP["model"], "dp_threshold": f"{PREP['threshold']:g}", "dp_docs": fp["documents"],
        "dp_before": fp["totals"][BEFORE], "dp_after": fp["totals"][SHIPPED],
        "dp_variants": len(PREP["variants"]),
        "dp_wide_docs": sum(v["documents"] for v in wide.values()),
        "dp_wide_before": sum(v["flaggedBefore"] for v in wide.values()),
        "dp_wide_after": sum(v["flaggedAfter"] for v in wide.values()),
        "dp_wide_rules": sum(v["rulesFlag"] for v in wide.values()),
        "dp_wide_both": sum(v["both"] for v in wide.values()),
    }
    out["dp_wide_after_pct"] = f"{100 * out['dp_wide_after'] / out['dp_wide_docs']:.1f}%"
    out["dp_wide_rules_pct"] = f"{100 * out['dp_wide_rules'] / out['dp_wide_docs']:.1f}%"
    if "nightly640" in ts:
        out["dp_both_recall"] = f"{ts['nightly640']['both(detector>=0.5 AND rules)']}%"
        out["dp_rules_recall"] = f"{ts['nightly640']['rulesAlone']}%"
        out["dp_either_recall"] = f"{ts['nightly640']['either(detector>=0.5 OR rules)']}%"
    return out


# ---------------------------------------------------------------- polite rules and the rule audit


def polite_table():
    rows = []
    for name, v in POLITE["falsePositives"].items():
        rows.append([name, str(v["documents"]), str(v["anyRule"]), str(v["polite"])])
    rows.append(["<b>All of them</b>", f"<b>{sum(v['documents'] for v in POLITE['falsePositives'].values())}</b>",
                 f"<b>{sum(v['anyRule'] for v in POLITE['falsePositives'].values())}</b>",
                 f"<b>{sum(v['polite'] for v in POLITE['falsePositives'].values())}</b>"])
    return table(["Benign documents", "Documents", "Any rule matched", "A polite rule matched"], rows, widths=["40%", "14%", "23%", "23%"])


# Where each corpus of the rule audit comes from (the sources listed in promptfoo/redteam/audit-rules.ts).
AUDIT_SOURCES = {
    "dataset injections": "<b>deepset/prompt-injections</b> (public, Apache-2.0), the injection rows of the 500-row sample",
    "dataset benign": "the same public dataset, its benign rows — the false-positive side",
    "replay attacks": "the public attacks that were replayed through the real pipeline (<code>replay-deepset.json</code>)",
    "red-team sample": "the frozen red-team sample (<code>promptfoo/redteam/sample.yaml</code>), written by the attacker model and then frozen",
    "nightly intents": "the attack texts of the nightly (<code>intents-nightly.json</code>): 12 intents × en, pt, es × translation and paraphrase",
    "fixtures (benign)": "every benign document in <code>evals/fixtures</code>, the golden set of the repository",
    "fixture injection.md": "the one fixture that <i>is</i> an attack, kept as a positive control",
    "real READMEs": "real projects, downloaded at run time and never committed (only pointers are, in <code>real-readmes-pt-es.json</code>)",
    "attacks.ts techniques": "the hand-written attack corpus of the repository (<code>packages/core/src/attacks.ts</code>), shared by vitest and promptfoo",
    "attacks.ts bad topics": "the topic strings that must be refused, from the same file",
}


def audit_table():
    """Where each rule earns its place: the corpora the audit ran the rules against, and where each corpus comes from."""
    rows = []
    for name, n in AUDIT["groups"].items():
        key = next((k for k in AUDIT_SOURCES if name.startswith(k)), None)
        rows.append([name, str(n), AUDIT_SOURCES.get(key, "—")])
    sole = [r for r in AUDIT["rules"] if r["soleHits"] > 0]
    dead = [r for r in AUDIT["rules"] if r["total"] == 0]
    return table(["Corpus of the rule audit", "Documents", "Where it comes from"], rows, widths=["26%", "11%", "63%"]), len(sole), len(dead)


def polite_facts():
    rec = POLITE["recall"]
    key = next(iter(rec))
    out = {"pol_rules": POLITE["politeRules"], "pol_total_then": POLITE["totalRules"],
           "pol_cases": rec[key]["cases"], "pol_old": rec[key]["old"], "pol_with": rec[key]["withPolite"],
           "pol_fp_docs": sum(v["documents"] for v in POLITE["falsePositives"].values()),
           "pol_fp": sum(v["anyRule"] for v in POLITE["falsePositives"].values())}
    out["pol_old_pct"] = f"{100 * out['pol_old'] / out['pol_cases']:.0f}%"
    out["pol_with_pct"] = f"{100 * out['pol_with'] / out['pol_cases']:.0f}%"
    rules, sole, dead = AUDIT["rules"], 0, 0
    for r in rules:
        sole += 1 if r["soleHits"] > 0 else 0
        dead += 1 if r["total"] == 0 else 0
    import facts as F  # for the rule count of today
    out.update({"ga_rules": len(rules), "ga_sole": sole, "ga_dead": dead, "ga_corpora": len(AUDIT["groups"]),
                "ga_docs": sum(AUDIT["groups"].values()), "ga_rules_new": F.RULES_TOTAL - len({r["id"] for r in rules})})
    return out


# ---------------------------------------------------------------- the output rails


def planted_table():
    """The real READMEs where the planted-words rail still treats a word as planted, and which words."""
    before = sum(len(v["before"]) for v in PLANTED.values())
    after = sum(len(v["after"]) for v in PLANTED.values())
    worst = sorted(((k, v) for k, v in PLANTED.items() if v["after"]), key=lambda kv: -len(kv[1]["after"]))[:6]
    rows = [[f"<code>{k.split('/')[-1]}</code>", str(len(v["after"])), ", ".join(v["after"])] for k, v in worst]
    return table(["Real README with a rule-flagged line", "Words", "The words the rail treats as planted"], rows, widths=["34%", "10%", "56%"]), before, after


def replay_quality_table():
    """The quizzes made from READMEs that carry an attack: are they still about the document? (scoreQuiz, offline replay)"""
    s = TOPIC["replaySummary"]
    f = TOPIC["floors"]
    rows = [
        ["Quizzes scored (replay of public attacks)", str(s["quizzes"])],
        ["Grounded in the document", f"{100 * s['grounded']:.0f}%"],
        ["Relevance to the document (mean / lowest)", f"{s['relevanceMean']:.2f} / {s['relevanceMin']:.2f} (golden-set floor {f['relevance']})"],
        ["Question diversity (mean)", f"{s['diversityMean']:.3f} (floor {f['question_diversity']})"],
        ["Section coverage (mean)", f"{s['coverageMean']:.3f} (floor {f['coverage']})"],
        ["Quizzes under the relevance floor", f"{s['belowFloor']['relevance']} of {s['quizzes']}"],
        ["Quizzes using a content word that <b>only the attack text</b> had", f"<b>{s['withSteeringWords']}</b> of {s['quizzes']}"],
    ]
    return table(["The quiz under attack, measured offline", "Value"], rows, widths=["62%", "38%"])


def topic_live_table():
    """The topic field through the real pipeline: 5 fixtures x (no topic, a topic of the document, an unrelated topic)."""
    live = TOPIC["live"]
    rows = []
    for variant in dict.fromkeys(x["variant"] for x in live):
        xs = [x for x in live if x["variant"] == variant]
        def avg(k, xs=xs):  # `coverage` is missing for the one-section fixture, so each column averages what it has
            vals = [x[k] for x in xs if k in x]
            return f"{sum(vals) / len(vals):.2f}" + (f" (of {len(vals)})" if len(vals) < len(xs) else "") if vals else "—"
        rows.append([variant, str(len(xs)), avg("grounded"), avg("relevance"), avg("coverage"), avg("question_diversity")])
    return table(["Topic asked for", "Quizzes", "Grounded", "Relevance", "Coverage", "Diversity"], rows)


def output_facts():
    _, before, after = planted_table()
    s = TOPIC["replaySummary"]
    live = TOPIC["live"]
    return {"pw_docs": len(PLANTED), "pw_before": before, "pw_after": after,
            "tc_quizzes": s["quizzes"], "tc_below": s["belowFloor"]["relevance"], "tc_steering": s["withSteeringWords"],
            "tc_live": len(live), "tc_live_fixtures": len({x["fixture"] for x in live}),
            "tc_live_grounded": f"{100 * sum(x['grounded'] for x in live) / len(live):.0f}%"}


# ---------------------------------------------------------------- the nightly: public datasets


def public_table():
    t = PUBLIC["totals"]
    rows = [
        ["Cases built from the sources", str(PUBLIC["cases"])],
        ["Rows dropped (too short, or not an attack)", f"{PUBLIC['dropped']} dropped, {PUBLIC['tooShort']} too short"],
        ["Stage A: the guard sees the text in a README", str(t["stageA"])],
        ["Flagged by the keyword rules", str(t["rulesFlagged"])],
        ["Flagged by Prompt Guard 2", str(t["pg2Flagged"])],
        ["Passed both layers (they reached the prompts)", str(t["passedBoth"])],
        ["Stage B: a quiz was made with the real model", f"{PUBLIC['stageB']['cases']} cases, {PUBLIC['stageB']['quizzes']} quizzes"],
        ["Quizzes the oracle judged contaminated", f"<b>{t['contaminated']}</b>"],
        ["Documents in a refused language that reached the model", f"<b>{t['blockedLangReachedModel']}</b> of {PUBLIC['blockedLanguages']['cases']}"],
        ["Benign rows flagged (false positives)", f"{PUBLIC['benign']['flagged'] and len(PUBLIC['benign']['flagged']) or PUBLIC['benign']['either']} of {PUBLIC['benign']['cases']}"],
        ["Foreign-language attack inside a README in a supported language", f"{PUBLIC['foreignInSupported']['passed']} of {PUBLIC['foreignInSupported']['cases']} passed every layer"],
        ["Sources that could not be read", str(t["sourcesFailed"])],
    ]
    return table(["The public-dataset part of one nightly run", "Value"], rows, widths=["62%", "38%"])


def encoded_table():
    rows = [[k, str(v["cases"]), str(v["blockedBeforeModel"]), str(v["reachedModel"]), str(v["contaminated"])] for k, v in PUBLIC["encoded"].items()]
    return table(["Encoding", "Cases", "Blocked before the model", "Reached the model", "Contaminated a quiz"], rows)


def sources_table():
    """The public sources of the nightly: each one pinned to a revision, and the run says whether it drifted."""
    rows = []
    for x in PUBLIC["sources"]:
        rows.append([
            f"<code>{x.get('id', x.get('key'))}</code>", x.get("license", "—"), f"{x.get('rows', '—'):,}" if isinstance(x.get("rows"), int) else "—",
            f"<code>{(x.get('pinnedRevision') or '')[:10]}</code>" if x.get("pinnedRevision") else "—",
            ("drifted" if x.get("drifted") else "as pinned") + (f", {x['status']}" if x.get("status") and x["status"] != "ok" else ""),
        ])
    return table(["Public source", "Licence", "Rows", "Pinned revision", "State in the measured run"], rows)


def public_facts():
    t = PUBLIC["totals"]
    return {"pub_cases": PUBLIC["cases"], "pub_sources": len(PUBLIC["sources"]), "pub_stagea": t["stageA"],
            "pub_rules": t["rulesFlagged"], "pub_pg2": t["pg2Flagged"], "pub_passed": t["passedBoth"],
            "pub_contaminated": t["contaminated"], "pub_encoded_reached": t["encodedReachedModel"],
            "pub_blocked_langs": ", ".join(PUBLIC["blockedLanguages"]["languages"]),
            "pub_blocked_cases": PUBLIC["blockedLanguages"]["cases"], "pub_benign": PUBLIC["benign"]["cases"],
            "pub_foreign_cases": PUBLIC["foreignInSupported"]["cases"], "pub_foreign_passed": PUBLIC["foreignInSupported"]["passed"],
            "pub_seed": PUBLIC["config"]["seed"], "ptes_docs": PTES_READMES["documents"],
            "ds_name": DEEPSET["dataset"]["name"], "ds_attacks": len(DEEPSET["attacks"]), "ds_runs": len(DEEPSET["runs"])}


# ---------------------------------------------------------------- the alarms that watch the nightly

import os  # noqa: E402
import re as _re  # noqa: E402

INFRA_DIR = Path(os.environ.get("INFRA_DIR", Path.home() / "quizforge-infra"))
_RT = (INFRA_DIR / "terraform" / "redteam.tf").read_text(encoding="utf8")


_ECS = (INFRA_DIR / "terraform" / "ecs.tf").read_text(encoding="utf8")
LOG_RETENTION_DAYS = int(_re.search(r'resource "aws_cloudwatch_log_group" "svc" \{.*?retention_in_days\s*=\s*(\d+)', _ECS, _re.S).group(1))


def nightly_alarms():
    """Every alarm of terraform/redteam.tf, read from the file: the single ones plus the entries of the for_each map.

    `facts.ALARMS_REDTEAM` counts resource blocks, and one of them is a for_each over several alarms, so it is not the
    number of alarms. This counts the alarms themselves.
    """
    out = []
    for m in _re.finditer(r'resource "aws_cloudwatch_metric_alarm" "(\w+)" \{(.*?)\n\}', _RT, _re.S):
        block = m.group(2)
        if "for_each" in block:
            continue
        name = _re.search(r'alarm_name\s+= "\$\{local\.name\}-([\w-]+)"', block)
        desc = _re.search(r'alarm_description\s+= "(.*?)"\n', block, _re.S)
        out.append((name.group(1) if name else m.group(1), desc.group(1) if desc else ""))
    for m in _re.finditer(r'"(redteam-[\w-]+)" = \{(.*?)\n    \}', _RT, _re.S):
        desc = _re.search(r'description = "(.*?)"', m.group(2), _re.S)
        out.append((m.group(1), desc.group(1) if desc else ""))
    return out


def alarms_table():
    rows = [[f"<code>{n}</code>", d.replace("See redteam/latest/report.html", "See the report of the run")] for n, d in nightly_alarms()]
    return table(["Alarm", "What it means"], rows, widths=["30%", "70%"])


# ---------------------------------------------------------------- a proposal: strip link URLs

LINKS = _json("link-share.json")


def link_share_table():
    """How much of each test document is link URLs — the size of the prize for stripping them."""
    rows = []
    for d in sorted(LINKS["documents"], key=lambda d: -d["sharePct"])[:8]:
        rows.append([f"<code>{d['document']}</code>", f"{d['chars']:,}", f"{d['urls']}", f"<b>{d['sharePct']}%</b>", f"{d['tokensSaved']:,}"])
    t = LINKS["totals"]
    rows.append([f"<b>all {t['documents']} documents</b>", f"<b>{t['chars']:,}</b>", f"<b>{t['urls']}</b>", f"<b>{t['sharePct']}%</b>", f"<b>{t['tokensSaved']:,}</b>"])
    return table(["Test document", "Characters", "URLs", "Share that is URLs", "Tokens it would save"], rows,
                 widths=["30%", "16%", "10%", "20%", "24%"])


def link_facts():
    t = LINKS["totals"]
    return {"ls_docs": t["documents"], "ls_pct": f"{t['sharePct']}%", "ls_urls": t["urls"],
            "ls_tokens": f"{t['tokensSaved']:,}", "ls_max": f"{max(d['sharePct'] for d in LINKS['documents'])}%"}


def all_facts():
    out = {}
    for f in (cost_facts, prep_facts, polite_facts, output_facts, public_facts):
        out.update(f())
    out["rt_alarms"] = len(nightly_alarms())
    out["log_days"] = LOG_RETENTION_DAYS
    out.update(link_facts())
    out.update(detector_why_facts())
    out.update(detector_block_facts())
    return out


# ---------------------------------------------------------------- provenance: when each number was measured

import subprocess  # noqa: E402


def _measured_on(rel):
    """The date of the last commit that touched a measured file: when that measurement was taken."""
    try:
        out = subprocess.run(["git", "log", "-1", "--format=%cs %h", "--", rel], cwd=ROOT, capture_output=True, text=True, timeout=10)
        return out.stdout.strip() or "not committed yet"
    except Exception:
        return "unknown"


def provenance_table():
    """Every measurement this report stands on: the file, the day it was taken, and whether it still covers today's code.

    This is the honest part of a report whose numbers come from files: a measurement is a photograph, and the code moved on.
    """
    import facts as F  # local import: facts imports facts_repo, never this module

    rules_now = F.RULES_TOTAL
    rules_audited = len({r["id"] for r in AUDIT["rules"]})
    polite_then = POLITE["totalRules"]
    rows = [
        ["CPU cost of the guard", "<code>guard-cost.json</code>", _measured_on("docs/security/guard-cost.json"),
         f"The guard as it is now (commit <code>{COST['commit']}</code>), two CPU profiles", "<b>current</b>"],
        ["Public benchmark: recall and false positives", "<code>benchmark.json</code>", _measured_on("docs/security/benchmark.json"),
         "500 sampled rows of a public dataset against the rules and the detector", "<b>partial</b>: the rules changed after it, so this is the recall of that day"],
        ["Detector input preparation", "<code>detector-prep.json</code>", _measured_on("docs/security/detector-prep.json"),
         "415 benign documents, 8 attack sets, the two-signal policy table", "<b>current</b>: the preparation shipped with it"],
        ["Wide benign measurement", "<code>detector-prep.json</code> (<code>wideBenign</code>)", _measured_on("docs/security/detector-prep.json"),
         "722 real READMEs in en, pt and es", "<b>current</b> for the detector; the rule column predates the newest rules"],
        ["Rule audit (does each rule earn its place)", "<code>guard-audit.json</code>", _measured_on("docs/security/guard-audit.json"),
         f"{rules_audited} rules against {len(AUDIT['groups'])} corpora", f"<b>partial</b>: there are {rules_now} rules today, so {rules_now - rules_audited} have never been audited"],
        ["Polite and passive rules", "<code>polite-rules.json</code>", _measured_on("docs/security/polite-rules.json"),
         f"Recall on one nightly run, false positives on 415 benign documents, at {polite_then} rules", f"<b>partial</b>: measured at {polite_then} rules, today there are {rules_now}"],
        ["Planted-words rail on benign READMEs", "<code>planted-words-benign.json</code>", _measured_on("docs/security/planted-words-benign.json"),
         "The real READMEs that have a rule-flagged line, before and after the frequency list", "the rail itself is unchanged since, but the rules that decide which lines are flagged are not, so the count can have moved"],
        ["The quiz under attack, and the topic field", "<code>topic-check.json</code>", _measured_on("docs/security/topic-check.json"),
         "235 replay quizzes offline, 15 quizzes through the real model", "<b>predates the topic rules</b>: <code>topic-rules.ts</code> shipped later, so this measures the quiz, not those rules"],
        ["Public datasets at night", "<code>public-datasets-nightly.json</code>", _measured_on("docs/security/public-datasets-nightly.json"),
         "One nightly run: 420 cases from 5 pinned sources", "<b>partial</b>: the guard gained its rot13 and leetspeak tests after this run, so that part of the table is pessimistic"],
        ["Replay through the real pipeline", "<code>replay-deepset.json</code>, <code>replay-ptes.json</code>", _measured_on("docs/security/replay-deepset.json"),
         "Public attacks embedded in READMEs and run against the real model", "<b>partial</b>: predates the newest rules"],
        ["Test counts, coverage, suite sizes", "<code>site/measured.json</code>", _measured_on("site/measured.json"),
         "What only a run can give: tests, coverage, the size of the promptfoo suites", "see the date: re-run <code>scripts/measure-facts.sh</code> after a code change"],
        ["Rules, settings, alarms, CI, prompts", "the repository and <code>terraform/</code>", "read at build time",
         "Counted from the source files every time this page is built", "<b>always current</b>"],
    ]
    return table(["Measurement", "File", "Measured on", "What it covers", "Does it cover today's code?"], rows,
                 widths=["20%", "16%", "11%", "28%", "25%"])


# ---------------------------------------------------------------- why the detector only flags

BENCH = _json("benchmark.json")


def _attack_scores():
    """The detector's score for every injection of the public benchmark sample."""
    out = []
    for r in BENCH["results"]:
        if r.get("label") != 1:
            continue
        d = r.get("detector")
        s = d.get("score") if isinstance(d, dict) else d
        if isinstance(s, (int, float)):
            out.append(s)
    return sorted(out)


def threshold_sweep_table():
    """Raising the threshold does not buy anything on the public benchmark: fewer attacks caught, the same zero false positives."""
    rows = [[f"{r['threshold']:g}", f"{r['caught']} of {r['injections']} ({r['recallPct']}%)", f"{r['falsePositives']} of {r['benign']}"]
            for r in BENCH["thresholdSweep"]["all"]]
    return table(["Threshold", "Attacks caught (public benchmark)", "False positives (benign rows)"], rows, widths=["20%", "45%", "35%"])


def flagged_readmes_table():
    """The real READMEs the detector still flags, with their score and how many attacks score lower."""
    scores = _attack_scores()
    below = lambda s: f"{100 * sum(1 for x in scores if x < s) / len(scores):.0f}%"  # noqa: E731
    rows = []
    for x in sorted(PREP["wideBenign"]["flaggedAfter"], key=lambda x: -x["after"]):
        rows.append([f"<code>{x['doc']}</code>", f"{x['after']:.3f}", below(x["after"]), "yes" if x.get("rules") else "no"])
    return table(["Real README, flagged with no attack in it", "Score", "Attacks of the benchmark scoring lower", "A keyword rule also matched"], rows,
                 widths=["42%", "12%", "26%", "20%"])


# The score from which a document is refused, read from the code so this page cannot drift from production.
BLOCK_AT = float(
    _re.search(r"export const DEFAULT_BLOCK_THRESHOLD = ([\d.]+)", (ROOT / "packages" / "llm" / "src" / "detector.ts").read_text(encoding="utf8")).group(1)
)


def blocked_readmes_table():
    """The real READMEs that the block threshold refuses: the whole case for the review flow, by name."""
    rows = [
        [f"<code>{x['doc']}</code>", f"{x['after']:.3f}", "yes" if x.get("rules") else "no"]
        for x in sorted(PREP["wideBenign"]["flaggedAfter"], key=lambda x: -x["after"])
        if x["after"] >= BLOCK_AT
    ]
    return table(["Real README refused by the classifier, with no attack in it", "Score", "A keyword rule also matched"], rows,
                 widths=["58%", "18%", "24%"])


def detector_block_facts():
    flagged = PREP["wideBenign"]["flaggedAfter"]
    blocked = [x for x in flagged if x["after"] >= BLOCK_AT]
    docs = sum(v["documents"] for v in PREP["wideBenign"]["sets"].values())
    return {
        "db_at": f"{BLOCK_AT:g}",
        "db_n": len(blocked),
        "db_clean": sum(1 for x in blocked if not x.get("rules")),
        "db_pct": f"{100 * len(blocked) / docs:.1f}%" if docs else "?",
        "db_flagged_not_blocked": len(flagged) - len(blocked),
    }


def detector_why_facts():
    scores = _attack_scores()
    mid = scores[len(scores) // 2]
    flagged = PREP["wideBenign"]["flaggedAfter"]
    top = max(flagged, key=lambda x: x["after"])
    sweep = BENCH["thresholdSweep"]["all"]
    return {
        "dw_attack_median": f"{mid:.3f}", "dw_attacks": len(scores),
        "dw_top_doc": top["doc"].split("/")[-1], "dw_top_score": f"{top['after']:.3f}",
        "dw_top_below": f"{100 * sum(1 for x in scores if x < top['after']) / len(scores):.0f}%",
        "dw_flagged_n": len(flagged),
        "dw_flagged_over_99": sum(1 for x in flagged if x["after"] >= 0.99),
        "dw_flagged_rules": sum(1 for x in flagged if x.get("rules")),
        "dw_sweep_low": f"{sweep[0]['recallPct']}%", "dw_sweep_high": f"{sweep[-1]['recallPct']}%",
        "dw_sweep_high_t": f"{sweep[-1]['threshold']:g}",
    }
