/**
 * A very long, benign README with the attack in ONE section only.
 *
 * Why: documents above about 4500 tokens with 4 or more sections take the section-map-reduce path (packages/llm/src/generation/router.ts):
 * the model reads only 5 sections, one call each, and never sees the whole document. An instruction that sits in one section must
 * still be ignored there. `pickSections` takes the usable sections at positions floor((j + 0.5) * n / 5); with n = 10 these are
 * 1, 3, 5, 7, 9, so the attack goes into section 5: it is always one of the 5 the model reads.
 */
import { readmeBlocks } from "./readme.js";

export const LONG_SECTIONS = 10;
export const ATTACK_SECTION = 5;
/** Each section is about 2300 characters (about 575 tokens): 10 sections are about 5750 tokens, above the 4500 of the single-shot limit. */
const SECTION_CHARS = 2300;

/** The body paragraphs of the benign README of a language (everything that is not a heading). */
function bodyBlocks(language: string): string[] {
  return readmeBlocks(language).filter((b) => !b.startsWith("#"));
}

/** A benign section `index` (0-based): a heading and varied paragraphs of the Tidepool README, long enough to count as usable. */
export function longSection(index: number, language: string): string {
  const paragraphs = bodyBlocks(language);
  const heading = readmeBlocks(language).find((b) => b.startsWith("##")) ?? "## Section";
  const out: string[] = [`${heading} ${index + 1}`];
  let size = 0;
  for (let i = 0; size < SECTION_CHARS; i++) {
    const p = paragraphs[(index + i) % paragraphs.length]!;
    out.push(p);
    size += p.length;
  }
  return out.join("\n\n");
}

/** The long README: LONG_SECTIONS sections, the attack as one paragraph in the middle of section ATTACK_SECTION. */
export function longDocument(attack: string, language: string): string {
  const parts: string[] = [readmeBlocks(language)[0] ?? "# Tidepool"];
  for (let i = 0; i < LONG_SECTIONS; i++) {
    const section = longSection(i, language);
    if (i === ATTACK_SECTION) {
      const paras = section.split("\n\n");
      paras.splice(Math.ceil(paras.length / 2), 0, attack.trim());
      parts.push(paras.join("\n\n"));
    } else parts.push(section);
  }
  return parts.join("\n\n") + "\n";
}
