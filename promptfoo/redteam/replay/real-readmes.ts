/**
 * Pure helpers for the real Portuguese and Spanish READMEs used to check the guard for false positives (no network here).
 * The README texts are NOT committed (the licences differ): `docs/security/real-readmes-pt-es.json` keeps only where each one is
 * (repo, path, commit SHA, raw URL) and the sha256 of the text, and `fetch-real-readmes.ts` downloads them into `.local/` and checks the hash.
 */
import { createHash } from "node:crypto";
import { detectLanguage } from "@quizforge/llm";

export type PtEs = "pt" | "es";

export interface RealReadmeEntry {
  id: string;
  language: PtEs;
  /** "translation": a README.pt-BR.md / README.es.md of a project (the popular project, translated); "native": a README written in the language by that community. */
  kind: "translation" | "native";
  repo: string;
  path: string;
  commit: string;
  url: string;
  bytes: number;
  sha256: string;
  /** Words of prose (code blocks, inline code, URLs, HTML and images removed). */
  proseWords: number;
}

/** Where fetch-real-readmes.ts puts the downloaded texts (git-ignored). */
export const LOCAL_DIR = ".local/real-readmes-pt-es";

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The raw URL of one file at one commit (the commit makes it immutable). */
export const rawUrl = (repo: string, commit: string, path: string): string => `https://raw.githubusercontent.com/${repo}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;

/** The prose of a Markdown README: no fenced code, inline code, images, link targets, HTML tags, bare URLs, table rules or badges. */
export function proseOf(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s*[|:\-\s]+$/gm, " ")
    .replace(/[#>*_|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const countWords = (text: string): number => text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;

export interface Acceptance { ok: boolean; reason: string; detected: string; proseWords: number; bytes: number }

export const MIN_PROSE_WORDS = 150;
export const MAX_BYTES = 70_000;

/** Keep a README only if it is of a reasonable size, has enough prose, and `detectLanguage` says it is in the expected language. */
export function acceptReadme(text: string, expected: PtEs): Acceptance {
  const bytes = Buffer.byteLength(text, "utf8");
  const prose = proseOf(text);
  const proseWords = countWords(prose);
  const detected = detectLanguage(prose);
  const base = { detected, proseWords, bytes };
  if (bytes > MAX_BYTES) return { ok: false, reason: `too big (${bytes} bytes)`, ...base };
  if (proseWords < MIN_PROSE_WORDS) return { ok: false, reason: `not enough prose (${proseWords} words)`, ...base };
  if (detected !== expected) return { ok: false, reason: `detectLanguage says ${detected}, expected ${expected}`, ...base };
  return { ok: true, reason: "ok", ...base };
}

/** Check a downloaded text against its manifest entry (sha256 and size). Returns a problem or undefined. */
export function verifyEntry(entry: Pick<RealReadmeEntry, "id" | "sha256" | "bytes">, text: string): string | undefined {
  if (sha256Hex(text) !== entry.sha256) return `${entry.id}: sha256 differs from the manifest (the file changed or the download is damaged)`;
  if (Buffer.byteLength(text, "utf8") !== entry.bytes) return `${entry.id}: size differs from the manifest`;
  return undefined;
}

/** The file name a README gets inside `.local/real-readmes-pt-es/`. */
export const localName = (e: Pick<RealReadmeEntry, "id" | "language">): string => `${e.language}/${e.id}.md`;
