import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { binaryLike } from "./text.js";

const FIXTURES = new URL("../../../evals/fixtures/", import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), "utf8");
const names = readdirSync(FIXTURES).filter((f) => f.endsWith(".md"));

/** A buffer read as the fetch reads it: bytes decoded as UTF-8, invalid ones becoming U+FFFD. */
const asRead = (bytes: Buffer) => bytes.toString("utf8");

describe("binaryLike", () => {
  it("accepts every document of the golden set", () => {
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) expect(binaryLike(fixture(name)), name).toBeUndefined();
  });

  it("accepts valid UTF-8 whatever the script: accents, CJK, emoji, box drawing", () => {
    const doc = "# Projeto\n\nAção, coração, ñandú. 项目说明 これはテストです 🎉🚀\n┌──────┐\n│ box  │\n└──────┘\n".repeat(20);
    expect(binaryLike(doc)).toBeUndefined();
  });

  it("accepts a README saved in latin-1, where every accent decodes to U+FFFD (measured 0.6% to 3.4%)", () => {
    for (const name of ["portuguese.md", "spanish.md", "brazilian-utils-pt.md"]) {
      const latin1 = asRead(Buffer.from(fixture(name), "latin1"));
      expect(latin1).toContain("�"); // the case is real, not hypothetical
      expect(binaryLike(latin1), name).toBeUndefined();
    }
  });

  it("rejects an executable committed as README.md, by its signature", () => {
    // ELF and MZ are ASCII signatures: they survive the UTF-8 decoding, so no raw bytes are needed
    const elf = asRead(Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(4096, 7)]));
    expect(binaryLike(elf)).toMatch(/ELF executable/);
    const exe = asRead(Buffer.concat([Buffer.from("MZ"), Buffer.alloc(4096, 3)]));
    expect(binaryLike(exe)).toMatch(/Windows executable/);
  });

  it("rejects other containers that are not text", () => {
    const cases: [string, Buffer, RegExp][] = [
      ["pdf", Buffer.from("%PDF-1.7\n..."), /PDF/],
      ["zip", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), /ZIP/],
      ["gzip", Buffer.from([0x1f, 0x8b, 8, 0]), /gzip/],
      ["png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), /PNG/],
      ["sqlite", Buffer.from("SQLite format 3\u0000"), /SQLite/],
    ];
    // the fetch still has the raw bytes, which is where a signature with high bytes survives
    for (const [name, bytes, re] of cases) expect(binaryLike(asRead(bytes), bytes), name).toMatch(re);
    // and without them, the ones made of high bytes are caught by the ratios instead
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), Buffer.alloc(2048, 0x80)]);
    expect(binaryLike(asRead(png))).toMatch(/not valid UTF-8/);
  });

  it("rejects binary content with no signature, by its ratios", () => {
    const random = Buffer.alloc(8192);
    for (let i = 0; i < random.length; i++) random[i] = (i * 73 + 11) % 256;
    const reason = binaryLike(asRead(random));
    expect(reason).toMatch(/not valid UTF-8|control characters/);
  });

  it("does not judge a short document by ratios: a signature still applies", () => {
    expect(binaryLike("���")).toBeUndefined(); // too short to tell
    expect(binaryLike("%PDF-1.4")).toMatch(/PDF/); // a signature needs no length
  });

  it("accepts a document that merely quotes a replacement character", () => {
    const doc = "# Encoding notes\n\nWhen the bytes are invalid the decoder writes � in their place.\n".repeat(10);
    expect(binaryLike(doc)).toBeUndefined();
  });
});
