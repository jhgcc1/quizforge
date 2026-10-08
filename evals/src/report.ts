import { COMPOSITE_GATES, COMPOSITE_WEIGHTS, type CompositeMetric } from "./composite.js";

export interface CellResult {
  /** repetition number (1-based): the same cell generated again, to measure run-to-run noise */
  rep?: number;
  variant: string;
  structure: string;
  prompt: string;
  item: string;
  ok: boolean;
  scores: Record<string, number>;
  composite: number;
  gated: boolean;
  failures: string[];
  strategy?: string;
  rounds?: number;
  repairs?: number;
  calls?: number;
  costUsd?: number;
  seconds: number;
  traceId?: string | null;
  trail: string[];
  questions: { prompt: string; options: string[]; correct: number[]; difficulty: string }[];
  error?: string;
}

export interface CompareReport {
  generatedAt: string;
  offline: boolean;
  models: { generator: string; judge: string; embeddings: string; judgeSamples: number };
  weights: Record<string, number>;
  items: { id: string; numQuestions: number; references: number; origin: string }[];
  variants: { id: string; structure: string; structureTitle: string; graph: string; prompt: string; promptTitle: string; langfuseRun: string | null }[];
  langfuse: { dataset: string; experiment: string; project: string | null } | null;
  cells: CellResult[];
}

export const LANGFUSE_PROJECT_URL = process.env.LANGFUSE_PROJECT_URL ?? "https://us.cloud.langfuse.com/project/cmuyh1njb00yxad0j2ixxfwnq";

const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const f2 = (x: number | undefined): string => (x === undefined || !Number.isFinite(x) ? "–" : x.toFixed(2));
const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "–");

export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : NaN;
}

const ranks = (xs: number[]): number[] => {
  const order = xs.map((v, i) => ({ v, i })).sort((x, y) => y.v - x.v);
  const r = new Array<number>(xs.length);
  order.forEach((o, k) => (r[o.i] = k + 1));
  return r;
};

/** Run-to-run noise (`okOnly`: leave out pairs where one repetition failed outright): standard deviation of the composite across repetitions of the same variant+document (pooled). NaN with a single repetition. */
export function repNoise(r: CompareReport, okOnly = false): number {
  const vars: number[] = [];
  for (const v of r.variants) {
    for (const it of r.items) {
      const cs = r.cells.filter((c) => c.variant === v.id && c.item === it.id);
      if (okOnly && cs.some((c) => !c.ok)) continue; // a generation that failed outright is a reliability finding, not scoring noise
      const xs = cs.map((c) => c.composite);
      if (xs.length >= 2) vars.push(sd(xs) ** 2);
    }
  }
  return vars.length ? Math.sqrt(mean(vars)) : NaN;
}

const COLORS = ["#2f5bea", "#e0902a", "#14a37f", "#c64fa0", "#7a5af5", "#d9534f", "#5b6b8c"];

/** Per-variant aggregates over the golden documents. */
export function aggregate(r: CompareReport) {
  return r.variants.map((v) => {
    const cs = r.cells.filter((c) => c.variant === v.id);
    const ok = cs.filter((c) => c.ok);
    const metric = (k: string) => mean(ok.map((c) => c.scores[k]).filter((x): x is number => x !== undefined));
    const perItem = [...new Set(cs.map((c) => c.item))].map((id) => mean(cs.filter((c) => c.item === id).map((c) => c.composite)));
    return {
      v,
      cells: cs,
      composite: mean(perItem), // each document counts once, however many repetitions it has
      compositeSd: sd(perItem),
      failed: cs.filter((c) => !c.ok).length,
      gated: cs.filter((c) => c.gated).length,
      cost: cs.reduce((a, c) => a + (c.costUsd ?? 0), 0),
      seconds: mean(cs.map((c) => c.seconds)),
      calls: mean(ok.map((c) => c.calls ?? 0)),
      metric,
    };
  });
}

function contributions(cs: CellResult[]): Record<CompositeMetric, number> {
  const out = Object.fromEntries(Object.keys(COMPOSITE_WEIGHTS).map((k) => [k, 0])) as Record<CompositeMetric, number>;
  for (const c of cs) {
    if (!c.ok || c.gated) continue;
    const used = (Object.keys(COMPOSITE_WEIGHTS) as CompositeMetric[]).filter((k) => c.scores[k] !== undefined);
    const total = used.reduce((a, k) => a + COMPOSITE_WEIGHTS[k], 0) || 1;
    for (const k of used) out[k] += (COMPOSITE_WEIGHTS[k] * Math.min(1, Math.max(0, c.scores[k]!))) / total;
  }
  for (const k of Object.keys(out) as CompositeMetric[]) out[k] /= cs.length || 1;
  return out;
}

function rankingChart(rows: ReturnType<typeof aggregate>): string {
  const sorted = [...rows].sort((a, b) => b.composite - a.composite);
  const keys = Object.keys(COMPOSITE_WEIGHTS) as CompositeMetric[];
  const left = 230, w = 980, rowH = 34, top = 28;
  const h = top + sorted.length * rowH + 70;
  const scale = (w - left - 70) / 1;
  let b = "";
  for (const t of [0, 0.25, 0.5, 0.75, 1]) b += `<line x1="${left + t * scale}" y1="${top - 8}" x2="${left + t * scale}" y2="${h - 44}" class="grid"/><text x="${left + t * scale}" y="${top - 12}" text-anchor="middle" class="note">${t.toFixed(2)}</text>`;
  sorted.forEach((r, i) => {
    const y = top + i * rowH;
    const contrib = contributions(r.cells);
    b += `<text x="${left - 10}" y="${y + 17}" text-anchor="end" class="lbl">${esc(r.v.id)}</text>`;
    let x = left;
    keys.forEach((k, j) => {
      const wdt = contrib[k] * scale;
      b += `<rect x="${x}" y="${y + 3}" width="${Math.max(0, wdt)}" height="22" fill="${COLORS[j % COLORS.length]}"><title>${k}: ${contrib[k].toFixed(3)}</title></rect>`;
      x += wdt;
    });
    b += `<text x="${x + 8}" y="${y + 19}" class="val">${f3(r.composite)}</text>`;
  });
  let lx = left;
  let ly = h - 30;
  keys.forEach((k, j) => {
    if (lx > w - 190) { lx = left; ly += 18; }
    b += `<rect x="${lx}" y="${ly}" width="11" height="11" rx="2" fill="${COLORS[j % COLORS.length]}"/><text x="${lx + 16}" y="${ly + 10}" class="note">${k} (${COMPOSITE_WEIGHTS[k]})</text>`;
    lx += 34 + (k.length + String(COMPOSITE_WEIGHTS[k]).length + 3) * 6.2;
  });
  return `<figure class="chart"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Composite score per variant, stacked by metric contribution">${b}</svg><figcaption>Nota composta por variante (média dos documentos). Cada cor é a contribuição ponderada de uma métrica; barras mais compridas = melhor.</figcaption></figure>`;
}

const heat = (x: number): string => `background:hsl(${Math.round(Math.min(1, Math.max(0, x)) * 120)} 55% var(--heatL))`;

function table(headers: string[], rows: string[][], cls = ""): string {
  return `<div class="tablewrap"><table class="${cls}"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => (c.startsWith("<td") ? c : `<td>${c}</td>`)).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export function renderReport(r: CompareReport): string {
  const rows = aggregate(r);
  const ranked = [...rows].sort((a, b) => b.composite - a.composite);
  const best = ranked[0]!;
  const second = ranked[1];
  const itemIds = r.items.map((i) => i.id);

  // paired difference best vs second across documents: is the lead distinguishable from noise?
  let verdict = "";
  if (second) {
    const itemMean = (x: typeof best, id: string) => mean(x.cells.filter((c) => c.item === id).map((c) => c.composite));
    const diffs = itemIds.map((id) => itemMean(best, id) - itemMean(second, id));
    const margin = mean(diffs);
    const se = sd(diffs) / Math.sqrt(diffs.length || 1);
    const noise = repNoise(r, true);
    const reps = Math.max(...r.cells.map((c) => c.rep ?? 1));
    const noiseTxt = Number.isFinite(noise) ? ` O ruído medido entre repetições de gerações bem-sucedidas (mesma variante, mesmo documento) é de ±${f3(noise)}.` : " Só há 1 repetição, então o ruído de execução não foi medido.";
    const real = margin > 2 * se && diffs.length >= 3 && (!Number.isFinite(noise) || margin > noise);
    verdict = real
      ? `A vantagem sobre <strong>${esc(second.v.id)}</strong> (${f3(margin)}) é maior que 2× o erro-padrão entre documentos (${f3(se)}) e maior que o ruído entre repetições: provavelmente real.${noiseTxt} Com ${diffs.length} documentos e ${reps} repetição(ões), é uma indicação forte, não uma prova.`
      : `A vantagem sobre <strong>${esc(second.v.id)}</strong> (${f3(margin)}) <strong>não se distingue do ruído</strong> (erro-padrão entre documentos ${f3(se)}).${noiseTxt} Trate os dois como empate técnico.`;
  }

  const byGroup = (key: "structure" | "prompt") => {
    const groups = [...new Set(r.variants.map((v) => v[key]))];
    return groups.map((g) => {
      const rs = rows.filter((x) => x.v[key] === g);
      return { g, title: key === "structure" ? rs[0]!.v.structureTitle : rs[0]!.v.promptTitle, composite: mean(rs.map((x) => x.composite)), judge: mean(rs.map((x) => x.metric("judge_overall"))), cost: mean(rs.map((x) => x.cost)), seconds: mean(rs.map((x) => x.seconds)), failed: rs.reduce((a, x) => a + x.failed, 0) };
    });
  };
  const effectRows = (key: "structure" | "prompt") =>
    byGroup(key).sort((a, b) => b.composite - a.composite).map((x) => [esc(x.title), `<strong>${f3(x.composite)}</strong>`, f3(x.judge), `$${x.cost.toFixed(4)}`, `${x.seconds.toFixed(0)}s`, String(x.failed)]);

  const metricMean = (cs: CellResult[], k: string) => mean(cs.filter((c) => c.ok).map((c) => c.scores[k]).filter((x): x is number => x !== undefined));
  const effectTable = (key: "structure" | "prompt", baseId: string) => {
    const groups = [...new Set(r.variants.map((v) => v[key]))];
    const cellsOf = (g: string) => r.cells.filter((c) => c[key] === g);
    const base = cellsOf(baseId);
    const d = (g: string, k: string) => { const x = metricMean(cellsOf(g), k) - metricMean(base, k); return Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(3)}` : "–"; };
    const comp = (cs: CellResult[]) => mean(cs.map((c) => c.composite));
    return table(["vs. " + esc(baseId) + " (produção)", "Δ composta", "Δ juiz", "Δ ref_recall", "Δ diversidade (emb.)", "Δ relevância (emb.)", "Δ cobertura", "falhas"], groups.filter((g) => g !== baseId).map((g) => [`<code>${esc(g)}</code>`, `${comp(cellsOf(g)) - comp(base) >= 0 ? "+" : ""}${(comp(cellsOf(g)) - comp(base)).toFixed(3)}`, d(g, "judge_overall"), d(g, "ref_recall"), d(g, "emb_diversity"), d(g, "emb_relevance"), d(g, "coverage"), `${cellsOf(g).filter((c) => !c.ok).length}/${cellsOf(g).length}`]));
  };

  const ok = r.cells.filter((c) => c.ok);
  const pairs = ok.filter((c) => c.scores.judge_overall !== undefined && c.scores.ref_recall !== undefined);
  const corr = pearson(pairs.map((c) => c.scores.judge_overall!), pairs.map((c) => c.scores.ref_recall!));
  const compRank = ranks(rows.map((x) => x.composite));
  const judgeRank = ranks(rows.map((x) => x.metric("judge_overall")));
  const refRank = ranks(rows.map((x) => x.metric("ref_recall")));
  const spearman = (a: number[], b: number[]) => 1 - (6 * a.reduce((s, v, i) => s + (v - b[i]!) ** 2, 0)) / (a.length * (a.length ** 2 - 1));
  const ctrl = mean(ok.map((c) => c.scores.ref_control).filter((x): x is number => x !== undefined));
  const prec = mean(ok.map((c) => c.scores.ref_precision).filter((x): x is number => x !== undefined));

  const lfBase = r.langfuse ? LANGFUSE_PROJECT_URL : null;
  const metricCols: [string, string][] = [["judge_overall", "juiz LLM"], ["ref_recall", "ref. recall"], ["ref_precision", "ref. precision"], ["emb_relevance", "relevância (emb.)"], ["emb_diversity", "diversidade (emb.)"], ["lint_pass", "lint"], ["coverage", "cobertura"], ["question_diversity", "diversidade (TF-IDF)"], ["relevance", "relevância (TF-IDF)"]];

  const css = `
:root{--bg:#f6f7f9;--panel:#fff;--ink:#1c2230;--mute:#5d6678;--line:#dde1ea;--acc:#2f5bea;--ok:#177a4a;--warn:#a15c00;--heatL:78%}
@media (prefers-color-scheme:dark){:root{--bg:#10141c;--panel:#171c27;--ink:#e6e9f0;--mute:#9aa4b8;--line:#2a3243;--acc:#7da2ff;--ok:#56d49a;--warn:#f0b35a;--heatL:30%}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header,main{max-width:1240px;margin:0 auto;padding:0 24px}header{padding-top:28px}h1{margin:0 0 4px;font-size:27px}header p{margin:0;color:var(--mute)}
section{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px 26px;margin:22px 0}h2{margin:0 0 8px;font-size:21px}h3{margin:22px 0 8px;font-size:16px}
a{color:var(--acc)}code{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:1px 5px;font-size:12.5px}
.tablewrap{overflow-x:auto;margin:8px 0}table{border-collapse:collapse;width:100%;font-size:13.5px}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}th{background:var(--bg)}
td.n{text-align:right;font-variant-numeric:tabular-nums}.callout{border-left:4px solid var(--acc);background:var(--bg);border-radius:8px;padding:10px 14px;margin:14px 0}.callout.warn{border-color:var(--warn)}.callout.ok{border-color:var(--ok)}
figure{margin:14px 0}.chart svg{width:100%;height:auto;min-width:760px}.chart{overflow-x:auto}figcaption{color:var(--mute);font-size:12.5px;text-align:center}
svg text{fill:var(--ink);font:12px system-ui,sans-serif}svg .note{fill:var(--mute);font-size:11px}svg .lbl{font-size:12.5px}svg .val{font-weight:600}svg .grid{stroke:var(--line)}
details{margin:6px 0;border:1px solid var(--line);border-radius:8px;padding:6px 12px}summary{cursor:pointer;font-weight:600}ol{margin:6px 0 6px 18px;padding:0}li{margin:4px 0}.opt{color:var(--mute);font-size:12.5px}.right{color:var(--ok);font-weight:600}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:0 8px;font-size:12px;color:var(--mute)}`;

  const heatTable = table(
    ["variante", ...itemIds.map(esc), "média"],
    rows.map((x) => [
      `<code>${esc(x.v.id)}</code>`,
      ...itemIds.map((id) => {
        const c = x.cells.find((y) => y.item === id);
        return `<td style="${heat(c?.composite ?? 0)}" class="n">${c ? (c.ok ? f2(c.composite) : "falhou") : "–"}</td>`;
      }),
      `<strong>${f3(x.composite)}</strong>`,
    ]),
  );

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QuizForge Structure Comparison</title><style>${css}</style></head><body>
<header><h1>Comparação de estruturas e prompts do gerador de quiz</h1>
<p>${rows.length} variantes (${new Set(r.variants.map((v) => v.structure)).size} estruturas LangGraph × ${new Set(r.variants.map((v) => v.prompt)).size} prompts) · ${r.items.length} documentos · gerado em ${esc(r.generatedAt.slice(0, 16).replace("T", " "))} UTC${r.offline ? " · <strong>OFFLINE (LLM falso, só valida o harness)</strong>" : ""}</p></header>
<main>
<section><h2>Resultado</h2>
<div class="callout ${r.offline ? "warn" : "ok"}"><strong>Melhor média: <code>${esc(best.v.id)}</code> com nota composta ${f3(best.composite)}</strong> (${esc(best.v.structureTitle)} + prompt “${esc(best.v.promptTitle)}”).<br>${verdict}</div>
${rankingChart(rows)}
${table(["#", "variante", "estrutura (grafo)", "prompt", "composta", "± entre docs", "juiz", "falhas", "custo", "tempo/doc", "chamadas LLM"],
    ranked.map((x, i) => [String(i + 1), `<code>${esc(x.v.id)}</code>`, `${esc(x.v.structureTitle)}<br><span class="opt">${esc(x.v.graph)}</span>`, esc(x.v.promptTitle), `<strong>${f3(x.composite)}</strong>`, f3(x.compositeSd), f3(x.metric("judge_overall")), `${x.failed}/${x.cells.length}${x.gated ? ` (+${x.gated} reprovado em portão)` : ""}`, `$${x.cost.toFixed(4)}`, `${x.seconds.toFixed(0)}s`, f2(x.calls)]))}
</section>

<section><h2>Como a nota é calculada</h2>
<p>Cada quiz gerado recebe uma <strong>média ponderada</strong> de sinais de três tipos diferentes, para que nenhum instrumento ruidoso decida sozinho. Os <strong>portões</strong> (${COMPOSITE_GATES.map((g) => `<code>${g}</code>`).join(", ")}) zeram a nota: um quiz com citação inventada, que obedeceu à injeção de prompt ou no idioma errado é inutilizável, não “meio bom”.</p>
${table(["métrica", "peso", "tipo", "o que mede"], [
    ["<code>judge_overall</code>", String(COMPOSITE_WEIGHTS.judge_overall), "LLM-as-judge", `${esc(r.models.judge)}, mediana de ${r.models.judgeSamples || "n"} julgamentos, modelo diferente do gerador (${esc(r.models.generator)}): fidelidade, clareza, distratores, cobertura, dificuldade`],
    ["<code>ref_recall</code>", String(COMPOSITE_WEIGHTS.ref_recall), "embeddings (cosseno)", "para cada pergunta de referência (escrita à mão), a pergunta gerada mais parecida: o quiz pergunta sobre o que se espera?"],
    ["<code>ref_precision</code>", String(COMPOSITE_WEIGHTS.ref_precision), "embeddings (cosseno)", "para cada pergunta gerada, a referência mais parecida (peso baixo: uma pergunta válida pode estar fora de um conjunto de referência curto)"],
    ["<code>emb_relevance</code>", String(COMPOSITE_WEIGHTS.emb_relevance), "embeddings (cosseno)", "cada pergunta vs. o trecho mais parecido do documento: o quiz fica no assunto?"],
    ["<code>emb_diversity</code>", String(COMPOSITE_WEIGHTS.emb_diversity), "embeddings (cosseno)", "1 − maior cosseno entre duas perguntas: pega duplicatas parafraseadas que o TF-IDF não vê"],
    ["<code>lint_pass</code>", String(COMPOSITE_WEIGHTS.lint_pass), "determinística", "sem “todas as anteriores”, sem opção que se entrega pelo tamanho, sem duplicatas"],
    ["<code>coverage</code>", String(COMPOSITE_WEIGHTS.coverage), "determinística", "as perguntas vêm de seções diferentes (só em documentos com ≥3 seções; senão o peso é redistribuído)"],
  ])}
<p>Embeddings: <code>${esc(r.models.embeddings)}</code> — modelo local, multilíngue, gratuito (sem API). A chave do MiniMax não tem endpoint de embeddings. Limite do modelo: lê só os primeiros 128 tokens de cada texto.</p>
</section>

<section><h2>O que foi comparado</h2>
<h3>Estruturas (topologias do LangGraph)</h3>
${table(["id", "nome", "grafo"], [...new Map(r.variants.map((v) => [v.structure, v])).values()].map((v) => [`<code>${esc(v.structure)}</code>`, esc(v.structureTitle), `<code>${esc(v.graph)}</code>`]))}
<h3>Prompts do gerador</h3>
${table(["id", "descrição"], [...new Map(r.variants.map((v) => [v.prompt, v])).values()].map((v) => [`<code>${esc(v.prompt)}</code>`, esc(v.promptTitle)]))}
<h3>Documentos (contexto) e perguntas de referência</h3>
${table(["documento", "perguntas gerar", "perguntas de referência", "origem"], r.items.map((i) => [`<code>${esc(i.id)}</code>`, String(i.numQuestions), String(i.references), esc(i.origin)]))}
<p>As perguntas de referência estão em <code>evals/references/&lt;documento&gt;.json</code>, cada uma com a citação literal do documento (um teste prova que a citação existe). <strong>Foram escritas pela IA como rascunho</strong>; vale uma revisão humana.</p>
</section>

<section><h2>Média por estrutura e por prompt</h2>
<h3>Por estrutura (média dos 3 prompts)</h3>
${table(["estrutura", "composta", "juiz", "custo", "tempo/doc", "falhas"], effectRows("structure"))}
<h3>Por prompt (média das 3 estruturas)</h3>
${table(["prompt", "composta", "juiz", "custo", "tempo/doc", "falhas"], effectRows("prompt"))}
<h3>Onde está a diferença? (efeito de cada escolha, métrica a métrica)</h3>
<p>Diferenças em relação à configuração de produção, separando o que o <strong>juiz LLM</strong> vê do que os <strong>embeddings</strong> veem. Quando só o juiz se mexe, o ganho pode ser a preferência do próprio juiz e não um quiz melhor.</p>
${effectTable("structure", "critique-loop")}
${effectTable("prompt", "baseline")}
</section>

<section><h2>Nota composta por documento</h2>${heatTable}</section>

<section><h2>Métricas por variante</h2>
${table(["variante", ...metricCols.map(([, l]) => l)], rows.map((x) => [`<code>${esc(x.v.id)}</code>`, ...metricCols.map(([k]) => f2(x.metric(k)))]))}
</section>

<section><h2>Os instrumentos concordam? (checagens de sanidade)</h2>
${table(["checagem", "resultado", "como ler"], [
    ["controle negativo: <code>ref_control</code> vs <code>ref_precision</code>", `${f2(ctrl)} vs ${f2(prec)}`, "ref_control = similaridade com as referências de OUTROS documentos. Precisa ser bem menor que ref_precision; senão a métrica não discrimina."],
    ["ruído entre repetições, gerações bem-sucedidas (desvio da composta, mesma variante e documento)", f3(repNoise(r, true)), "mede quanto a nota oscila só por gerar e julgar de novo. Diferenças entre variantes menores que isso não significam nada."],
    ["ruído entre repetições, incluindo falhas", f3(repNoise(r)), "maior que o anterior quando uma geração falha numa repetição e passa na outra: é um problema de confiabilidade, não de pontuação."],
    ["correlação juiz LLM × ref_recall (por quiz)", f2(corr), "positiva = juiz e embeddings concordam sobre o que é um bom quiz; perto de 0 = medem coisas diferentes (por isso a média ponderada, não um só)."],
    ["ranking por variante: composta × juiz (Spearman)", f2(spearman(compRank, judgeRank)), "1 = mesma ordem."],
    ["ranking por variante: composta × ref_recall (Spearman)", f2(spearman(compRank, refRank)), "1 = mesma ordem."],
  ])}
</section>

<section><h2>Onde encontrar</h2>
<ul>
<li><strong>Este relatório:</strong> <code>docs/eval/structure-comparison.html</code> (números brutos em <code>structure-comparison.json</code>) no repositório.</li>
${lfBase ? `<li><strong>Langfuse — dataset:</strong> <a href="${lfBase}/datasets" target="_blank" rel="noopener">${esc(r.langfuse!.dataset)}</a> → aba <em>Runs</em>: selecione várias runs e use <em>Compare</em>. Cada variante é uma run chamada <code>&lt;estrutura&gt;/&lt;prompt&gt;@&lt;data&gt;</code>; cada item tem o trace completo, os scores de cada métrica e <code>composite</code>.</li><li><strong>Langfuse — traces:</strong> <a href="${lfBase}/traces" target="_blank" rel="noopener">traces</a>, filtre pela tag <code>compare</code>.</li>` : "<li>Esta execução não registrou experimentos no Langfuse.</li>"}
<li><strong>Reexecutar:</strong> <code>pnpm --filter @quizforge/evals compare</code> (opções: <code>--variants=plan-then-write</code>, <code>--only=short-doc</code>, <code>--samples=3</code>, <code>--no-langfuse</code>, <code>--offline</code>).</li>
</ul></section>

<section><h2>Limitações (leia antes de decidir)</h2>
<ul>
<li><strong>${Math.max(...r.cells.map((c) => c.rep ?? 1))} execução(ões) por célula</strong> (${r.cells.length} gerações no total). Geração e juiz de LLM variam entre execuções; a nota por documento oscila. Para decidir de verdade, repita e compare médias.</li>
<li><strong>${r.items.length} documentos</strong> é pouco: diferenças pequenas entre variantes são ruído (veja a conclusão acima).</li>
<li>Os <strong>pesos</strong> são uma decisão de engenharia, não uma verdade: ranking pode mudar com outros pesos. Por isso a decomposição por métrica está no gráfico e na tabela.</li>
<li>Referências escritas pela IA e embedding pequeno (128 tokens): cosseno entre perguntas é um sinal grosseiro de “pergunta sobre o mesmo assunto”, não de qualidade.</li>
<li>O juiz é outro modelo da MiniMax, ainda do mesmo fornecedor: pode compartilhar vieses com o gerador.</li>
<li>Custos são estimados por tokens (preço cadastrado no Langfuse), não pela fatura.</li>
</ul></section>

<section><h2>Perguntas geradas (para revisar a olho)</h2>
${r.variants.map((v) => `<details><summary>${esc(v.id)} <span class="pill">${f3(aggregate({ ...r, variants: [v] })[0]!.composite)}</span></summary>${r.cells.filter((c) => c.variant === v.id).map((c) => `<h3>${esc(c.item)}${(c.rep ?? 1) > 1 || r.cells.some((x) => (x.rep ?? 1) > 1) ? ` #${c.rep ?? 1}` : ""} <span class="pill">composta ${f2(c.composite)}</span> <span class="pill">${esc((c.trail ?? []).join(" → "))}</span></h3>${c.ok ? `<ol>${c.questions.map((q) => `<li>${esc(q.prompt)} <span class="pill">${esc(q.difficulty)}</span><div class="opt">${q.options.map((o, i) => (q.correct.includes(i) ? `<span class="right">✔ ${esc(o)}</span>` : esc(o))).join(" · ")}</div></li>`).join("")}</ol>` : `<p class="callout warn">Falhou: ${esc(c.error ?? "")}</p>`}`).join("")}</details>`).join("")}
</section>
</main></body></html>`;
}
