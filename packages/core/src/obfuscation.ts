/**
 * "Readable only after decoding": text written in rot13, in reverse or in leetspeak is not prose as it stands but becomes prose once
 * it is decoded. A README has no reason to contain such a sentence, so the guard blocks it even when the decoded sentence matches
 * no keyword rule (the keyword rules know a few hundred phrases; an attacker needs one that is not among them).
 *
 * Dictionary-free: the test counts the COMMON WORDS (articles, prepositions, pronouns of English, Portuguese and Spanish) of a
 * segment before and after decoding. A normal sentence has many of them already; an encoded sentence has none and gains several.
 * Pure, no I/O, browser-safe. Works on text already passed through `normalizeForMatching` (lower case).
 */

const WORDS = (String.raw`
the and to of in is that for it with as on be this are from or an by you your all not at will can if so but have has was were they their
what which when how who do does would should must into than then there these those its our we us he she his her them also only any more
most other some such no yes about after before over under again each every both between without within during while where why very just
than too out up down off new use used using make made get got one two
de que e o a do da em um para com não uma os no na se por mais as dos como mas ao ele das seu sua ou quando muito nos já eu também só
pelo pela até isso ela entre depois sem mesmo aos ter seus quem nas me esse eles estão você foram essa num nem suas meu às minha têm
numa pelos elas qual nós lhe deles essas esses pelas este fosse dele tu te vocês vos lhes meus minhas teu tua teus tuas nosso nossa
la el en y los del las un con una su al lo pero sus le ya este sí porque esta cuando muy sin sobre también hasta hay donde quien desde
todo nos durante todos uno les ni contra otros ese eso ante ellos esto mí antes algunos qué unos yo otro otras otra él tanto esa estos
mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros mi mis tú te ti tu tus ellas
foi são está ser era pode deve cada aqui onde isto sido será podem devem fazer ainda sobre
es son fue puede debe aquí será pueden deben hacer aún
please may shall here now been being could
` + " a e o y").split(/\s+/).filter(Boolean);
const STOP = new Set(WORDS);

const rot13 = (s: string): string =>
  s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));
const reverse = (s: string): string => [...s].reverse().join("");

interface Stops { distinct: number; total: number }
const LEET_BASE: Record<string, string> = { "0": "o", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "8": "b", "9": "g" };
/**
 * Leetspeak decoding of a sentence, as the common words it contains. Only a token that mixes letters with leetspeak characters, or is
 * made of them alone ("45", "411": as, all) is decoded; the caller only gets here for a sentence that already has three mixed tokens,
 * so a number elsewhere stays a number. "1" is both "i" and "l" ("qu1z", "11nk"): each token tries its readings.
 */
function leetStops(s: string): Stops {
  const found: string[] = [];
  for (const t of s.match(/[\p{L}\p{N}@$]+/gu) ?? []) {
    if (!/\p{L}/u.test(t) && !/^[013457]{2,}$/.test(t)) continue;
    const base = t.replace(/[03457@$89]/g, (c) => LEET_BASE[c] ?? c);
    const ones = (base.match(/1/g) ?? []).length;
    if (ones > 4) continue;
    for (let mask = 0; mask < 1 << ones; mask++) {
      let k = 0;
      const word = base.replace(/1/g, () => ((mask >> k++) & 1 ? "l" : "i"));
      if (/^\p{L}+$/u.test(word) && STOP.has(word)) { found.push(word); break; }
    }
  }
  return { distinct: new Set(found).size, total: found.length };
}

/** Whole tokens made of letters only: "d3bug" is not the word "bug" and "p14y" is not "y". */
const wordsOf = (s: string): string[] => (s.match(/[\p{L}\p{N}@$_]+/gu) ?? []).filter((t) => /^\p{L}+$/u.test(t));
const stopsOf = (s: string): Stops => {
  const found = wordsOf(s).filter((w) => STOP.has(w));
  return { distinct: new Set(found).size, total: found.length };
};
/** Tokens that mix letters with leetspeak characters ("c0nf1gur3", "4v4114çõ35"). */
const leetTokens = (s: string): number => (s.match(/[\p{L}\p{N}@$]+/gu) ?? []).filter((t) => t.length >= 3 && /\p{L}/u.test(t) && /[013457@$]/.test(t)).length;

/**
 * Share of the whitespace-separated tokens that are a plain word (letters, with punctuation around), or, with `allowLeet`, a word that
 * may contain leetspeak characters. Tables, directory trees, HTML, paths and listings are mostly not words: they are never "a sentence".
 */
function wordShare(segment: string, allowLeet: boolean): number {
  const tokens = segment.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)); // a lone dash or bullet is neither a word nor not a word
  const word = allowLeet
    ? /^["'([¿¡*_]*[\p{L}\p{N}@$]+(?:['’-][\p{L}\p{N}@$]+)*[.,:;!?"')\]*_]*$/u
    : /^["'([¿¡*_]*\p{L}+(?:['’-]\p{L}+)*[.,:;!?"')\]*_]*$/u;
  return tokens.filter((t) => word.test(t)).length / (tokens.length || 1);
}
const PROSE = 0.8;

/** Sentences, and runs of at most 20 words inside a longer one, so that one encoded sentence in a long paragraph still stands out. */
function segmentsOf(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?;])\s+|\n+/)) {
    const words = sentence.split(/\s+/).filter(Boolean);
    if (words.length < 5) continue;
    for (let i = 0; i < words.length; i += 20) {
      const chunk = words.slice(i, i + 20);
      if (chunk.length >= 5 || i === 0) out.push(chunk.join(" "));
    }
  }
  return out;
}

/**
 * The decoded text reads like prose and the original does not: at least three MORE DIFFERENT common words after decoding (a list of
 * initials or "A vs B vs C" repeats the same one or two), and the common words are a fifth of the words (a sentence has a third).
 */
function gained(before: Stops, after: Stops, words: number): boolean {
  return after.distinct - before.distinct >= 3 && after.total >= 2 * before.total && after.total / words >= 0.2;
}

export type Obfuscation = "rot13" | "reversed text" | "leetspeak";

/**
 * The first encoding under which a segment of `normalized` (lower case) becomes prose, or undefined. `segment` is that text, for the
 * logs (the caller truncates it).
 */
export function readableAfterDecoding(normalized: string): { encoding: Obfuscation; segment: string } | undefined {
  // links, HTML tags and the brackets of Markdown are not words and would hide a sentence written next to them
  const visible = normalized.replace(/https?:\/\/\S+/g, " ").replace(/<[^>]*>/g, " ").replace(/[[\]()]/g, " ");
  for (const segment of segmentsOf(visible)) {
    const words = segment.split(/\s+/).length;
    const before = stopsOf(segment);
    if (wordShare(segment, false) >= PROSE) {
      if (gained(before, stopsOf(rot13(segment)), words)) return { encoding: "rot13", segment };
      if (gained(before, stopsOf(reverse(segment)), words)) return { encoding: "reversed text", segment };
    }
    if (leetTokens(segment) >= 3 && wordShare(segment, true) >= PROSE && gained(before, leetStops(segment), words)) {
      return { encoding: "leetspeak", segment };
    }
  }
  return undefined;
}
