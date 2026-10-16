/**
 * "Is this a text document at all?" — the cheapest question about an uploaded document, and the one nothing asked before.
 *
 * A URL that ends in `.md` proves nothing: raw.githubusercontent.com sets the content type from the FILE NAME, so an
 * executable committed as `README.md` is served as `text/plain; charset=utf-8` and passes every header check. Only the bytes
 * tell. This runs before the guard (which costs seconds on a large document) and before anything is sent to a model.
 *
 * Two signals, measured on real documents:
 *
 *   U+FFFD       the replacement character: it is what UTF-8 decoding leaves where the bytes were not valid UTF-8.
 *                Legitimate UTF-8 has none, whatever the script (accents, CJK, emoji are all valid UTF-8). A README saved
 *                in latin-1 is the honest false positive: every accent becomes one, which measured 0.6% to 3.4% on the
 *                Portuguese and Spanish fixtures. Real binaries measured 29% to 42%.
 *   control      bytes 0x00-0x1F other than tab, newline and carriage return. Text has none; binaries are made of them
 *                (31% to 42% measured).
 *
 * The threshold is 10%: three times the worst legitimate case and a third of the best binary one, so a mis-encoded README
 * is still accepted and an executable is not. Magic bytes are checked separately and do not need a ratio at all.
 */

/** File signatures that no Markdown document can start with. The value is what to tell the user it looks like. */
const MAGIC: [RegExp, string][] = [
  [/^\x7FELF/, "an ELF executable"],
  [/^MZ/, "a Windows executable"],
  [/^%PDF-/, "a PDF"],
  [/^PK\x03\x04/, "a ZIP archive (or a .docx/.xlsx/.jar)"],
  [/^\x1F\x8B/, "a gzip archive"],
  [/^Rar!\x1A\x07/, "a RAR archive"],
  [/^7z\xBC\xAF\x27\x1C/, "a 7-Zip archive"],
  [/^\x89PNG\r\n/, "a PNG image"],
  [/^\xFF\xD8\xFF/, "a JPEG image"],
  [/^GIF8[79]a/, "a GIF image"],
  [/^OggS/, "an Ogg media file"],
  [/^fLaC/, "a FLAC audio file"],
  [/^\x00\x00\x01\xBA|^\x00\x00\x01\xB3/, "an MPEG video"],
  [/^.{4}ftyp/s, "an MP4/MOV media file"],
  [/^SQLite format 3\x00/, "a SQLite database"],
  [/^\xCA\xFE\xBA\xBE/, "a Java class file"],
  [/^\xD0\xCF\x11\xE0/, "an old Office document (.doc/.xls)"],
];

/** The first bytes as one character each (latin-1), which is how a file signature is written. */
const headOf = (bytes: Uint8Array): string => Array.from(bytes.slice(0, 64), (b) => String.fromCharCode(b)).join("");

/** Share of `text` matching `re`, as a fraction of its length. Only called on text past MIN_CHARS_FOR_RATIO. */
const share = (text: string, re: RegExp): number => (text.match(re) ?? []).length / text.length;

export const REPLACEMENT_SHARE_MAX = 0.1;
export const CONTROL_SHARE_MAX = 0.1;
/** Below this many characters the ratios are noise; the magic bytes still apply. */
const MIN_CHARS_FOR_RATIO = 512;

/**
 * Why this is not a text document, or `undefined` when it looks like one. The string is a reason for a log and for the
 * message the user sees, never a stack trace.
 *
 * @param text the bytes already decoded as UTF-8 (that is how the fetch reads them); a prefix is enough.
 * @param rawHead the first raw bytes, when the caller still has them. UTF-8 decoding turns every byte above 0x7F into
 *   U+FFFD, so a signature like PNG (0x89 'P' 'N' 'G') survives only in the bytes. Without them the ASCII signatures
 *   (ELF, MZ, %PDF, PK, SQLite...) still match, and the rest is caught by the ratios below — a PNG is 20% U+FFFD.
 */
export function binaryLike(text: string, rawHead?: Uint8Array): string | undefined {
  const head = rawHead ? headOf(rawHead) : text.slice(0, 64);
  for (const [re, what] of MAGIC) {
    if (re.test(head)) return `it starts like ${what}, not like a text document`;
  }
  if (text.length < MIN_CHARS_FOR_RATIO) return undefined;
  const replacement = share(text, /�/g);
  if (replacement > REPLACEMENT_SHARE_MAX) {
    return `${Math.round(replacement * 100)}% of it is not valid UTF-8 text`;
  }
  const control = share(text, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g);
  if (control > CONTROL_SHARE_MAX) {
    return `${Math.round(control * 100)}% of it is control characters, so it is not a text document`;
  }
  return undefined;
}
