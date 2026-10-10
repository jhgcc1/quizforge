"""Real data from the Langfuse API for the architecture page: the step tree of one generation, with model, tokens, cost and time.
The Langfuse web UI needs a login, so this is NOT a screenshot: it is built from GET /api/public/v2/observations."""
import base64
import json
import os
import urllib.request
from pathlib import Path

from lib import esc, table

ROOT = Path(__file__).parent.parent


def _env():
    env = dict(os.environ)
    p = ROOT / ".env"
    if p.exists():
        for line in p.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip().strip('"'))
    return env


def pick_trace():
    d = json.loads((ROOT / "docs/eval/structure-comparison.json").read_text())
    cs = [c for c in d["cells"] if c["ok"] and c.get("traceId") and c["structure"] == "critique-loop" and any("revise" in t for t in c["trail"])]
    return cs[0] if cs else None


def observations(trace_id):
    env = _env()
    if not (env.get("LANGFUSE_PUBLIC_KEY") and env.get("LANGFUSE_SECRET_KEY") and env.get("LANGFUSE_BASE_URL")):
        return None
    auth = base64.b64encode(f"{env['LANGFUSE_PUBLIC_KEY']}:{env['LANGFUSE_SECRET_KEY']}".encode()).decode()
    url = f"{env['LANGFUSE_BASE_URL']}/api/public/v2/observations?traceId={trace_id}&limit=100&fields=core,basic,model,usage,time"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": f"Basic {auth}"}), timeout=30) as r:
            return json.load(r)["data"]
    except Exception:
        return None


def trace_panel(project_url):
    cell = pick_trace()
    if not cell:
        return ""
    obs = observations(cell["traceId"])
    if not obs:
        return ""
    by_id = {o["id"]: o for o in obs}
    noise = {"RunnableLambda", "RunnableSequence"}  # LangChain plumbing: not interesting to read

    def depth(o):
        n, p = 0, o.get("parentObservationId")
        while p and p in by_id:
            if by_id[p]["name"] not in noise:
                n += 1
            p = by_id[p].get("parentObservationId")
        return n

    rows = []
    for o in sorted((x for x in obs if x["name"] not in noise), key=lambda x: x["startTime"]):
        gen = o["type"] == "GENERATION"
        pad = "&nbsp;" * 4 * depth(o)
        rows.append([
            f"{pad}{'🤖 ' if gen else ''}<code>{esc(o['name'])}</code>",
            "LLM call" if gen else "step",
            esc(o.get("model") or ""),
            f"{o.get('latency') or 0:.1f}s",
            f"{int(o.get('totalUsage') or 0):,}" if gen else "",
            f"${o['totalCost']:.4f}" if gen and o.get("totalCost") else "",
        ])
    total_cost = sum(o.get("totalCost") or 0 for o in obs if o["type"] == "GENERATION")
    calls = sum(1 for o in obs if o["type"] == "GENERATION")
    wanted = ["quality_overall", "judge_overall", "judge_faithfulness", "judge_clarity", "judge_distractors", "lint_pass", "grounded", "question_diversity", "relevance", "coverage", "language_match", "difficulty_spread"]
    sc = cell["scores"]
    score_rows = [[f"<code>{k}</code>", f"{sc[k]:.2f}"] for k in wanted if k in sc]
    url = f"{project_url}/traces/{cell['traceId']}"
    head = (f'<p>One real generation: <code>{esc(cell["variant"])}</code> on <code>{esc(cell["item"])}</code>. '
            f'<a href="{esc(url)}" target="_blank" rel="noopener">Open this trace in Langfuse</a>. {calls} LLM calls, ${total_cost:.4f} in total. '
            f'This table is built from the Langfuse API: the trace page shows the same tree.</p>')
    return head + table(["Step (graph node)", "Kind", "Model", "Time", "Tokens", "Cost"], rows, widths=["34%", "10%", "18%", "10%", "14%", "14%"]) + "<h3>Scores on that trace</h3>" + table(["Score name", "Value (0 to 1)"], score_rows, widths=["50%", "50%"])
