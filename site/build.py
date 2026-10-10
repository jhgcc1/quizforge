"""Builds site/quizforge-architecture.html: one standalone file (CSS inline, screenshots embedded as base64)."""
import base64
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import content  # noqa: E402

HERE = Path(__file__).parent

CSS = """
:root{--bg:#f6f7f9;--panel:#fff;--ink:#1c2230;--mute:#5d6678;--line:#dde1ea;--acc:#2f5bea;--ok:#177a4a;--warn:#a15c00;--info:#2f5bea;
--compute:#dbe8ff;--ai:#efe0ff;--data:#d9f2e3;--sec:#ffe2e0;--edge:#fff0cc;--ext:#eceff4;--mgd:#e3eefc;--ci:#e0f3f5;--stroke:#6b7690;--bar0:#2f5bea;--bar1:#e0902a;--bar2:#14a37f;--bar3:#c64fa0}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#10141c;--panel:#171c27;--ink:#e6e9f0;--mute:#9aa4b8;--line:#2a3243;--acc:#7da2ff;--ok:#56d49a;--warn:#f0b35a;--info:#7da2ff;
--compute:#1f3358;--ai:#3a2a58;--data:#1c4030;--sec:#58292a;--edge:#53441a;--ext:#262d3b;--mgd:#1e3250;--ci:#17434a;--stroke:#8892a8}}
:root[data-theme=dark]{--bg:#10141c;--panel:#171c27;--ink:#e6e9f0;--mute:#9aa4b8;--line:#2a3243;--acc:#7da2ff;--ok:#56d49a;--warn:#f0b35a;--info:#7da2ff;
--compute:#1f3358;--ai:#3a2a58;--data:#1c4030;--sec:#58292a;--edge:#53441a;--ext:#262d3b;--mgd:#1e3250;--ci:#17434a;--stroke:#8892a8}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{padding:28px 24px 8px;max-width:1240px;margin:0 auto}
h1{margin:0 0 4px;font-size:28px}header p{margin:0;color:var(--mute)}
nav{position:sticky;top:0;z-index:5;background:var(--panel);border-bottom:1px solid var(--line);padding:8px 16px;overflow-x:auto;white-space:nowrap}
nav a{color:var(--mute);text-decoration:none;padding:5px 10px;border-radius:6px;font-size:13px;display:inline-block}
nav a:hover{background:var(--bg);color:var(--ink)}
nav button{float:right;border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:6px;padding:4px 10px;cursor:pointer}
main{max-width:1240px;margin:0 auto;padding:0 24px 64px}
section{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px 26px;margin:22px 0;scroll-margin-top:56px}
h2{margin:0 0 6px;font-size:22px}h3{margin:26px 0 8px;font-size:16px}.lead{color:var(--mute);margin:0 0 14px}
a{color:var(--acc)}code{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:1px 5px;font-size:12.5px;word-break:break-word}
.tablewrap{overflow-x:auto;margin:8px 0 6px}table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}th{background:var(--bg);font-weight:600}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:10px 0 16px}
.card{border:1px solid var(--line);border-radius:12px;padding:14px;background:var(--bg)}.num{font-size:26px;font-weight:700;color:var(--acc)}
.callout{border-left:4px solid var(--info);background:var(--bg);border-radius:8px;padding:10px 14px;margin:14px 0}
.callout.ok{border-color:var(--ok)}.callout.warn{border-color:var(--warn)}.callout strong{display:block;margin-bottom:2px}
figure{margin:16px 0}.diagram{border:1px solid var(--line);border-radius:12px;padding:10px;background:var(--bg);overflow-x:auto}
.diagram svg{width:100%;height:auto;min-width:640px;display:block}figcaption{color:var(--mute);font-size:12.5px;margin-top:6px;text-align:center}
svg text{fill:var(--ink);font:12px system-ui,sans-serif}svg .t{font-weight:600;font-size:13px}svg .t-s{font-weight:600;font-size:12px}
svg .sub,svg .note{fill:var(--mute);font-size:11px}svg .alabel{font-size:11px;fill:var(--ink)}svg .glabel{font-size:11.5px;font-weight:600;fill:var(--mute)}
svg .box{stroke:var(--stroke);stroke-width:1}
.compute{fill:var(--compute)}.ai{fill:var(--ai)}.data{fill:var(--data)}.sec{fill:var(--sec)}.edge{fill:var(--edge)}.ext{fill:var(--ext)}.mgd{fill:var(--mgd)}.ci{fill:var(--ci)}
svg .grp{fill:none;stroke:var(--stroke);stroke-width:1;stroke-dasharray:5 4;opacity:.8}
svg .arrow{stroke:var(--stroke);stroke-width:1.5;fill:none}svg .arrow.dash{stroke-dasharray:5 4}svg .arrowhead{fill:var(--stroke)}
svg .grid,svg .life{stroke:var(--line);stroke-width:1}svg .life{stroke-dasharray:3 4}
svg .bar{fill:var(--bar0)}svg .bar.s1{fill:var(--bar1)}svg .bar.s2{fill:var(--bar2)}svg .bar.s3{fill:var(--bar3)}
.code{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow-x:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre}
svg .badge-c{fill:var(--acc)}svg .badge-t{fill:#fff;font-weight:700;font-size:11px}
.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(520px,1fr));gap:16px}.shot{margin:0}
.shot img{width:100%;border:1px solid var(--line);border-radius:10px;display:block}
ul{padding-left:20px}footer{max-width:1240px;margin:0 auto;padding:0 24px 40px;color:var(--mute);font-size:12.5px}
@media (max-width:640px){header,main,footer{padding-left:16px;padding-right:16px}section{padding:16px}}
"""

JS = "document.getElementById('theme').onclick=function(){var r=document.documentElement;var dark=r.dataset.theme?r.dataset.theme==='dark':matchMedia('(prefers-color-scheme:dark)').matches;r.dataset.theme=dark?'light':'dark'}"


def inline_images(html: str) -> str:
    def repl(m):
        p = HERE / "img" / m.group(1)
        return f'src="data:image/png;base64,{base64.b64encode(p.read_bytes()).decode()}"'
    return re.sub(r'src="img/([^"]+)"', repl, html)


PUBLIC = "--public" in sys.argv


def secret_values() -> list[str]:
    """Values of passwords, keys and tokens in the git-ignored env files: none of them may ever appear in a report."""
    out = []
    for f in [HERE.parent / ".env", HERE.parent / ".local" / "e2e-user.env"]:
        if f.exists():
            for line in f.read_text().splitlines():
                k, _, v = line.partition("=")
                v = v.strip().strip('"')
                if len(v) >= 8 and re.search(r"KEY|SECRET|PASSWORD|TOKEN", k, re.I):
                    out.append(v)
    return out


def redact(html: str) -> str:
    """The committed copy (the repository is public): the same page, with the AWS account id removed.
    The build FAILS if a password, key or token from the local env files is found in the page."""
    html = re.sub(r"\b\d{12}\b", "&lt;account-id&gt;", html)
    html = html.replace("Generated from the real repository and AWS account. Contains account-specific IDs: do not publish.", "Public copy: the AWS account id is removed. The full page is generated locally with <code>site/build.py</code>.")
    return html


def assert_no_secrets(html: str) -> None:
    leaked = [v[:4] + "…" for v in secret_values() if v in html]
    if leaked:
        raise SystemExit(f"refusing to write the page: it contains secret values from the local env files ({leaked})")


def main():
    nav = "".join(f'<a href="#{i}">{t}</a>' for i, t in content.NAV)
    body = "".join(content.all_sections())
    html = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        "<title>QuizForge Architecture</title>"
        f"<style>{CSS}</style></head><body>"
        "<header><h1>QuizForge: architecture and decisions</h1>"
        "<p>An AI agent that turns a README into a quiz · AWS (Fargate, RDS, SQS, Cognito, CloudFront) · Terraform · GitHub Actions · Langfuse</p></header>"
        f'<nav><button id="theme" aria-label="Toggle theme">◐ theme</button>{nav}</nav><main>{body}</main>'
        "<footer>Generated from the real repository and AWS account. Contains account-specific IDs: do not publish.</footer>"
        f"<script>{JS}</script></body></html>"
    )
    html = inline_images(html)
    assert_no_secrets(html)
    if PUBLIC:
        html = redact(html)
        out = HERE.parent / "docs" / "architecture" / "quizforge-architecture.html"
        out.parent.mkdir(parents=True, exist_ok=True)
    else:
        out = HERE / "quizforge-architecture.html"
    out.write_text(html, encoding="utf-8")
    print(f"{out} {out.stat().st_size / 1e6:.2f} MB, {html.count('<svg')} diagrams, {html.count('<table')} tables, {html.count('data:image/png')} images")


main()
