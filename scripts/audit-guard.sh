#!/usr/bin/env bash
# Read-only audit of the PRODUCTION guard configuration. Only AWS describe/list/get/filter calls: nothing is created, changed or run.
#
#   scripts/audit-guard.sh                      (uses profile turboai-615737882760, region us-east-2, cluster quizforge-prod)
#   AWS_PROFILE=... AWS_REGION=... CLUSTER=... DAYS=7 scripts/audit-guard.sh
#
# Checks (PASS / FAIL / WARN / INFO lines with the values; exit code 1 when any FAIL):
#   1. the task definitions of the worker, api and scorer carry the expected guard settings (env on the task definition or the default in code)
#   2. the worker log says "semantic injection detector enabled" recently, with mode flag and the onnx model name, and no loading error
#   3. the metrics DocumentRejected, InjectionFlagged, InjectionDetected, DetectorMs, DetectorFailed: do they exist and their recent sums
#   4. the alarms injection-flagged-spike, documents-rejected-spike and redteam-leak exist, and their state
#   5. DetectorFailed is 0
# The expected values come from the code: apps/worker/src/config.ts, packages/detector/src/index.ts, docker/*/Dockerfile.
# The infrastructure itself is in the separate repo quizforge-infra: this script only reads and reports, it does not fix.
set -uo pipefail
export AWS_PROFILE="${AWS_PROFILE:-turboai-615737882760}"
export AWS_REGION="${AWS_REGION:-us-east-2}"
export AWS_DEFAULT_REGION="$AWS_REGION"
export AWS_PAGER=""
export CLUSTER="${CLUSTER:-quizforge-prod}"
export PREFIX="${PREFIX:-quizforge-prod}"
export DAYS="${DAYS:-7}"
export LOG_GROUP="${LOG_GROUP:-/quizforge/prod/worker}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ROOT

command -v aws >/dev/null || { echo "FAIL aws cli not found"; exit 1; }
command -v python3 >/dev/null || { echo "FAIL python3 not found"; exit 1; }

exec python3 -I - <<'PY'
import json, os, subprocess, sys, time, re

P, C, DAYS, LOG_GROUP, ROOT = os.environ["PREFIX"], os.environ["CLUSTER"], int(os.environ["DAYS"]), os.environ["LOG_GROUP"], os.environ["ROOT"]
fails = 0
findings = []


def aws(*args):
    r = subprocess.run(["aws", *args, "--output", "json"], capture_output=True, text=True)
    if r.returncode != 0:
        return None, r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "aws call failed"
    return (json.loads(r.stdout) if r.stdout.strip() else {}), None


def say(level, text):
    global fails
    if level == "FAIL":
        fails += 1
    print(f"{level:<5} {text}")


def finding(text):
    findings.append(text)


def read(path):
    try:
        return open(os.path.join(ROOT, path), encoding="utf8").read()
    except OSError:
        return ""


# ---- the expected values, read from the code of this checkout
worker_cfg = read("apps/worker/src/config.ts")
detector_src = read("packages/detector/src/index.ts")
m = re.search(r"DEFAULT_THRESHOLD\s*=\s*([0-9.]+)", detector_src)
DEFAULT_THRESHOLD = m.group(1) if m else "?"
m = re.search(r'ALLOWED_LANGUAGES:[^\n]*default\("([^"]*)"\)', worker_cfg)
DEFAULT_LANGS = m.group(1) if m else "en,pt,es"
m = re.search(r'SOURCE_ALLOWED_HOSTS:[^\n]*default\("([^"]*)"\)', worker_cfg)
DEFAULT_HOSTS = m.group(1) if m else "github.com,raw.githubusercontent.com"
m = re.search(r"MAX_DOCUMENT_CHARS\s*=\s*([0-9_]+)", read("packages/llm/src/llm-input.ts"))
MAX_CHARS = m.group(1).replace("_", "") if m else "?"
BAKED = re.search(r"INJECTION_DETECTOR_MODEL_DIR=(\S+)", "".join(read(f"docker/{d}/Dockerfile") for d in sorted(os.listdir(os.path.join(ROOT, "docker"))) if os.path.isdir(os.path.join(ROOT, "docker", d))))
BAKED_DIR = BAKED.group(1) if BAKED else None

print(f"audit of {C} in {os.environ['AWS_REGION']} (profile {os.environ['AWS_PROFILE']}), last {DAYS} days; code defaults: threshold {DEFAULT_THRESHOLD}, languages {DEFAULT_LANGS}, hosts {DEFAULT_HOSTS}, max document {MAX_CHARS} chars, baked model dir {BAKED_DIR}")
who, err = aws("sts", "get-caller-identity")
if who is None:
    say("FAIL", f"cannot call AWS: {err}")
    sys.exit(1)
print(f"INFO  identity {who.get('Arn')}")

# ---------------------------------------------------------------------------------------------------------------- 1. task definitions
print("\n== 1. task definitions")
envs = {}
tags = {}
for role in ("worker", "api", "scorer"):
    td, err = aws("ecs", "describe-task-definition", "--task-definition", f"{P}-{role}")
    if td is None:
        say("FAIL", f"{role}: cannot read the task definition: {err}")
        continue
    t = td["taskDefinition"]
    c = t["containerDefinitions"][0]
    env = {e["name"]: e["value"] for e in c.get("environment", [])}
    envs[role] = env
    tags[role] = c["image"].split(":")[-1]
    print(f"INFO  {role}: revision {t['revision']}, image {c['image'].split('/')[-1]}, cpu {t.get('cpu')}, memory {t.get('memory')} MiB, secrets {sorted(s['name'] for s in c.get('secrets', []))}")
    svc, _ = aws("ecs", "describe-services", "--cluster", C, "--services", role)
    s0 = ((svc or {}).get("services") or [{}])[0]
    if s0:
        running = s0.get("taskDefinition", "").split("/")[-1]
        print(f"INFO  {role}: service runs {running}, desired {s0.get('desiredCount')}, running {s0.get('runningCount')}")
        if running != f"{P}-{role}:{t['revision']}":
            say("WARN", f"{role}: the service runs {running}, the latest active revision is {t['revision']}")

if len(set(tags.values())) > 1:
    say("WARN", f"the services run different image tags: {tags}")
for role, tag in tags.items():
    g = subprocess.run(["git", "-C", ROOT, "rev-list", "--count", f"{tag}..origin/main"], capture_output=True, text=True)
    if g.returncode == 0 and role == "worker":
        n = int(g.stdout.strip() or 0)
        say("INFO", f"production image {tag[:7]} is {n} commit(s) behind origin/main of this checkout" + (" (the newest guard rules are not deployed yet)" if n else ""))
w = envs.get("worker", {})
if w:
    v = w.get("INJECTION_DETECTOR")
    say("PASS" if v == "flag" else "FAIL", f"worker INJECTION_DETECTOR={v!r} (expected 'flag')")
    d = w.get("INJECTION_DETECTOR_MODEL_DIR")
    if d:
        say("PASS", f"worker INJECTION_DETECTOR_MODEL_DIR={d} (set on the task definition)")
    elif BAKED_DIR:
        say("INFO", f"worker INJECTION_DETECTOR_MODEL_DIR is not on the task definition; the Dockerfile bakes ENV {BAKED_DIR} into the image (the log check below proves the model loads)")
    else:
        say("FAIL", "worker INJECTION_DETECTOR_MODEL_DIR is neither on the task definition nor baked in a Dockerfile")
    th = w.get("INJECTION_DETECTOR_THRESHOLD")
    if th is None:
        say("PASS", f"worker INJECTION_DETECTOR_THRESHOLD not set: the code default {DEFAULT_THRESHOLD} applies")
    else:
        say("PASS" if th == DEFAULT_THRESHOLD else "WARN", f"worker INJECTION_DETECTOR_THRESHOLD={th} (default {DEFAULT_THRESHOLD})")
    langs = w.get("ALLOWED_LANGUAGES")
    if langs is None:
        say("PASS" if DEFAULT_LANGS == "en,pt,es" else "FAIL", f"worker ALLOWED_LANGUAGES not set: the code default '{DEFAULT_LANGS}' applies (expected en,pt,es)")
    else:
        say("PASS" if sorted(langs.split(",")) == ["en", "es", "pt"] else "FAIL", f"worker ALLOWED_LANGUAGES={langs!r} (expected en,pt,es)")
    hosts = w.get("SOURCE_ALLOWED_HOSTS")
    exp = sorted(DEFAULT_HOSTS.split(","))
    if hosts is None:
        say("PASS", f"worker SOURCE_ALLOWED_HOSTS not set: the code default '{DEFAULT_HOSTS}' applies (SSRF allow-list)")
    else:
        say("PASS" if sorted(hosts.split(",")) == exp else "WARN", f"worker SOURCE_ALLOWED_HOSTS={hosts!r} (default {DEFAULT_HOSTS})")
    say("INFO", f"document size: no environment variable, the limit is the code constant MAX_DOCUMENT_CHARS={MAX_CHARS}; output rails: no environment variable, they are code (packages/llm/src/output-guard.ts)")
    td, _ = aws("ecs", "describe-task-definition", "--task-definition", f"{P}-worker")
    mem = int(td["taskDefinition"].get("memory", 0)) if td else 0
    if mem and mem < 3072:
        say("WARN", f"worker memory {mem} MiB: the detector comment in apps/worker/src/main.ts says it needs about 3 GB")
        finding(f"worker task memory is {mem} MiB, below the ~3 GB the detector needs")
    elif mem:
        say("PASS", f"worker memory {mem} MiB (the detector needs about 3 GB)")
else:
    say("FAIL", "worker task definition not read")

a = envs.get("api", {})
if a:
    h = a.get("SOURCE_ALLOWED_HOSTS")
    if h is None:
        say("PASS", f"api SOURCE_ALLOWED_HOSTS not set: the code default '{DEFAULT_HOSTS}' applies")
    else:
        say("PASS" if sorted(h.split(",")) == sorted(DEFAULT_HOSTS.split(",")) else "WARN", f"api SOURCE_ALLOWED_HOSTS={h!r}")
    say("PASS" if a.get("AUTH_MODE") == "cognito" else "FAIL", f"api AUTH_MODE={a.get('AUTH_MODE')!r} (expected cognito)")
    say("INFO", f"api has no INJECTION_DETECTOR (it only enqueues; the worker reads the document) and DAILY_QUIZ_QUOTA={a.get('DAILY_QUIZ_QUOTA')}")
s = envs.get("scorer", {})
if s:
    say("INFO", f"scorer: INJECTION_DETECTOR={s.get('INJECTION_DETECTOR')!r} (the scorer reads the text the worker already admitted and stored, so no detector is expected)")

# ---------------------------------------------------------------------------------------------------------------- 2. worker log
print("\n== 2. worker log")
since = int((time.time() - DAYS * 86400) * 1000)


def log_events(pattern, limit=200):
    out, err = aws("logs", "filter-log-events", "--log-group-name", LOG_GROUP, "--filter-pattern", pattern, "--start-time", str(since), "--max-items", str(limit))
    return (out or {}).get("events", []) if out is not None else None


enabled = log_events('"semantic injection detector enabled"')
if enabled is None:
    say("FAIL", f"cannot read the log group {LOG_GROUP}")
elif not enabled:
    say("FAIL", f"no 'semantic injection detector enabled' line in the last {DAYS} days")
else:
    last = enabled[-1]
    msg = last["message"]
    try:
        j = json.loads(msg)
    except ValueError:
        j = {}
    mode, det = j.get("mode"), j.get("detector")
    when = time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime(last["timestamp"] / 1000))
    say("PASS", f"'semantic injection detector enabled' {len(enabled)} time(s) in {DAYS} days, last {when}")
    say("PASS" if mode == "flag" else "FAIL", f"detector mode in the log: {mode!r} (expected 'flag')")
    say("PASS" if det and det.startswith("onnx:") and "Prompt-Guard-2" in det else "FAIL", f"detector name in the log: {det!r} (expected onnx:...Llama-Prompt-Guard-2-86M-onnx)")
for pat, label in (('"INJECTION_DETECTOR is set but"', "the detector package missing from the image"), ('"semantic detector failed"', "a detector call failed")):
    ev = log_events(pat, 50)
    if ev is None:
        say("FAIL", f"cannot read the log for {label}")
    else:
        say("PASS" if not ev else "FAIL", f"{len(ev)} log line(s) for: {label} (last {DAYS} days)")
flagged = log_events('"the semantic detector flags this document"', 200)
if flagged is not None:
    scores = []
    for e in flagged:
        try:
            scores.append(round(json.loads(e["message"]).get("score", 0), 3))
        except ValueError:
            pass
    say("INFO", f"the detector flagged {len(flagged)} document(s) in {DAYS} days; scores {scores[:20]}")
kw = log_events('"instructions aimed at a model"', 200)
if kw is not None:
    say("INFO", f"the keyword rules flagged {len(kw)} document(s) in {DAYS} days")

# ---------------------------------------------------------------------------------------------------------------- 3. metrics
print("\n== 3. metrics (namespace QuizForge)")
lm, err = aws("cloudwatch", "list-metrics", "--namespace", "QuizForge")
names = {}
for mt in (lm or {}).get("Metrics", []):
    names.setdefault(mt["MetricName"], []).append(mt.get("Dimensions", []))
end = time.time()
sums = {}
for name in ("DocumentRejected", "InjectionFlagged", "InjectionDetected", "DetectorMs", "DetectorFailed"):
    dimsets = names.get(name)
    if not dimsets:
        sums[name] = None
        say("INFO", f"{name}: no datapoints in the last 2 weeks (CloudWatch only lists a metric after its first event)")
        continue
    total, count = 0.0, 0.0
    for dims in dimsets:
        args = ["cloudwatch", "get-metric-statistics", "--namespace", "QuizForge", "--metric-name", name, "--start-time", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(end - DAYS * 86400)), "--end-time", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(end)), "--period", str(DAYS * 86400), "--statistics", "Sum", "SampleCount", "--dimensions"]
        args += [f"Name={d['Name']},Value={d['Value']}" for d in dims] or []
        if not dims:
            args = args[:-1]
        st, _ = aws(*args)
        for p in (st or {}).get("Datapoints", []):
            total += p["Sum"]
            count += p["SampleCount"]
    sums[name] = (total, count)
    unit = "ms total" if name == "DetectorMs" else "events"
    avg = f", mean {total / count:.0f} ms per document" if name == "DetectorMs" and count else ""
    say("PASS", f"{name}: exists, sum over {DAYS} days = {total:g} {unit}{avg} (dimensions {[ [d['Value'] for d in ds] for ds in dimsets ]})")
df = sums.get("DetectorFailed")
if flagged is not None and enabled and sums.get("DetectorMs") is None:
    say("WARN", "DetectorMs has no datapoints although the detector is enabled: it has not scanned a document in the last 2 weeks, so its behaviour in production is untested by real traffic")
    finding("DetectorMs has no datapoints in the last 2 weeks: no real document went through the detector, only the nightly red team exercises it")
if sums.get("InjectionDetected") is None and sums.get("DetectorMs") is not None:
    say("INFO", "InjectionDetected has no datapoints: the detector scanned documents and flagged none")

# ---------------------------------------------------------------------------------------------------------------- 4. alarms
print("\n== 4. alarms")
for short in ("injection-flagged-spike", "documents-rejected-spike", "redteam-leak"):
    al, err = aws("cloudwatch", "describe-alarms", "--alarm-names", f"{P}-{short}")
    items = (al or {}).get("MetricAlarms", [])
    if not items:
        say("FAIL", f"alarm {P}-{short} does not exist")
        continue
    x = items[0]
    detail = f"{x.get('Namespace')}/{x.get('MetricName')} {x.get('Statistic') or x.get('ExtendedStatistic')} {x.get('ComparisonOperator')} {x.get('Threshold')} over {x.get('EvaluationPeriods')}x{x.get('Period')}s, missing data = {x.get('TreatMissingData')}, actions {'yes' if x.get('AlarmActions') else 'NONE'}"
    state = x.get("StateValue")
    level = "PASS" if state == "OK" else ("WARN" if state == "INSUFFICIENT_DATA" else "WARN")
    say("PASS", f"alarm {P}-{short} exists: {detail}")
    say(level, f"alarm {P}-{short} state {state}: {x.get('StateReason', '')[:200]}")
    if not x.get("AlarmActions"):
        finding(f"alarm {short} has no alarm action (nobody is notified)")
    if short == "redteam-leak" and state == "ALARM":
        finding("alarm redteam-leak is in ALARM: the last nightly red team found a canary leak")

# ---------------------------------------------------------------------------------------------------------------- 5. DetectorFailed
print("\n== 5. DetectorFailed")
if df is None:
    say("PASS", "DetectorFailed has no datapoints: the detector never failed in the last 2 weeks (value 0)")
else:
    say("PASS" if df[0] == 0 else "FAIL", f"DetectorFailed sum over {DAYS} days = {df[0]:g}")

rl, _ = aws("cloudwatch", "get-metric-statistics", "--namespace", "QuizForge", "--metric-name", "RedteamLeaks", "--dimensions", "Name=Service,Value=redteam", "--start-time", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(end - 5 * 86400)), "--end-time", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(end)), "--period", "86400", "--statistics", "Sum")
pts = sorted((rl or {}).get("Datapoints", []), key=lambda p: p["Timestamp"])
say("INFO", "RedteamLeaks per day (5 days): " + (", ".join(f"{p['Timestamp'][:10]}={p['Sum']:g}" for p in pts) or "no datapoints"))

print("\n== findings (things that look wrong or missing; this script does not fix infrastructure)")
if findings:
    for f in findings:
        print(f"  - {f}")
else:
    print("  none")
print(f"\n{'FAIL: ' + str(fails) + ' check(s) failed' if fails else 'no check failed'}")
sys.exit(1 if fails else 0)
PY
