"""Facts of the architecture reports read from the files that define them (see the header of facts.py).

Nothing here is a typed number, with two kinds of exception that are named where they appear: the AWS unit prices of the cost
estimate, and the numbers in site/measured.json, which scripts/measure-facts.sh writes by running the tests.
"""
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# The infrastructure (Terraform, the operations scripts, the deploy workflow) is in its own repository, jhgcc1/quizforge-infra.
# The reports read it from a checkout: INFRA_DIR=/path/to/quizforge-infra (default: a sibling directory called quizforge-infra).
INFRA_DIR = Path(os.environ.get("INFRA_DIR") or ROOT.parent / "quizforge-infra")
assert (INFRA_DIR / "terraform" / "ecs.tf").exists(), f"the infrastructure repository is not at {INFRA_DIR}: git clone https://github.com/jhgcc1/quizforge-infra and set INFRA_DIR"


def _text(rel):
    return (ROOT / rel).read_text(encoding="utf8")


def _itext(rel):  # a file of the infrastructure repository
    return (INFRA_DIR / rel).read_text(encoding="utf8")


def _json(rel):
    p = ROOT / rel
    return json.loads(p.read_text(encoding="utf8")) if p.exists() else None


# ---------------------------------------------------------------- what only a run can give: site/measured.json
MEASURED = _json("site/measured.json")
assert MEASURED, "site/measured.json is missing: run scripts/measure-facts.sh"
PF_OFFLINE, PF_LIVE = MEASURED["promptfoo"]["offline"], MEASURED["promptfoo"]["live"]
TESTS_TOTAL = MEASURED["tests"]["total"]
TESTS_SKIPPED = MEASURED["tests"].get("skipped", 0)
TESTS_DATE = MEASURED["measuredOn"]
COV = MEASURED["coverage"]
WEB_TESTS = MEASURED["web"]["tests"] if MEASURED.get("web") else None
E2E_TESTS = len(re.findall(r"^\s*test\(", _text("e2e/quiz.spec.ts"), re.M))

# ---------------------------------------------------------------- promptfoo suites
PF_SAMPLE = len(re.findall(r"^- description:", _text("promptfoo/redteam/sample.yaml"), re.M))
PF_POLICY_DOCS = len(re.findall(r"^- description:", _text("promptfoo/redteam/language-policy.yaml"), re.M))
PF_BASE_INTENTS = len(re.findall(r'^  \{ id: "', _text("promptfoo/redteam/intents.ts"), re.M))
PF_NIGHTLY_ONLY_INTENTS = len(re.findall(r'^  intent\("', _text("promptfoo/redteam/intents-nightly.ts"), re.M))
PF_NIGHTLY_INTENTS = PF_BASE_INTENTS + PF_NIGHTLY_ONLY_INTENTS
PF_NIGHTLY_TEXTS = int(re.search(r"REDTEAM_NUM_TESTS:-(\d+)", _text("scripts/redteam-nightly-aws.sh")).group(1))
PF_NIGHTLY_CASES = 2  # plain and jailbreak template (promptfoo/README.md)
PF_NIGHTLY_TESTS = PF_NIGHTLY_INTENTS * PF_NIGHTLY_TEXTS * PF_NIGHTLY_CASES
_sample = _text("promptfoo/redteam/sample.yaml")
PF_SAMPLE_LANGS = {lang: len(re.findall(rf"^    lang: {lang}$", _sample, re.M)) for lang in ("en", "pt", "es")}
_strat = {}
for _d in re.findall(r"^- description: REDTEAM (.+)$", _text("promptfoo/redteam/sample.yaml"), re.M):
    _strat[_d.split()[2]] = _strat.get(_d.split()[2], 0) + 1
PF_SAMPLE_STRATEGIES = ", ".join(f"{k} {v}" for k, v in sorted(_strat.items(), key=lambda kv: (-kv[1], kv[0])))
_apitest = _text("apps/api/src/app.int.test.ts")
_bad = _apitest.split("const bad: [string, unknown][] = [")[1].split("\n    ];")[0]
BAD_API_CALLS = len(re.findall(r'^      \["', _bad, re.M))
CONTRACT_VERSION = json.loads(_text("packages/contract/package.json"))["version"]
_cmpj = _json("docs/eval/structure-comparison.json")
CMP_VARIANTS = len(_cmpj["variants"]) if _cmpj else None
CMP_ITEMS = len(_cmpj["items"]) if _cmpj else None
CMP_REPS = max((c.get("rep") or 1) for c in _cmpj["cells"]) if _cmpj else None
CMP_STRUCT, CMP_JUDGE_DELTA, CMP_NOISE = {}, None, None
if _cmpj:
    for _c in _cmpj["cells"]:
        if _c.get("composite") is not None:
            CMP_STRUCT.setdefault(_c["structure"], []).append(_c["composite"])
    CMP_STRUCT = {k: sum(v) / len(v) for k, v in CMP_STRUCT.items()}
    _j = {}
    for _c in _cmpj["cells"]:
        if _c.get("ok"):
            _j.setdefault(_c["prompt"], []).append(_c["scores"].get("judge_overall", 0))
    _jm = {k: sum(v) / len(v) for k, v in _j.items()}
    CMP_JUDGE_DELTA = _jm["conceptual"] - _jm["baseline"]
    _noise = re.search(r"±(0\.\d+)", _text("docs/eval/structure-comparison.html"))
    CMP_NOISE = _noise.group(1) if _noise else None
PF_SAMPLE_INTENTS = len(set(re.findall(r"^    canary: (ZX9-\w+)$", _sample, re.M)))

# the attack corpus (packages/core/src/attacks.ts) and how promptfoo/tests.ts builds the suites from it
_att = _text("packages/core/src/attacks.ts")
ATTACK_BLOCK = len(re.findall(r'expect: "block", embed', _att))
ATTACK_FLAG = len(re.findall(r'expect: "flag", embed', _att))


def _array_len(name):
    body = _att.split(f"export const {name}")[1].split("\n];")[0]
    return len(re.findall(r'^  \{ id: "', body, re.M))


BAD_TOPICS_N, LANG_UNSUPPORTED_N, LANG_SUPPORTED_N = _array_len("BAD_TOPICS"), _array_len("UNSUPPORTED_LANGUAGE_DOCS"), _array_len("SUPPORTED_LANGUAGE_DOCS")
OUTPUT_CASES_N = len(re.findall(r'^  \["[a-z-]+", "', _text("promptfoo/tests.ts"), re.M))
FIXTURES_N = len(list((ROOT / "evals/fixtures").glob("*.md")))
# the groups of the corpus table in the full report (encoded 15, hidden Unicode 4, hidden markup 6): the sum must match the corpus
ATTACK_GROUPS_BLOCK = (15, 4, 6)
ATTACK_GROUPS_FLAG = (3, 3, 9)  # the same sentence in 3 languages, the attacker link in 3 languages, 9 places
assert sum(ATTACK_GROUPS_FLAG) == ATTACK_FLAG, "the attack corpus changed: update the groups in content_full.py and ATTACK_GROUPS_FLAG"
PF_VERSION = re.search(r'PROMPTFOO_VERSION: "([\d.]+)"', _text(".github/workflows/ci.yml")).group(1)
assert sum(ATTACK_GROUPS_BLOCK) == ATTACK_BLOCK, "the attack corpus changed: update the groups in content_full.py and ATTACK_GROUPS_BLOCK"
assert PF_OFFLINE == 1 + FIXTURES_N + ATTACK_BLOCK + LANG_UNSUPPORTED_N + LANG_SUPPORTED_N + BAD_TOPICS_N + OUTPUT_CASES_N + ATTACK_FLAG, "promptfoo offline suite size does not match its parts: re-run scripts/measure-facts.sh"
assert PF_LIVE == 1 + ATTACK_FLAG + 4, "promptfoo live suite size does not match its parts: re-run scripts/measure-facts.sh"

# ---------------------------------------------------------------- golden set (evals/src/golden.ts, evals/src/metrics.ts)
LANG_NAME = {"en": "English", "pt": "Portuguese", "es": "Spanish"}


def _golden():
    src = _text("evals/src/golden.ts").split("export const GOLDEN")[1]
    items = []
    for chunk in re.split(r"(?=\bid: \")", src)[1:]:
        lang = re.search(r'language: "(\w+)"', chunk)
        items.append({
            "id": re.match(r'id: "([^"]+)"', chunk).group(1),
            "language": lang.group(1) if lang else "?",
            "modelOnly": "modelOnly: true" in chunk,
            "file": (re.search(r'file: "([^"]+)"', chunk) or re.search(r'url: "([^"]+)"', chunk)).group(1),
        })
    return items


GOLDEN = _golden()
GOLDEN_N = len(GOLDEN)
GOLDEN_MODEL_ONLY = [g["id"] for g in GOLDEN if g["modelOnly"]]
GOLDEN_OFFLINE_N = GOLDEN_N - len(GOLDEN_MODEL_ONLY)
_metrics = _text("evals/src/metrics.ts")
THRESHOLDS = {k: float(v) for k, v in re.findall(r"^\s{2}(\w+): ([\d.]+),", _metrics.split("export const THRESHOLDS")[1].split("} as const")[0], re.M)}
MEAN_JUDGE_MIN = float(re.search(r"MEAN_JUDGE_MIN = ([\d.]+)", _metrics).group(1))
MEAN_LINT_MIN = float(re.search(r"MEAN_LINT_MIN = ([\d.]+)", _metrics).group(1))
# Every dataset bar, read from MEAN_BARS rather than named one by one: relevance and coverage joined lint and judge
# once the measurement showed their per-item floors had no margin left, and a hand-written list missed them.
MEAN_BARS = {
    k: (MEAN_JUDGE_MIN if v == "MEAN_JUDGE_MIN" else MEAN_LINT_MIN if v == "MEAN_LINT_MIN" else float(v))
    for k, v in re.findall(r"^\s{2}(\w+): ([\w.]+),", _metrics.split("export const MEAN_BARS")[1].split("} as const")[0], re.M)
}
FIXTURES = sorted(p.stem for p in (ROOT / "evals/fixtures").glob("*.md"))
FIXTURES_NOT_IN_GOLDEN = [f for f in FIXTURES if f not in {Path(g["file"]).stem for g in GOLDEN}]


def _num(x):
    return f"{x:g}"


def golden_items_html():
    return ", ".join(f"<code>{g['id']}</code> ({LANG_NAME.get(g['language'], g['language'])}{', real model only' if g['modelOnly'] else ''})" for g in GOLDEN)


def golden_floors_html():
    return ", ".join(f"{k.replace('_', ' ')} {_num(v)}" for k, v in THRESHOLDS.items())


def golden_means_html():
    return ", ".join(f"mean {k} {_num(v)}" for k, v in MEAN_BARS.items())


def golden_languages_text():
    langs = sorted({g["language"] for g in GOLDEN}, key=list(LANG_NAME).index)
    missing = [LANG_NAME[x] for x in LANG_NAME if x not in langs]
    t = " and ".join(LANG_NAME[x] for x in langs)
    return t + (f"; no {' or '.join(missing)} item" + (f" (a {' / '.join(missing)} document exists in evals/fixtures but is not in the set)" if FIXTURES_NOT_IN_GOLDEN and "spanish" in FIXTURES_NOT_IN_GOLDEN else "") if missing else "")


# ---------------------------------------------------------------- infrastructure (quizforge-infra: terraform/)
_obs = _itext("terraform/observability.tf")
_alarm_block = _obs.split("alarms = {")[1].split('resource "aws_cloudwatch_metric_alarm" "app"')[0]
ALARM_NAMES = re.findall(r"^    ([a-z0-9]+(?:-[a-z0-9]+)+) = \{", _alarm_block, re.M)
ALARMS_MONITORING = len(ALARM_NAMES)
ALARMS_SCALING = len(re.findall(r'resource "aws_cloudwatch_metric_alarm"', _itext("terraform/ecs.tf")))
# One of the alarm RESOURCES is a for_each over a map, so counting resource blocks undercounts: count the single alarms plus
# the entries of that map.
_rt = _itext("terraform/redteam.tf")
ALARMS_REDTEAM = len([b for b in re.findall(r'resource "aws_cloudwatch_metric_alarm" "\w+" \{(.*?)\n\}', _rt, re.S) if "for_each" not in b]) + len(
    re.findall(r'"(redteam-[\w-]+)" = \{', _rt)
)
ALARMS_TOTAL = ALARMS_MONITORING + ALARMS_SCALING + ALARMS_REDTEAM
ALARMS_QUALITY = len([a for a in ALARM_NAMES if a.startswith("quiz-quality") or a == "judge-failing"])
DASHBOARD_WIDGETS = len(re.findall(r'\{ type = "(?:metric|log)"', _obs))
_ecs = _itext("terraform/ecs.tf")
LOG_GROUPS = re.findall(r'"(\w+)"', re.search(r'aws_cloudwatch_log_group" "svc" \{\s*for_each\s*=\s*toset\(\[([^\]]*)\]', _ecs).group(1))
ECS_SERVICES = re.findall(r'resource "aws_ecs_service" "(\w+)"', _ecs)
AUDIT_CHECKS = len(re.findall(r"^chk ", _itext("scripts/audit-aws.sh"), re.M)) + len(ECS_SERVICES)  # one rollout check per service
CATALOG_DOCS = len(re.findall(r'^  \{ id: "', _text("packages/core/src/catalog.ts"), re.M))
CATALOG_REAL = len(re.findall(r'kind: "readme"', _text("packages/core/src/catalog.ts")))
PROMPTS_IN_CATALOG = len(re.findall(r'\{ name: "quizforge/', _text("packages/llm/src/prompt-catalog.ts")))

# ---------------------------------------------------------------- CI (.github/workflows/ci.yml; the deploy is quizforge-infra .github/workflows/deploy.yml; github/main.tf)
_jobs = _text(".github/workflows/ci.yml").split("\njobs:\n")[1]
CI_JOBS = {}
for _m in re.finditer(r"^  ([a-z0-9-]+):\n((?:    .*\n|\n)*)", _jobs, re.M):
    _body = _m.group(2)
    _if = re.search(r"^    if: (.*)$", _body, re.M)
    _needs = re.search(r"^    needs: \[(.*)\]", _body, re.M)
    CI_JOBS[_m.group(1)] = {"if": _if.group(1) if _if else "", "needs": _needs.group(1).split(", ") if _needs else []}
CI_PR_JOBS = [j for j, v in CI_JOBS.items() if not v["if"] or "pull_request" in v["if"]]
CI_REQUIRED = re.findall(r'"([\w-]+)"', re.search(r"required_checks = concat\(\s*\[([^\]]*)\]", _itext("github/main.tf")).group(1))
CI_DEPLOY_NEEDS = CI_JOBS["publish"]["needs"]  # the gates every image must pass before it is published (and so can be deployed)
# The production path (approval, migration, apply, smoke tests) lives in the reusable apply.yml, which both Deploy and
# Rollback call; deploy.yml only resolves the main of each side.
_apply_yml = _itext(".github/workflows/apply.yml")
SMOKE_FULL = len(re.findall(r'^\s+expect "', _apply_yml, re.M))  # scope all or api
SMOKE_WEB = len(re.findall(r'^\s+expect "', _apply_yml.split("Smoke test through CloudFront")[1].split('if [ "$SCOPE" != web ]; then')[0], re.M))  # the checks every scope runs
WORKFLOWS = sorted(p.name for p in (ROOT / ".github/workflows").glob("*.yml"))

# ---------------------------------------------------------------- cost estimate
# Task sizes come from variables.tf. The unit prices are AWS list prices (us-east-2, ARM64 Fargate), typed here: the result is an
# estimate from the price list, not the bill.
_vars = _itext("terraform/variables.tf")


def _var(name):
    return float(re.search(rf'variable "{name}" \{{.*?default\s*=\s*(\d+)', _vars, re.S).group(1))


FARGATE_VCPU_H, FARGATE_GB_H, HOURS = 0.03238, 0.00356, 730
_tasks = [(_var("web_min"), _var("task_cpu"), _var("task_memory")), (_var("api_min"), _var("task_cpu"), _var("task_memory")),
          (_var("worker_min"), _var("worker_cpu"), _var("worker_memory")), (_var("scorer_min"), _var("scorer_cpu"), _var("scorer_memory"))]
RUNNING_TASKS = int(sum(n for n, _, _ in _tasks))
COST_FARGATE = sum(n * (cpu / 1024 * FARGATE_VCPU_H + mem / 1024 * FARGATE_GB_H) * HOURS for n, cpu, mem in _tasks)
COST_SCORER = _tasks[3][0] * (_tasks[3][1] / 1024 * FARGATE_VCPU_H + _tasks[3][2] / 1024 * FARGATE_GB_H) * HOURS
COST_ALB = (0.0225 + 2 * 0.005) * HOURS      # load balancer hour and its 2 public IPv4 addresses
COST_NAT = (0.045 + 0.005) * HOURS           # NAT gateway hour and its Elastic IP
COST_RDS = 0.016 * HOURS + 20 * 0.115        # db.t4g.micro and 20 GB gp3
COST_RDS_STORAGE = 20 * 0.115                # stays while the database is stopped
COST_KMS_SECRETS = 3 * 1.0 + 6 * 0.40        # 3 KMS keys (state, alarms, reports) and 6 secrets
COST_WAF = 5 + 3 * 1.0                       # web ACL and 3 rules (deleted while paused)
COST_RUNNING = COST_FARGATE + COST_ALB + COST_NAT + COST_RDS + COST_KMS_SECRETS + COST_WAF
COST_PAUSED = COST_RDS_STORAGE + COST_KMS_SECRETS
LLM_PER_QUIZ = LLM_RUNS = None
_cmp = _json("docs/eval/structure-comparison.json")
if _cmp:
    _ok = [c for c in _cmp["cells"] if c.get("ok")]
    LLM_RUNS, LLM_PER_QUIZ = len(_ok), sum(c["costUsd"] for c in _ok) / len(_ok)


def r5(x):
    return int(5 * round(x / 5))

# ---------------------------------------------------------------- the semantic detector (packages/detector, packages/llm/src/detector.ts)
_det = _text("packages/detector/src/index.ts")
_chunk = _text("packages/detector/src/chunk.ts")
DETECTOR_THRESHOLD = float(re.search(r"DEFAULT_THRESHOLD = ([\d.]+)", _det).group(1))
# The second threshold: the score from which the document is refused outright (and the user offered a review).
DETECTOR_BLOCK_AT = float(re.search(r"DEFAULT_BLOCK_THRESHOLD = ([\d.]+)", _text("packages/llm/src/detector.ts")).group(1))
DETECTOR_WINDOW_CHARS = int(re.search(r"maxChars \?\? (\d+)", _chunk).group(1))
# How many real READMEs the refusal threshold costs, from the same measurement the guardrails report prints in full
# (docs/security/detector-prep.json). Kept here as well so the architecture pages can state the price without
# repeating a number by hand.
_prep = json.loads(_text("docs/security/detector-prep.json"))["wideBenign"]
WIDE_DOCS = sum(v["documents"] for v in _prep["sets"].values())
BLOCKED_READMES = sum(1 for x in _prep["flaggedAfter"] if x["after"] >= DETECTOR_BLOCK_AT)
DETECTOR_MAX_WINDOWS = int(re.search(r"maxChunks \?\? (\d+)", _chunk).group(1))
DETECTOR_EXCERPT_CHARS = int(re.search(r"excerpt: chunks\[best\.index\]!\.slice\(0, (\d+)\)", _det).group(1))
FLAGGED_ALARM = int(_var("flagged_documents_alarm"))
REJECTED_ALARM = int(_var("rejected_documents_alarm"))
DB_TABLES = len(re.findall(r"= pgTable\(", _text("packages/db/src/schema.ts")))
_rules_src = _text("packages/core/src/injection-rules.ts")
RULES_PER_CATEGORY = {}
for _cat in re.findall(r'^  R\("en-[a-z0-9-]+", "(\w+)"', _rules_src, re.M):
    RULES_PER_CATEGORY[_cat] = RULES_PER_CATEGORY.get(_cat, 0) + 1

# ---------------------------------------------------------------- coverage floors (vitest.coverage.config.ts) and per-package coverage (site/measured.json)
_covcfg = _text("vitest.coverage.config.ts")
COV_FLOORS = {k: int(v) for k, v in re.findall(r'"((?:packages/\w+|apps/\w+|evals)/src/\*\*)": \{ statements: (\d+)', _covcfg)}
COV_BY_PKG = COV.get("statementsByPackage", {})
COV_FULL_PKGS = [g for g, v in COV_BY_PKG.items() if v == 100]
COV_PARTIAL = {g: v for g, v in COV_BY_PKG.items() if v < 100}


def cov_floor(pkg):
    return COV_FLOORS.get(f"{pkg}/src/**")


# ---------------------------------------------------------------- is the document text at all (packages/core/src/text.ts)
_text_src = _text("packages/core/src/text.ts")
TEXT_MAGIC_N = len(re.findall(r"^  \[/", _text_src, re.M))
TEXT_SHARE_MAX = float(re.search(r"REPLACEMENT_SHARE_MAX = ([\d.]+)", _text_src).group(1))
TEXT_MIN_CHARS = int(re.search(r"MIN_CHARS_FOR_RATIO = (\d+)", _text_src).group(1))
SNIFF_BYTES = int(re.search(r"SNIFF_BYTES = (\d+)", _text("packages/llm/src/source.ts")).group(1))

# ---------------------------------------------------------------- when the AI tests run (eval.yml, variables.tf)
# eval.yml has no schedule: the golden set runs on every merge to main (job `llm-eval`) and on demand.
_ec = re.search(r'cron: "(\d+) (\d+) \* \* \*"', _text(".github/workflows/eval.yml"))
EVAL_TIME = f"{int(_ec.group(2)):02d}:{int(_ec.group(1)):02d} UTC" if _ec else "on demand"
_rc = re.search(r'variable "redteam_schedule".*?default\s*=\s*"cron\((\d+) (\d+) ', _vars, re.S)
REDTEAM_TIME = f"{int(_rc.group(2)):02d}:{int(_rc.group(1)):02d} UTC"

# ---------------------------------------------------------------- who is the user on a request, and how the database is queried
_app = _text("apps/api/src/app.ts")
API_PUBLIC_ROUTES = [f"{m.upper()} {p}" for m, p in re.findall(r'app\.(get|post|put)\("(/[^"]*)"', _app)]
API_V1_ROUTES = [f"{m.upper()} /v1{p}" for m, p in re.findall(r'v1\.(get|post|put)(?:<.*?>)?\(\s*"(/[^"]*)"', _app)]
_repo = _text("packages/db/src/repo.ts")
_imported = re.search(r'import \{([^}]*)\} from "@quizforge/db";', _app).group(1)
API_DB_FUNCS = [n.strip() for n in _imported.split(",") if n.strip() and not n.strip().startswith("type ")]
API_DB_FUNCS = [n for n in API_DB_FUNCS if re.search(rf"export (?:async )?function {n}\b", _repo)]
_chunks = {m.group(1): m.group(0) for m in re.finditer(r"export (?:async )?function (\w+)\b.*?(?=\n(?:export |/\*\*|/\* ---)|\Z)", _repo, re.S)}
API_DB_OWNER_SCOPED = [n for n in API_DB_FUNCS if re.search(r"t\.\w+\.(?:ownerSub|userSub)\b|getOwnedAttempt\(db, \w+, (?:userSub|p\.userSub)\)", _chunks[n])]
API_DB_UNSCOPED = [n for n in API_DB_FUNCS if n not in API_DB_OWNER_SCOPED]
# A repo function the API calls without filtering by the signed-in user needs a reason, and the reason has to be one of
# three. Anything else is a leak of one user's data to another, so a new name here fails the build on purpose.
API_UNSCOPED_REASON = {
    "getPublicQuestions": "reads by quiz id, and only after getOwnedQuiz has already proved ownership",
    "approvedCatalogEntries": "the catalogue is the same list for everybody by design, and holds no user data",
    "listedCatalogEntries": "the catalogue is the same list for everybody by design, and holds no user data",
    "createDocumentRequest": "an insert, not a read: it stores the requester's own sub, taken from the token",
    "listDocumentRequests": "the review queue, deliberately everyone's requests — the route is gated on the admin group and the API checks it again",
    "reviewDocumentRequest": "an admin decision on a request id — same gate",
}
assert set(API_DB_UNSCOPED) == set(API_UNSCOPED_REASON), (
    f"the identity rule of the API changed: unscoped repo functions called by the API are {API_DB_UNSCOPED}, "
    f"documented ones are {sorted(API_UNSCOPED_REASON)}; give the new one a reason here and in the section "
    "'Who is the user on every request'"
)
assert len(API_V1_ROUTES) == 12 and len(API_PUBLIC_ROUTES) == 4, (API_V1_ROUTES, API_PUBLIC_ROUTES)
_repo_all = re.findall(r"export (?:async )?function (\w+)\b", _repo)
REPO_FUNCS_N = len(_repo_all)
REPO_OTHER_FUNCS_N = len([n for n in _repo_all if n not in API_DB_FUNCS])  # the worker, the scorer and the sweeper

_dbpkg = json.loads(_text("packages/db/package.json"))
DRIZZLE_ORM = _dbpkg["dependencies"]["drizzle-orm"].lstrip("^")
DRIZZLE_KIT = _dbpkg["devDependencies"]["drizzle-kit"].lstrip("^")
_lock = _text("pnpm-lock.yaml")
DRIZZLE_ORM_LOCKED = re.search(r"^  drizzle-orm@([\d.]+)", _lock, re.M).group(1)
PG_LOCKED = re.search(r"^  pg@([\d.]+):", _lock, re.M).group(1)
MIGRATIONS_N = len(list((ROOT / "packages/db/migrations").glob("*.sql")))

_src_files = [p for pat in ("apps/*/src/**/*.ts", "packages/*/src/**/*.ts") for p in ROOT.glob(pat) if ".test." not in p.name and "node_modules" not in p.parts]
SQL_TAGGED = sum(len(re.findall(r"\bsql`", p.read_text(encoding="utf8"))) for p in _src_files)
SQL_RAW_OR_CALLED = sum(len(re.findall(r"\bsql\.raw\(|\bsql\(", p.read_text(encoding="utf8"))) for p in _src_files)
SQL_CALL_TAGGED = SQL_CALL_CONST = SQL_CALL_DYNAMIC = 0
for _p in _src_files:
    for _m in re.finditer(r"\.(?:execute|query)\(\s*(sql`|\"[^\"\n]*\"|.)", _p.read_text(encoding="utf8")):
        _a = _m.group(1)
        if _a == "sql`":
            SQL_CALL_TAGGED += 1
        elif _a.startswith('"') and "+" not in _a and "${" not in _a:
            SQL_CALL_CONST += 1
        else:
            SQL_CALL_DYNAMIC += 1
assert SQL_RAW_OR_CALLED == 0 and SQL_CALL_DYNAMIC == 0, "string-built SQL found: the section 'Who is the user on every request' must be reviewed"


# ---- the strategy router (`auto`): every number is read from the code, the examples are measured by scripts/measure-facts.sh
_router_src, _graph_src, _source_src = _text("packages/llm/src/router.ts"), _text("packages/llm/src/quiz-graph.ts"), _text("packages/llm/src/source.ts")


def _int(pattern, text):
    m = re.search(pattern, text)
    assert m, f"strategy router fact not found: {pattern}"
    return int(next(g for g in m.groups() if g).replace("_", ""))


ROUTER_MAX_TOKENS = _int(r"SINGLE_SHOT_MAX_TOKENS = ([\d_]+)", _router_src)
ROUTER_MIN_SECTIONS = _int(r"MIN_SECTIONS_FOR_MAP_REDUCE = (\d+)", _router_src)
ROUTER_SECTION_MIN_TOKENS = _int(r"filter\(\(s\) => s\.tokens >= (\d+)\)", _router_src)
MAP_SECTIONS = _int(r"deps\.mapSections \?\? (\d+)", _graph_src)
MAP_CONCURRENCY = _int(r"deps\.concurrency \?\? (\d+)", _graph_src)
MAP_CANDIDATES_PER_SECTION = _int(r"sectionUser\(\{[^}]*n: (\d+)", _graph_src)
MAX_SINGLE_SHOT_CHARS = _int(r"MAX_SINGLE_SHOT_CHARS = ([\d_]+)", _graph_src)
CHARS_PER_TOKEN = _int(r"Math\.ceil\(s\.length / (\d+)\)", _source_src)
HEADING_MAX_LEVEL = _int(r"\^\(#\{1,(\d)\}\)", _source_src)
ROUTER_ROWS = MEASURED.get("router") or []
