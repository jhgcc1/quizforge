import { francAll } from "franc-min";
import { NonRetryableError } from "./errors.js";

/**
 * Language policy: a document is accepted only in one of the supported languages. Detection is statistical (franc, trigram
 * profiles of the languages with more than a million speakers) and runs on the PROSE of the document: code blocks, inline code,
 * URLs and HTML are removed first, so a code-heavy README is judged by its sentences.
 */
export const SUPPORTED_LANGUAGES = ["en", "pt", "es"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
/** `other`: a language we recognise but do not accept. `unknown`: not enough prose to tell. */
export type Lang = SupportedLanguage | "other" | "unknown";

/** ISO 639-3 (what franc returns) -> ours. `sco` (Scots) is a well-known false positive for plain English. */
const ISO3: Record<string, SupportedLanguage> = { eng: "en", sco: "en", por: "pt", spa: "es" };
const MIN_LETTERS = 40;
const SAMPLE_CHARS = 12_000;

/** The sentences of a Markdown/HTML document, without code, links and markup. */
export function proseOf(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#>*_|=~-]{1,}/g, " ")
    .replace(/[0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const letters = (s: string): number => (s.match(/\p{L}/gu) ?? []).length;

export function detectLanguage(text: string): Lang {
  const prose = proseOf(text).slice(0, SAMPLE_CHARS);
  if (letters(prose) < MIN_LETTERS) return "unknown";
  const ranked = francAll(prose, { minLength: 10 });
  const top = ranked[0];
  if (!top || top[0] === "und") return "unknown";
  const mapped = ISO3[top[0]];
  if (mapped) return mapped;
  // a near-tie with a supported language (Portuguese / Galician, Spanish / Catalan): trust the supported one.
  // franc scores are relative to the best guess, and unrelated languages usually sit 0.03 or more below it.
  const best = ranked.find(([code]) => ISO3[code]);
  if (best && top[1] - best[1] <= 0.01) return ISO3[best[0]]!;
  return "other";
}

export class UnsupportedLanguageError extends NonRetryableError {
  constructor(readonly detected: Lang, readonly allowed: readonly string[]) {
    super(`unsupported_language: the document is not written in a supported language (${allowed.join(", ")})`);
  }
}

/** `ALLOWED_LANGUAGES=en,pt,es` -> the validated list (unknown codes are ignored; empty falls back to the default). */
export function parseAllowedLanguages(raw: string | undefined): readonly SupportedLanguage[] {
  const list = (raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s): s is SupportedLanguage => (SUPPORTED_LANGUAGES as readonly string[]).includes(s));
  return list.length ? list : SUPPORTED_LANGUAGES;
}

/** Throws `UnsupportedLanguageError` for a recognised language that is not allowed. Too little text to tell is let through (the guard and size checks cover it). */
export function assertAllowedLanguage(text: string, allowed: readonly SupportedLanguage[] = SUPPORTED_LANGUAGES): Lang {
  const lang = detectLanguage(text);
  if (lang === "other" || (lang !== "unknown" && !allowed.includes(lang))) throw new UnsupportedLanguageError(lang, allowed);
  return lang;
}
