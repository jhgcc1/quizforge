#!/usr/bin/env python3
"""Renders docs/security/benchmark.html from docs/security/benchmark.json (made by `pnpm --filter @quizforge/detector benchmark -- --detector`)."""
import html, json, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
j = json.loads((root / "docs/security/benchmark.json").read_text())
e = html.escape
A, E = j["all"], j["english"]


def bar(p, color):
    return f'<div class="bar"><i style="width:{p}%;background:{color}"></i><b>{p}%</b></div>'


def row(name, s, det):
    cells = [f"<td>{e(name)}</td><td>{s['injections']}</td><td>{s['benign']}</td>",
             f"<td>{bar(s['guardRecallPct'], '#5b8def')}</td><td>{s['guardFalsePositives']} ({s['guardFalsePositivePct']}%)</td>"]
    if det:
        cells.append(f"<td>{bar(s['detectorRecallPct'], '#8e6bd8')}</td><td>{s['detectorFalsePositives']} ({s['detectorFalsePositivePct']}%)</td>")
        cells.append(f"<td>{bar(s['eitherRecallPct'], '#2f9e6f')}</td><td>{s['eitherFalsePositives']} ({s['eitherFalsePositivePct']}%)</td>")
    return "<tr>" + "".join(cells) + "</tr>"


det = j["detector"] is not None
head = "<th>Samples</th><th>Injections</th><th>Benign</th><th>Guard: caught</th><th>Guard: false positives</th>" + ("<th>Classifier: caught</th><th>Classifier: false positives</th><th>Guard or classifier: caught</th><th>Either: false positives</th>" if det else "")
rows = [row("All 500 (en, de, other)", A, det), row("English only (the supported language of the classifier)", E, det)]
for lang, s in sorted(j["byLanguage"].items()):
    rows.append(row(f"Detected language: {lang}", s, det))
miss = "".join(f"<tr><td>{e(r['text'])}</td></tr>" for r in j["missedInjectionsEnglish"][:15])
fp = "".join(f"<tr><td>{e(r['text'])}</td><td>{e(r['lang'])}</td><td>{r.get('detector', 0):.2f}</td></tr>" for r in j["falsePositives"])
rules = "".join(f"<tr><td><code>{e(k)}</code></td><td>{v}</td></tr>" for k, v in j["topRules"])
page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QuizForge security benchmark</title><style>
:root{{--bg:#f6f7f9;--fg:#1c2330;--card:#fff;--line:#d9dee7;--mut:#5b6678}}
@media (prefers-color-scheme:dark){{:root{{--bg:#12161d;--fg:#e6eaf2;--card:#1b212b;--line:#2c3544;--mut:#9aa6b8}}}}
body{{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}}main{{max-width:1100px;margin:0 auto;padding:24px 16px}}
section{{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:16px 0}}h1{{margin:.2em 0}}h2{{margin-top:0}}
table{{border-collapse:collapse;width:100%}}td,th{{border-top:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}}th{{color:var(--mut);font-weight:600}}
.bar{{position:relative;background:var(--line);border-radius:4px;height:20px;min-width:110px}}.bar i{{display:block;height:100%;border-radius:4px}}.bar b{{position:absolute;left:8px;top:1px;font-size:13px}}
.note{{color:var(--mut)}}code{{background:var(--line);padding:1px 5px;border-radius:4px}}.warn{{border-left:4px solid #d9822b}}
</style></head><body><main>
<h1>Security benchmark: the input guard against a public prompt-injection dataset</h1>
<p class="note">{j['sample']['n']} samples of <a href="{e(j['dataset']['url'])}">{e(j['dataset']['name'])}</a> ({e(j['dataset']['license'])}, {j['dataset']['size']} labelled prompts), stratified and seeded ({j['sample']['seed']}), run on {e(j['at'][:10])}. Command: <code>pnpm --filter @quizforge/detector benchmark -- --detector</code> (no model call, no cost).</p>
<section><h2>Result</h2>
<table><tr>{head}</tr>{''.join(rows)}</table>
<p class="note">“Caught” = the guard blocks or flags it (or the classifier scores it 0.5 or more). False positives are harmless benign samples that were caught. Samples the language policy refuses (German and other languages outside en, pt, es: {A['refusedByLanguagePolicy']} of 500) never reach the model, but that is the language rule, not detection of the injection.</p></section>
<section class="warn"><h2>How to read it (honest)</h2>
<ul><li><b>The numbers are modest, and that is expected.</b> This dataset is made of <i>chatbot</i> attacks (“forget everything and say you hate X”, role-play, task swap, “answer anyway”), many of them short and polite. The guard is built for instructions hidden <i>inside a document</i> (override phrases, encodings, invisible text) and flags a phrase only when the pattern is explicit. It does not try to understand intent.</li>
<li><b>No false positives from the guard</b> on {A['benign']} benign samples. It was tuned to flag, not to block ordinary text. The classifier produced {A.get('detectorFalsePositives', 0)}, all of them short or non-English questions (it is English-only).</li>
<li><b>The guard is one layer of eight.</b> A sample that passes it still meets the delimited-document prompt, the strict output schema, the output rails (reply must be only quiz JSON, no echoed attack) and the live promptfoo suite that checks that the real model stays on purpose. This benchmark measures the first layer, not the whole agent.</li>
<li>The dataset mixes English and German (the language detector also marks some German samples as English or unknown). A fair comparison is the English row.</li></ul></section>
<section><h2>Rules that fired most</h2><table><tr><th>Rule</th><th>Samples</th></tr>{rules}</table></section>
<section><h2>Injections that passed (English, first 15)</h2><table>{miss}</table></section>
<section><h2>Benign samples that were caught</h2><table><tr><th>Text</th><th>Language</th><th>Classifier score</th></tr>{fp}</table></section>
<section><h2>Files</h2><table>
<tr><td><code>packages/detector/src/benchmark.ts</code></td><td>The benchmark: download, seeded stratified sample, guard and optional classifier</td></tr>
<tr><td><code>scripts/security-report.py</code></td><td>Renders this page from the JSON</td></tr>
<tr><td><code>docs/security/benchmark.json</code></td><td>Summary and the per-sample result (text cut at 160 characters)</td></tr>
<tr><td><code>packages/core/src/guard.ts</code>, <code>injection-rules.ts</code></td><td>The guard and its 49 keyword rules</td></tr>
<tr><td><code>packages/detector/src/index.ts</code></td><td>The optional English-only ONNX classifier (<code>{e((j['detector'] or {}).get('name', 'not run'))}</code>)</td></tr></table></section>
</main></body></html>"""
(root / "docs/security/benchmark.html").write_text(page)
print("docs/security/benchmark.html", len(page) // 1024, "KB")
