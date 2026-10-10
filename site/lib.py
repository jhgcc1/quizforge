"""Tiny SVG/HTML helpers so every diagram in the documentation looks the same (and stays editable as code)."""
import html
from itertools import count

_uid = count(1)
esc = html.escape


def svg(w, h, body, title=""):
    n = next(_uid)
    return (
        f'<figure class="diagram"><svg viewBox="0 0 {w} {h}" role="img" aria-label="{esc(title)}" xmlns="http://www.w3.org/2000/svg">'
        f'<defs><marker id="ah{n}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
        f'<path d="M0,0 L10,5 L0,10 z" class="arrowhead"/></marker></defs>{body.replace("{AH}", f"ah{n}")}</svg>'
        f'<figcaption>{esc(title)}</figcaption></figure>'
    )


def group(x, y, w, h, label, kind="grp"):
    return (
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" class="{kind}"/>'
        f'<text x="{x + 12}" y="{y + 20}" class="glabel">{esc(label)}</text>'
    )


def box(x, y, w, h, title, sub="", kind="compute", small=False):
    ty = y + h / 2 + (-4 if sub else 5)
    out = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="9" class="box {kind}"/>'
    out += f'<text x="{x + w / 2}" y="{ty}" text-anchor="middle" class="{"t-s" if small else "t"}">{esc(title)}</text>'
    if sub:
        out += f'<text x="{x + w / 2}" y="{ty + 15}" text-anchor="middle" class="sub">{esc(sub)}</text>'
    return out


def arrow(x1, y1, x2, y2, label="", dash=False, both=False, lx=None, ly=None, anchor="middle"):
    cls = "arrow dash" if dash else "arrow"
    start = ' marker-start="url(#{AH})"' if both else ""
    out = f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" class="{cls}" marker-end="url(#{{AH}})"{start}/>'
    if label:
        mx = lx if lx is not None else (x1 + x2) / 2
        my = ly if ly is not None else (y1 + y2) / 2 - 5
        out += f'<text x="{mx}" y="{my}" text-anchor="{anchor}" class="alabel">{esc(label)}</text>'
    return out


def path(d, label="", lx=0, ly=0, dash=False, anchor="middle"):
    cls = "arrow dash" if dash else "arrow"
    out = f'<path d="{d}" class="{cls}" fill="none" marker-end="url(#{{AH}})"/>'
    if label:
        out += f'<text x="{lx}" y="{ly}" text-anchor="{anchor}" class="alabel">{esc(label)}</text>'
    return out


def text(x, y, s, cls="note", anchor="start"):
    return f'<text x="{x}" y="{y}" text-anchor="{anchor}" class="{cls}">{esc(s)}</text>'


def table(headers, rows, cls="", widths=None):
    cols = ""
    if widths:
        cols = "<colgroup>" + "".join(f'<col style="width:{w}">' for w in widths) + "</colgroup>"
    th = "".join(f"<th>{h}</th>" for h in headers)
    trs = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f'<div class="tablewrap"><table class="{cls}">{cols}<thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table></div>'


def link(url, label=None, ext=True):
    return f'<a href="{esc(url)}" target="_blank" rel="noopener">{label or esc(url)}</a>'


def callout(kind, title, body):
    return f'<div class="callout {kind}"><strong>{title}</strong><div>{body}</div></div>'


def badge(s, kind="gray"):
    return f'<span class="badge {kind}">{s}</span>'


def bar_chart(w, h, series, title, ymax=1.0, labels=None, colors=None):
    """series: {name: [values]}; grouped bars, one group per index."""
    n = max(len(v) for v in series.values())
    left, bottom, top = 46, h - 38, 18
    plot_h = bottom - top
    gw = (w - left - 16) / n
    names = list(series)
    bw = gw / (len(names) + 1)
    out = ""
    fmt = "{:.2f}" if ymax <= 1 else "{:.1f}"
    for k in range(5):
        tick = ymax * k / 4
        y = bottom - tick / ymax * plot_h
        out += f'<line x1="{left}" y1="{y}" x2="{w - 10}" y2="{y}" class="grid"/><text x="{left - 6}" y="{y + 4}" text-anchor="end" class="note">{fmt.format(tick)}</text>'
    for gi in range(n):
        gx = left + gi * gw + bw / 2
        for si, name in enumerate(names):
            vals = series[name]
            if gi >= len(vals):
                continue
            v = vals[gi]
            bh = v / ymax * plot_h
            out += f'<rect x="{gx + si * bw}" y="{bottom - bh}" width="{bw * 0.86}" height="{bh}" rx="3" class="bar s{si}"/>'
            out += f'<text x="{gx + si * bw + bw * 0.43}" y="{bottom - bh - 4}" text-anchor="middle" class="note">{fmt.format(v)}</text>'
        if labels:
            out += f'<text x="{left + gi * gw + gw / 2}" y="{h - 20}" text-anchor="middle" class="note">{esc(labels[gi])}</text>'
    lx = left
    for si, name in enumerate(names):
        out += f'<rect x="{lx}" y="{h - 12}" width="10" height="10" rx="2" class="bar s{si}"/><text x="{lx + 14}" y="{h - 3}" class="note">{esc(name)}</text>'
        lx += 14 + 7.2 * len(name) + 18
    return svg(w, h, out, title)
