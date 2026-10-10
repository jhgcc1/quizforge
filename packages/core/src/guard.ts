/**
 * Input guard: pure functions (no I/O, no dependencies, browser-safe) that look at text BEFORE it can reach an LLM.
 *
 * Three kinds of result, from mild to severe:
 *   sanitize  invisible or control characters, HTML comments: removed, the rest of the text is kept
 *   flag      plain-text instructions aimed at the model ("ignore the previous instructions"): kept, counted, and the model is
 *             told by the prompt that the document is data (the evals check that it resists)
 *   block     text that tries to HIDE an instruction (hidden Unicode, encoded payloads, look-alike letters, hidden HTML):
 *             the document is rejected, nothing is sent to the model
 *
 * Nothing here decides language or size: those are separate checks (language.ts in the llm package, schemas.ts).
 */

export type FindingKind =
  | "invisible_characters"
  | "control_characters"
  | "hidden_unicode_text"
  | "html_comment"
  | "hidden_html"
  | "encoded_payload"
  | "obfuscated_instruction"
  | "mixed_script_word"
  | "model_markup"
  | "injection_phrase";

export type Severity = "sanitize" | "flag" | "block";

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  detail: string;
  /** A short, escaped excerpt for logs: never the whole payload. */
  sample?: string;
}

export interface InspectResult {
  /** The text to use from now on: invisible characters and HTML comments removed. */
  text: string;
  findings: Finding[];
  /** True when at least one finding has severity `block`. */
  blocked: boolean;
}

/* ------------------------------------------------------------------ instruction phrases (English, Portuguese, Spanish) */

const P = (s: string): RegExp => new RegExp(s, "i");

/** Phrases that address the model, not the reader. Matched on normalized text (see `normalizeForMatching`). */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  // English
  P(String.raw`\b(ignore|disregard|forget|override|bypass|skip)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|the|your|these|those|system)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|guidelines?|directions?|constraints?|restrictions?)\b`),
  P(String.raw`\bforget (everything|all)\b`),
  P(String.raw`\b(new|updated|real|actual) (instructions?|task|rules?)\s*:`),
  P(String.raw`\byou are (now|no longer)\b`),
  P(String.raw`\bfrom now on,? (you|ignore|always|only|respond|answer)\b`),
  P(String.raw`\b(reveal|show|print|repeat|output|leak|display|tell me)\b[^.\n]{0,40}\b(system|hidden|initial|original|secret)\b[^.\n]{0,20}\b(prompt|instructions?|message)\b`),
  P(String.raw`\bsystem prompt\b`),
  P(String.raw`\b(developer|debug|admin|maintenance|god|sudo) mode\b`),
  P(String.raw`\bjailbreak|\bdo anything now\b|\bDAN mode\b`),
  P(String.raw`\b(respond|reply|answer|output|write)\b[^.\n]{0,20}\b(only|exactly|just)\b[^.\n]{0,30}\b(with|the word|the following)\b`),
  P(String.raw`\binstead of (the |a )?(quiz|questions?|json)\b`),
  P(String.raw`\b(do not|don't|never) (generate|write|create|make) (a |the )?(quiz|questions?)\b`),
  P(String.raw`\bthe (correct|right) (answer|option) (is|must be|should be) (always )?(the )?(first|last|second|third|fourth|a|b|c|d)\b`),
  P(String.raw`\bmake (the )?(answer|option)s? [^.\n]{0,20}\b(pwned|hacked)\b`),
  // Portuguese
  P(String.raw`\b(ignore|ignora|esque[cç]a|desconsidere|descarte|contorne)\b[^.\n]{0,40}\b(instru[cç][oõ]es|regras|prompts?|diretrizes|restri[cç][oõ]es)\b`),
  P(String.raw`\bvoc[eê] (agora )?[eé] (um|uma)\b|\ba partir de agora,? (voc[eê]|ignore|responda|aja)\b`),
  P(String.raw`\b(revele|mostre|imprima|repita)\b[^.\n]{0,40}\b(prompt|instru[cç][oõ]es)\b`),
  P(String.raw`\bprompt do sistema\b|\bmodo (desenvolvedor|administrador|manuten[cç][aã]o)\b`),
  // Spanish
  P(String.raw`\b(ignora|ignore|olvida|descarta|omite|salta)\b[^.\n]{0,40}\b(instrucciones|reglas|indicaciones|restricciones)\b`),
  P(String.raw`\bahora eres\b|\ba partir de ahora,? (eres|ignora|responde|act[uú]a)\b`),
  P(String.raw`\b(revela|muestra|imprime|repite)\b[^.\n]{0,40}\b(prompt|instrucciones)\b`),
  P(String.raw`\bprompt del sistema\b|\bmodo (desarrollador|administrador|mantenimiento)\b`),
  // French, German, Russian, Chinese, Japanese: an English/Portuguese/Spanish document may still carry one line in another language
  P(String.raw`\b(ignore[zr]?|oublie[zr]?|ne tiens pas compte)\b[^.\n]{0,40}\b(instructions|consignes|r[eè]gles)\b`),
  P(String.raw`\b(ignoriere|vergiss|missachte)\b[^.\n]{0,40}\b(anweisungen|regeln|instruktionen)\b`),
  P(String.raw`(игнорируй|забудь|не учитывай)[^.\n]{0,40}(инструкци|правил)`),
  P(String.raw`(忽略|无视|忘记|忽視)[^.\n]{0,12}(指令|指示|说明|規則|规则|提示)`),
  P(String.raw`(以前|これまで|上記)[^.\n]{0,12}(指示|命令|ルール)[^.\n]{0,6}(無視|忘れ)`),
];

/** Markers that only exist in chat templates: a README has no reason to contain them. */
const MODEL_MARKUP = /<\|(?:im_start|im_end|endoftext|system|user|assistant)\|>|\[\/?INST\]|<<\/?SYS>>/i;

/* ------------------------------------------------------------------ text normalisation helpers */

/** Look-alike letters (Cyrillic and Greek) mapped to Latin, for matching only. */
const CONFUSABLE: Record<string, string> = {
  а: "a", в: "b", с: "c", е: "e", н: "h", і: "i", ј: "j", к: "k", м: "m", о: "o", р: "p", ѕ: "s", т: "t", х: "x", у: "y", ѡ: "w",
  ο: "o", ν: "v", ρ: "p", α: "a", ε: "e", ι: "i", κ: "k", τ: "t", υ: "u", χ: "x", β: "b", η: "n", μ: "u",
};

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" };

const rot13 = (s: string): string =>
  s.replace(/[a-z]/gi, (c) => { const base = c <= "Z" ? 65 : 97; return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base); });
const reverse = (s: string): string => [...s].reverse().join("");

const BIDI_AND_INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu;
const HAS_INVISIBLE = new RegExp(BIDI_AND_INVISIBLE.source, "u");
const TAG_CHARS = /[\u{E0020}-\u{E007E}]/gu;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const HAS_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

export const stripInvisible = (s: string): string => s.replace(BIDI_AND_INVISIBLE, "").replace(CONTROL, "");

/** For MATCHING only (never shown to the model): lower case, look-alikes and leetspeak mapped, separators collapsed. */
export function normalizeForMatching(s: string): string {
  const base = stripInvisible(s).normalize("NFKC").toLowerCase();
  let out = "";
  for (const ch of base) out += CONFUSABLE[ch] ?? ch;
  return out;
}

const deLeet = (s: string): string => s.replace(/[0134578@$!]/g, (c) => LEET[c] ?? c);

/** "i g n o r e   p r e v i o u s" -> "ignore previous" (single letters separated by single spaces/dots/dashes). */
function collapseSpaced(s: string): string {
  return s.replace(/\b(?:[a-z][ .\-_*]){2,}[a-z]\b/gi, (m) => m.replace(/[ .\-_*]/g, ""));
}

const matches = (s: string): boolean => INJECTION_PATTERNS.some((re) => re.test(s));
/** On the raw text (so Russian or Chinese patterns match) and on the normalised text (so look-alike letters do not hide it). */
const hasInjection = (s: string): boolean => matches(s.toLowerCase()) || matches(normalizeForMatching(s));

const excerpt = (s: string, n = 60): string => JSON.stringify(s.slice(0, n)).slice(1, -1);

/* ------------------------------------------------------------------ decoding of encoded payloads */

const printableRatio = (s: string): number => {
  if (!s.length) return 0;
  let ok = 0;
  for (const ch of s) if (/[\p{L}\p{N}\p{P}\p{Zs}\n\r\t]/u.test(ch)) ok++;
  return ok / [...s].length;
};

/** Natural language: several short words separated by spaces (rules out JSON, hashes, keys, binary). */
const looksLikeSentence = (s: string): boolean => (s.match(/\b[\p{L}]{2,}\b/gu) ?? []).length >= 5 && (s.match(/ /g) ?? []).length >= 4;

function tryUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function fromBase64(token: string): string | undefined {
  const t = token.replace(/-/g, "+").replace(/_/g, "/");
  if (t.length % 4 === 1) return undefined;
  try {
    const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
    return tryUtf8(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

function fromHex(token: string): string | undefined {
  if (token.length % 2) return undefined;
  const bytes = new Uint8Array(token.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(token.slice(i * 2, i * 2 + 2), 16);
  return tryUtf8(bytes);
}

/** Every decoded candidate found in the text: [encoding, decoded text]. */
export function decodeCandidates(text: string): [string, string][] {
  const out: [string, string][] = [];
  const add = (enc: string, decoded: string | undefined) => {
    if (decoded && decoded.length >= 8 && printableRatio(decoded) >= 0.9) out.push([enc, decoded]);
  };
  for (const m of text.matchAll(/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{24,}={0,2}(?![A-Za-z0-9+/_-])/g)) add("base64", fromBase64(m[0]));
  for (const m of text.matchAll(/(?<![0-9a-fA-F])(?:[0-9a-fA-F]{2}){12,}(?![0-9a-fA-F])/g)) add("hex", fromHex(m[0]));
  for (const m of text.matchAll(/(?:%[0-9a-fA-F]{2}){8,}/g)) {
    try { add("percent-encoding", decodeURIComponent(m[0])); } catch { /* not valid UTF-8: ignore */ }
  }
  // partly encoded (only the spaces and punctuation): decode the whole token and look for an instruction
  for (const m of text.matchAll(/\S*(?:%[0-9a-fA-F]{2}\S*){3,}/g)) {
    try {
      const decoded = decodeURIComponent(m[0]);
      if (matches(decoded.toLowerCase())) out.push(["percent-encoding", decoded]);
    } catch { /* not valid UTF-8: ignore */ }
  }
  for (const m of text.matchAll(/(?:\\x[0-9a-fA-F]{2}){8,}/g)) add("\\x escapes", m[0].replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
  for (const m of text.matchAll(/(?:\\u[0-9a-fA-F]{4}){6,}/g)) add("\\u escapes", m[0].replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
  for (const m of text.matchAll(/(?:&#x?[0-9a-fA-F]+;){8,}/g)) {
    add("HTML entities", m[0].replace(/&#(x?)([0-9a-fA-F]+);/g, (_, x: string, n: string) => String.fromCodePoint(parseInt(n, x ? 16 : 10))));
  }
  for (const m of text.matchAll(/(?:\b[01]{8}\b[ ,]?){8,}/g)) add("binary", m[0].replace(/[ ,]/g, "").replace(/[01]{8}/g, (b) => String.fromCharCode(parseInt(b, 2))));
  return out;
}

/* ------------------------------------------------------------------ the inspection */

const COMMENT = /<!--[\s\S]*?-->/g;
const HIDDEN_ELEMENT = /<([a-z][a-z0-9]*)\b[^>]*(?:\bhidden\b|aria-hidden\s*=\s*["']?true|style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0|color\s*:\s*(?:white|#fff(?:fff)?))[^"']*["'])[^>]*>([\s\S]*?)<\/\1>/gi;

export interface InspectOptions {
  /** Longest text the guard will look at, in characters (the rest is the caller's size check). Default 600,000. */
  maxChars?: number;
}

/**
 * Inspect a document (or any text bound for a model). The caller must use `result.text`, not the original.
 * Never throws on weird input; returns findings instead.
 */
export function inspectText(input: string, _opts: InspectOptions = {}): InspectResult {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  let text = input;

  // 1. Unicode tag characters (U+E0000..E007F) carry ASCII invisibly: decode them, they are an attack on their own
  const tags = [...text.matchAll(TAG_CHARS)].map((m) => String.fromCharCode(m[0].codePointAt(0)! - 0xe0000)).join("");
  if (tags.length >= 4) add({ kind: "hidden_unicode_text", severity: "block", detail: `${tags.length} invisible Unicode tag characters spell text`, sample: excerpt(tags) });

  // 2. invisible / control characters: remove, and look at how many (a handful of ZWJ in emoji is normal)
  const invisible = text.match(BIDI_AND_INVISIBLE)?.length ?? 0;
  const controls = text.match(CONTROL)?.length ?? 0;
  if (invisible || controls) {
    text = stripInvisible(text);
    if (invisible) add({ kind: "invisible_characters", severity: "sanitize", detail: `${invisible} invisible or direction-control character(s) removed` });
    if (controls) add({ kind: "control_characters", severity: "sanitize", detail: `${controls} control character(s) removed` });
  }
  // invisible characters INSIDE words are how "ig\u200Bnore" evades a filter: count them against the stripped text
  if (invisible >= 3 && hasInjection(input) && !matches(input.toLowerCase())) {
    add({ kind: "obfuscated_instruction", severity: "block", detail: "an instruction is only visible once invisible characters are removed" });
  }

  // 3. HTML comments: a classic hiding place. Removed from what the model sees; an instruction inside is a block
  for (const m of text.matchAll(COMMENT)) {
    const body = m[0].slice(4, -3);
    if (hasInjection(body)) add({ kind: "hidden_html", severity: "block", detail: "an instruction is hidden in an HTML comment", sample: excerpt(body.trim()) });
  }
  if (/<!--[\s\S]*?-->/.test(text)) {
    text = text.replace(COMMENT, "");
    add({ kind: "html_comment", severity: "sanitize", detail: "HTML comment(s) removed" });
  }

  // 4. elements made invisible with HTML/CSS
  for (const m of text.matchAll(HIDDEN_ELEMENT)) {
    const inner = m[2] ?? "";
    if (hasInjection(inner) || decodeCandidates(inner).length || /[\u{E0000}-\u{E007F}]/u.test(inner)) {
      add({ kind: "hidden_html", severity: "block", detail: `an instruction is inside a hidden <${m[1]}> element`, sample: excerpt(inner.trim()) });
    }
  }

  // 5. chat-template markers
  if (MODEL_MARKUP.test(text)) add({ kind: "model_markup", severity: "block", detail: "contains chat-template markers (for example <|im_start|>)" });

  // 6. encoded payloads: decode, then look for instructions or plain sentences
  for (const [enc, decoded] of decodeCandidates(text)) {
    if (hasInjection(decoded) || MODEL_MARKUP.test(decoded)) add({ kind: "encoded_payload", severity: "block", detail: `an instruction is hidden in ${enc}`, sample: excerpt(decoded) });
    else if (decoded.length >= 40 && looksLikeSentence(decoded)) add({ kind: "encoded_payload", severity: "block", detail: `a readable sentence is hidden in ${enc}`, sample: excerpt(decoded) });
  }

  // 7. obfuscated instructions in the visible text: rot13, reversed, leetspeak, spaced letters, look-alike letters
  const norm = normalizeForMatching(text);
  const variants: [string, string][] = [
    ["rot13", rot13(norm)],
    ["reversed text", reverse(norm)],
    ["leetspeak", deLeet(norm)],
    ["spaced letters", collapseSpaced(norm)],
  ];
  for (const [name, v] of variants) {
    if (hasInjection(v) && !hasInjection(norm)) add({ kind: "obfuscated_instruction", severity: "block", detail: `an instruction is written in ${name}` });
  }
  // look-alike letters (Cyrillic/Greek inside a Latin word): only matters if it changes the meaning into an instruction
  const mixed = [...text.matchAll(/\b[\p{L}]{4,}\b/gu)].filter((m) => /\p{Script=Latin}/u.test(m[0]) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(m[0]));
  if (mixed.length) {
    const hit = hasInjection(text) && !matches(text.toLowerCase());
    add({ kind: "mixed_script_word", severity: hit ? "block" : "flag", detail: `${mixed.length} word(s) mix Latin and Cyrillic/Greek letters${hit ? " and spell an instruction" : ""}`, sample: excerpt(mixed[0]![0]) });
  }

  // 8. plain-text instructions: flagged, not blocked (a security tutorial may quote them; the model is told it is data)
  const line = text.split("\n").find((l) => hasInjection(l));
  if (line) add({ kind: "injection_phrase", severity: "flag", detail: "the text contains an instruction aimed at an AI model", sample: excerpt(line.trim()) });

  return { text, findings, blocked: findings.some((f) => f.severity === "block") };
}

/** A one-line, user-safe reason for a blocked document (no payload echoed). */
export function blockReason(findings: Finding[]): string {
  const f = findings.find((x) => x.severity === "block");
  return f ? f.detail.replace(/\s+/g, " ") : "";
}

/* ------------------------------------------------------------------ short free text (topic, names...) */

export interface TextIssue {
  code: "control_or_invisible" | "newline" | "injection" | "encoded";
  message: string;
}

/**
 * A single-line text typed by a user and later placed in a prompt (the quiz topic). Much stricter than a document:
 * no line breaks, no invisible characters, no instruction phrases, no encoded payloads.
 */
export function checkShortText(s: string): TextIssue | undefined {
  if (/[\r\n\u2028\u2029]/.test(s)) return { code: "newline", message: "must be a single line" };
  if (HAS_INVISIBLE.test(s) || HAS_CONTROL.test(s)) return { code: "control_or_invisible", message: "contains invisible or control characters" };
  const r = inspectText(s);
  if (r.findings.some((f) => f.kind === "encoded_payload" || f.kind === "obfuscated_instruction" || f.kind === "mixed_script_word" || f.kind === "model_markup" || f.kind === "hidden_html")) {
    return { code: "encoded", message: "looks like encoded or disguised text" };
  }
  if (r.findings.some((f) => f.kind === "injection_phrase")) return { code: "injection", message: "looks like an instruction to the AI, not a topic" };
  return undefined;
}
