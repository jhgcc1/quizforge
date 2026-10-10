import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ATTACK_MARKER, ATTACK_TECHNIQUES, BAD_TOPICS, DEFAULT_PAYLOAD, benignDocument } from "./attacks.js";
import { CreateQuizBodySchema } from "./schemas.js";
import { checkShortText, inspectText } from "./guard.js";

const b64url = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64url");
const FIXTURES = join(__dirname, "../../../evals/fixtures");

describe("inspectText: the attack corpus", () => {
  for (const t of ATTACK_TECHNIQUES) {
    it(`${t.expect === "block" ? "BLOCKS" : "flags"} ${t.id}: ${t.how}`, () => {
      const r = inspectText(t.embed(DEFAULT_PAYLOAD));
      if (t.expect === "block") {
        expect(r.blocked, JSON.stringify(r.findings)).toBe(true);
      } else {
        expect(r.blocked, JSON.stringify(r.findings)).toBe(false);
        expect(r.findings.map((f) => f.kind), "a plain instruction must at least be flagged").toContain("injection_phrase");
      }
    });
  }

  it("never echoes a whole payload in a finding (only a short sample)", () => {
    for (const t of ATTACK_TECHNIQUES) for (const f of inspectText(t.embed(DEFAULT_PAYLOAD)).findings) expect((f.sample ?? "").length).toBeLessThanOrEqual(80);
  });

  it("removes HTML comments and invisible characters from what continues, and keeps the rest", () => {
    const r = inspectText("Hello <!-- toc -->\u200B world, this is a normal sentence.");
    expect(r.blocked).toBe(false);
    expect(r.text).toBe("Hello  world, this is a normal sentence.");
    expect(r.findings.map((f) => f.severity)).toEqual(["sanitize", "sanitize"]);
  });
});

describe("inspectText: normal documents are left alone", () => {
  it("a plain README has no findings", () => {
    expect(inspectText(benignDocument()).findings).toEqual([]);
  });

  it("the real fixtures are never blocked; the injection fixture is flagged, not blocked", () => {
    for (const f of readdirSync(FIXTURES).filter((x) => x.endsWith(".md"))) {
      const r = inspectText(readFileSync(join(FIXTURES, f), "utf8"));
      expect(r.blocked, `${f}: ${JSON.stringify(r.findings)}`).toBe(false);
      if (f === "injection.md") expect(r.findings.map((x) => x.kind)).toContain("injection_phrase");
    }
  });

  it("things that look like encodings but are not: hashes, keys, JWT, UUIDs, short tokens, colours", () => {
    const doc = [
      "sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "uuid: 123e4567-e89b-12d3-a456-426614174000",
      `jwt: ${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "1234567890", name: "John Doe", iat: 1516239022 })}.${"SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"}`,
      "color: #ffffff; basic: dXNlcjpwYXNz",
      `key: ${"AKIA" + "IOSFODNN7EXAMPLE"}`, // built at run time so the secret scanner has nothing to flag
      "A normal sentence about the retry policy of the scheduler.",
    ].join("\n");
    const r = inspectText(doc);
    expect(r.blocked, JSON.stringify(r.findings)).toBe(false);
  });

  it("emoji with joiners and accented text do not block", () => {
    expect(inspectText("Ready 👨\u200D👩\u200D👧 to go: configuração, ¿cómo funciona? — naïve café.").blocked).toBe(false);
  });

  it("the marker word alone is not an attack", () => {
    expect(inspectText(`The word ${ATTACK_MARKER} appears in a changelog.`).blocked).toBe(false);
  });
});

describe("checkShortText (the quiz topic)", () => {
  for (const b of BAD_TOPICS) it(`refuses ${b.id}`, () => expect(checkShortText(b.topic), b.id).toBeDefined());

  it("accepts ordinary topics in the supported languages and the request schema agrees", () => {
    for (const topic of ["Retries and dead jobs", "Configuração e histórico", "¿Cómo funciona la caché?", "C++ templates (2nd edition)"]) {
      expect(checkShortText(topic), topic).toBeUndefined();
      expect(CreateQuizBodySchema.safeParse({ topic }).success, topic).toBe(true);
    }
  });

  it("the request schema rejects every bad topic with a readable message", () => {
    for (const b of BAD_TOPICS) {
      const r = CreateQuizBodySchema.safeParse({ topic: b.topic });
      expect(r.success, b.id).toBe(false);
    }
  });
});
