#!/usr/bin/env -S pnpm exec tsx
/**
 * How much of a real document is link URLs — the size of the prize for a guard that strips them.
 *   pnpm exec tsx scripts/measure-link-share.mjs
 *
 * A Markdown link keeps its label ("[the docs](https://…)" -> "the docs"), so prose stays readable; only the URL goes.
 * The documents are the test corpus in evals/fixtures (real READMEs plus the small hand-written ones).
 *
 * Writes docs/security/link-share.json. Nothing in the pipeline strips links today: this measures a proposal,
 * and the report reads it in "Open gaps".
 */
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

/** The chars-per-token ratio the estimator uses, read from the source instead of repeated here. */
const CHARS_PER_TOKEN = Number(
  /Math\.ceil\(s\.length \/ (\d+)\)/.exec(readFileSync(new URL("../packages/llm/src/source.ts", import.meta.url), "utf8"))?.[1] ?? 4,
);

const DIR = "evals/fixtures";
const OUT = new URL("../docs/security/link-share.json", import.meta.url);

/** The document without link URLs: a Markdown link keeps its label, an autolink and a bare URL go. */
export const stripLinkUrls = (text) =>
  text
    .replace(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, "$1")
    .replace(/<(https?:\/\/[^>]+)>/g, " ")
    .replace(/https?:\/\/[^\s)"'<>\]]+/g, " ");

const documents = readdirSync(DIR)
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((f) => {
    const text = readFileSync(`${DIR}/${f}`, "utf8");
    const stripped = stripLinkUrls(text);
    const urls = text.match(/https?:\/\/[^\s)"'<>\]]+/g) ?? [];
    return {
      document: f,
      chars: text.length,
      charsWithoutLinkUrls: stripped.length,
      sharePct: Math.round(1000 * (1 - stripped.length / text.length)) / 10,
      urls: urls.length,
      markdownLinks: (text.match(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g) ?? []).length,
      tokensSaved: Math.round((text.length - stripped.length) / CHARS_PER_TOKEN),
    };
  });

const chars = documents.reduce((a, d) => a + d.chars, 0);
const stripped = documents.reduce((a, d) => a + d.charsWithoutLinkUrls, 0);
const doc = {
  about: "Share of a document that is link URLs, measured on evals/fixtures. Written by scripts/measure-link-share.mjs. Nothing strips links today: this measures a proposed change.",
  at: new Date().toISOString(),
  commit: (() => { try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { return "unknown"; } })(),
  charsPerToken: CHARS_PER_TOKEN,
  totals: {
    documents: documents.length,
    chars,
    charsWithoutLinkUrls: stripped,
    sharePct: Math.round(1000 * (1 - stripped / chars)) / 10,
    urls: documents.reduce((a, d) => a + d.urls, 0),
    tokensSaved: documents.reduce((a, d) => a + d.tokensSaved, 0),
  },
  documents,
};
writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");
process.stderr.write(`wrote ${OUT.pathname}: ${doc.totals.sharePct}% of ${documents.length} documents is link URLs\n`);
