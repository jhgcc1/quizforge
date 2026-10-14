"""Numbers of the architecture reports that come from files of the repository (never typed by hand).

Read at build time: the rule counts from packages/core/src/injection-rules.ts, the detector benchmark from docs/security/benchmark.json,
the pt/es validation from docs/security/replay-ptes.json and docs/security/real-readmes-pt-es.json.
The promptfoo suite sizes (offline 83, live 20, red-team sample 50 + 5 language-policy documents, nightly 32 intents x 10 texts x 2 cases) are
checked by running the suites (see promptfoo/README.md); they are the one group typed here, with the places that define them.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _json(rel):
    p = ROOT / rel
    return json.loads(p.read_text(encoding="utf8")) if p.exists() else None


_rules = (ROOT / "packages/core/src/injection-rules.ts").read_text(encoding="utf8")
_ids = re.findall(r'^  R\("([a-z]+-[a-z0-9-]+)"', _rules, re.M)
RULES_TOTAL = len(_ids)
RULES_PER_LANGUAGE = len([i for i in _ids if i.startswith("en-")])
RULES_LANGUAGE_FREE = len([i for i in _ids if i.startswith("all-")])
RULES_IMPERATIVE = len([i for i in _ids if not re.search(r"-system-prompt$|-what-are-your-instructions$", i)])
assert RULES_TOTAL == 3 * RULES_PER_LANGUAGE + RULES_LANGUAGE_FREE

PF_OFFLINE, PF_LIVE, PF_SAMPLE, PF_POLICY_DOCS = 83, 20, 50, 5
PF_NIGHTLY_INTENTS, PF_NIGHTLY_TEXTS, PF_NIGHTLY_CASES = 32, 10, 2
PF_NIGHTLY_TESTS = PF_NIGHTLY_INTENTS * PF_NIGHTLY_TEXTS * PF_NIGHTLY_CASES  # 640

BENCH = _json("docs/security/benchmark.json")
PTES = _json("docs/security/replay-ptes.json")
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
    t = {"rules_total": RULES_TOTAL, "rules_per_lang": RULES_PER_LANGUAGE, "rules_imp": RULES_IMPERATIVE, "pf_offline": PF_OFFLINE, "pf_live": PF_LIVE,
         "pf_nightly": PF_NIGHTLY_TESTS, "pf_nightly_intents": PF_NIGHTLY_INTENTS}
    if BENCH:
        en, al = bench_row("english"), bench_row("all")
        for p, r in (("en", en), ("all", al)):
            t.update({f"{p}_inj": r["injections"], f"{p}_ben": r["benign"], f"{p}_rules_n": r["rules"], f"{p}_rules_pct": f"{r['rulesPct']}%", f"{p}_pg2_n": r["pg2"], f"{p}_pg2_pct": f"{r['pg2Pct']}%",
                      f"{p}_either_n": r["either"], f"{p}_either_pct": f"{r['eitherPct']}%", f"{p}_fp": r["rulesFp"] + r["pg2Fp"] + r["eitherFp"]})
        prev = BENCH["previousDetector"]
        t.update({"deb_en": f"{prev['english']['recallPct']}%", "deb_all": f"{prev['all']['recallPct']}%", "deb_fp": prev["all"]["falsePositives"], "deb_pipecat": prev["pipecatReadme"]})
        worst = {r["name"]: r["score"] for r in BENCH["readmes"]}
        t.update({"pg2_pipecat": worst.get("pipecat.md"), "pg2_injection_md": worst.get("injection.md")})
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
