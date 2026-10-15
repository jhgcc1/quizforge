"""Numbers of the architecture reports that come from files of the repository (never typed by hand).

Read at build time: the rule counts from packages/core/src/injection-rules.ts, the detector benchmark from docs/security/benchmark.json,
the pt/es validation from docs/security/replay-ptes.json and docs/security/real-readmes-pt-es.json.
Everything else (golden set, alarms, CI jobs, cost, test counts, coverage, promptfoo suite sizes) is read in facts_repo.py from the files that
define it; what only a run can give (test counts, coverage, the offline and live suite sizes, front end tests) is in site/measured.json,
written by scripts/measure-facts.sh with the date and the commit.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _json(rel):
    p = ROOT / rel
    return json.loads(p.read_text(encoding="utf8")) if p.exists() else None


_rules = "\n".join((ROOT / f"packages/core/src/{f}.ts").read_text(encoding="utf8") for f in ("injection-rules", "injection-rules-polite"))  # the polite forms live in their own file
_ids = re.findall(r'^  R\("([a-z]+-[a-z0-9-]+)"', _rules, re.M)
RULES_TOTAL = len(_ids)
RULES_PER_LANGUAGE = len([i for i in _ids if i.startswith("en-")])
RULES_LANGUAGE_FREE = len([i for i in _ids if i.startswith("all-")])
RULES_POLITE = len([i for i in _ids if "-polite-" in i])
RULES_IMPERATIVE = len([i for i in _ids if not re.search(r"-system-prompt$|-what-are-your-instructions$", i)])
assert RULES_TOTAL == 3 * RULES_PER_LANGUAGE + RULES_LANGUAGE_FREE

from facts_repo import *  # noqa: E402,F401,F403
from facts_repo import _num  # noqa: E402  (everything read from the infrastructure, CI, golden set and site/measured.json)

BENCH = _json("docs/security/benchmark.json")
PTES = _json("docs/security/replay-ptes.json")
DFP = _json("docs/security/detector-fp.json")
READMES = _json("docs/security/real-readmes-pt-es.json")


def pct(a, b):
    return f"{round(100 * a / b, 1)}%" if b else "0%"


def bench_row(key):
    """Recall of the rules, of Prompt Guard 2 and of either, from benchmark.json ('english' or 'all')."""
    r = BENCH[key]
    return {
        "injections": r["injections"], "benign": r["benign"],
        "rules": r["guardCaught"], "rulesPct": r["guardRecallPct"], "rulesFp": r["guardFalsePositives"],
        "pg2": r["detectorCaught"], "pg2Pct": r["detectorRecallPct"], "pg2Fp": r["detectorFalsePositives"],
        "either": r["eitherCaught"], "eitherPct": r["eitherRecallPct"], "eitherFp": r["eitherFalsePositives"],
    }


def _tokens():
    t = {"rules_polite": RULES_POLITE, "rules_total": RULES_TOTAL, "rules_per_lang": RULES_PER_LANGUAGE, "rules_imp": RULES_IMPERATIVE, "pf_offline": PF_OFFLINE, "pf_live": PF_LIVE,
         "pf_nightly": PF_NIGHTLY_TESTS, "pf_nightly_intents": PF_NIGHTLY_INTENTS}
    ci_pr = len(CI_PR_JOBS)
    t.update({
        "alarms_total": ALARMS_TOTAL, "alarms_mon": ALARMS_MONITORING, "alarms_scaling": ALARMS_SCALING, "alarms_redteam": ALARMS_REDTEAM, "alarms_quality": ALARMS_QUALITY,
        "dash_widgets": DASHBOARD_WIDGETS, "log_groups": len(LOG_GROUPS), "log_group_names": ", ".join(LOG_GROUPS), "ecs_services": len(ECS_SERVICES), "audit_checks": AUDIT_CHECKS,
        "catalog_docs": CATALOG_DOCS, "catalog_real": CATALOG_REAL, "catalog_test": CATALOG_DOCS - CATALOG_REAL, "prompts_n": PROMPTS_IN_CATALOG,
        "ci_pr_jobs": ci_pr, "ci_required": len(CI_REQUIRED), "ci_deploy_needs": len(CI_DEPLOY_NEEDS), "workflows_n": len(WORKFLOWS),
        "ci_pr_job_names": ", ".join(CI_PR_JOBS), "ci_required_names": ", ".join(CI_REQUIRED),
        "tests_total": f"{TESTS_TOTAL:,}", "tests_run": f"{TESTS_TOTAL - TESTS_SKIPPED:,}", "tests_skipped": TESTS_SKIPPED, "tests_date": TESTS_DATE,
        "cov_stmt": f"{COV['statements']}%", "cov_lines": f"{COV['lines']}%", "cov_fn": f"{COV['functions']}%", "cov_br": f"{COV['branches']}%",
        "e2e_tests": E2E_TESTS, "web_tests": WEB_TESTS, "pf_sample": PF_SAMPLE, "pf_policy": PF_POLICY_DOCS, "pf_sample_intents": PF_SAMPLE_INTENTS,
        "pf_sample_en": PF_SAMPLE_LANGS["en"], "pf_sample_pt": PF_SAMPLE_LANGS["pt"], "pf_sample_es": PF_SAMPLE_LANGS["es"], "pf_base_intents": PF_BASE_INTENTS,
        "golden_n": GOLDEN_N, "golden_offline_n": GOLDEN_OFFLINE_N, "golden_items": golden_items_html(), "golden_floors": golden_floors_html(), "golden_means": golden_means_html(),
        "golden_langs": golden_languages_text(), "golden_mean_judge": _num(MEAN_JUDGE_MIN), "golden_mean_lint": _num(MEAN_LINT_MIN),
        "cost_running": r5(COST_RUNNING), "cost_paused": round(COST_PAUSED), "cost_running_day": f"{COST_RUNNING / 30:.0f}", "cost_paused_day": f"{COST_PAUSED / 30:.1f}",
        "cost_fargate": round(COST_FARGATE), "cost_alb": round(COST_ALB), "cost_nat": round(COST_NAT), "cost_rds": round(COST_RDS),
        "cost_other": round(COST_KMS_SECRETS + COST_WAF), "cost_other_paused": round(COST_KMS_SECRETS), "cost_rds_paused": f"{COST_RDS_STORAGE:.1f}",
        "rules_free": RULES_LANGUAGE_FREE, "rules_langs": 3 * RULES_PER_LANGUAGE, "det_windows": DETECTOR_MAX_WINDOWS, "det_chars": f"{DETECTOR_WINDOW_CHARS:,}", "det_threshold": f"{DETECTOR_THRESHOLD:g}", "det_excerpt": DETECTOR_EXCERPT_CHARS, "flagged_alarm": FLAGGED_ALARM, "rejected_alarm": REJECTED_ALARM,
        "cmp_oneshot": f"{CMP_STRUCT['one-shot']:.3f}", "cmp_plan": f"{CMP_STRUCT['plan-then-write']:.3f}", "cmp_critique": f"{CMP_STRUCT['critique-loop']:.3f}", "cmp_judge_delta": f"{CMP_JUDGE_DELTA:.3f}", "cmp_noise": CMP_NOISE, "pf_version": PF_VERSION, "cost_scorer": round(COST_SCORER), "ag_flag_lang": ATTACK_GROUPS_FLAG[0], "ag_flag_link": ATTACK_GROUPS_FLAG[1], "ag_flag_places": ATTACK_GROUPS_FLAG[2], "pf_nightly_texts": PF_NIGHTLY_TEXTS, "db_tables": DB_TABLES, "pf_strategies": PF_SAMPLE_STRATEGIES, "bad_api_calls": BAD_API_CALLS, "contract_version": CONTRACT_VERSION, "cmp_variants": CMP_VARIANTS, "cmp_items": CMP_ITEMS, "cmp_reps": CMP_REPS, "cmp_runs": (CMP_VARIANTS or 0) * (CMP_REPS or 0), "fixtures_n": FIXTURES_N, "attack_block": ATTACK_BLOCK, "attack_flag": ATTACK_FLAG, "bad_topics_n": BAD_TOPICS_N, "lang_unsupported_n": LANG_UNSUPPORTED_N, "lang_supported_n": LANG_SUPPORTED_N, "output_cases_n": OUTPUT_CASES_N, "ag_encoded": ATTACK_GROUPS_BLOCK[0], "ag_unicode": ATTACK_GROUPS_BLOCK[1], "ag_markup": ATTACK_GROUPS_BLOCK[2], "lang_policy_n": LANG_UNSUPPORTED_N + LANG_SUPPORTED_N, "smoke_full": SMOKE_FULL, "smoke_web": SMOKE_WEB, "cost_multiaz": r5(COST_RDS + COST_NAT), "running_tasks": RUNNING_TASKS, "llm_per_quiz": f"{LLM_PER_QUIZ:.3f}" if LLM_PER_QUIZ else "n/a", "llm_runs": LLM_RUNS,
    })
    t.update({
        "eval_time": EVAL_TIME, "redteam_time": REDTEAM_TIME, "api_public_n": len(API_PUBLIC_ROUTES), "api_v1_n": len(API_V1_ROUTES), "api_db_n": len(API_DB_FUNCS),
        "api_db_scoped": len(API_DB_OWNER_SCOPED), "repo_n": REPO_FUNCS_N, "repo_other_n": REPO_OTHER_FUNCS_N, "drizzle_orm": DRIZZLE_ORM, "drizzle_kit": DRIZZLE_KIT,
        "drizzle_locked": DRIZZLE_ORM_LOCKED, "pg_locked": PG_LOCKED, "migrations_n": MIGRATIONS_N, "sql_tagged": SQL_TAGGED, "sql_const": SQL_CALL_CONST, "sql_call_tagged": SQL_CALL_TAGGED,
    })
    t.update({
        "router_max_tokens": f"{ROUTER_MAX_TOKENS:,}", "router_min_sections": ROUTER_MIN_SECTIONS, "router_section_min_tokens": ROUTER_SECTION_MIN_TOKENS,
        "map_sections": MAP_SECTIONS, "map_concurrency": MAP_CONCURRENCY, "map_candidates": MAP_CANDIDATES_PER_SECTION,
        "single_shot_chars": f"{MAX_SINGLE_SHOT_CHARS:,}", "chars_per_token": CHARS_PER_TOKEN, "heading_max_level": HEADING_MAX_LEVEL,
    })
    if BENCH:
        en, al = bench_row("english"), bench_row("all")
        for p, r in (("en", en), ("all", al)):
            t.update({f"{p}_inj": r["injections"], f"{p}_ben": r["benign"], f"{p}_rules_n": r["rules"], f"{p}_rules_pct": f"{r['rulesPct']}%", f"{p}_pg2_n": r["pg2"], f"{p}_pg2_pct": f"{r['pg2Pct']}%",
                      f"{p}_either_n": r["either"], f"{p}_either_pct": f"{r['eitherPct']}%", f"{p}_fp": r["rulesFp"] + r["pg2Fp"] + r["eitherFp"]})
        prev = BENCH["previousDetector"]
        t.update({"deb_en": f"{prev['english']['recallPct']}%", "deb_all": f"{prev['all']['recallPct']}%", "deb_fp": prev["all"]["falsePositives"], "deb_pipecat": prev["pipecatReadme"]})
        worst = {r["name"]: r["score"] for r in BENCH["readmes"]}
        t.update({"pg2_pipecat": worst.get("pipecat.md"), "pg2_injection_md": worst.get("injection.md")})
    if DFP:
        sets = DFP["sets"]
        readme_sets = [v for k, v in sets.items() if "READMEs" in k and "templates" not in k]
        t.update({
            "dfp_docs": sum(v["documents"] for v in sets.values()), "dfp_pg2": sum(v["promptGuard2"] for v in sets.values()), "dfp_deb": sum(v["deberta"] for v in sets.values()),
            "dfp_readmes": sum(v["documents"] for v in readme_sets), "dfp_pg2_readmes": sum(v["promptGuard2"] for v in readme_sets), "dfp_deb_readmes": sum(v["deberta"] for v in readme_sets),
            "dfp_pg2_max": max(v["maxScorePg2"] for v in readme_sets),
        })
    if READMES:
        e = READMES["entries"]
        t.update({"readmes_pt": len([x for x in e if x["language"] == "pt"]), "readmes_es": len([x for x in e if x["language"] == "es"]), "readmes_words": sum(x["proseWords"] for x in e)})
    return t


def tok(s):
    """Replace [[name]] in a text by the number read from the repository files."""
    t = _tokens()

    def rep(m):
        if m.group(1) not in t:
            raise KeyError(f"unknown fact [[{m.group(1)}]]")
        return str(t[m.group(1)])
    return re.sub(r"\[\[([a-z0-9_]+)\]\]", rep, s)
