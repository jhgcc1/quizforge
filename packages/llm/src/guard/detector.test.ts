import { describe, expect, it } from "vitest";
import { parseDetectorMode, screenWithDetector, type DetectorResult, type InjectionDetector } from "./detector.js";

const result = (over: Partial<DetectorResult> = {}): DetectorResult => ({ flagged: true, score: 0.97, scanned: 3, total: 3, ms: 5, excerpt: "ignore everything", ...over });
const det = (r: DetectorResult, languages: readonly string[] = ["en"]): InjectionDetector => ({ name: "stub", languages, detect: async () => r });

describe("screenWithDetector", () => {
  it("is off by default and when there is no detector", async () => {
    expect(parseDetectorMode(undefined)).toBe("off");
    expect(parseDetectorMode("nonsense")).toBe("off");
    expect(parseDetectorMode("flag")).toBe("flag");
    expect((await screenWithDetector("x", "en", det(result()), "off")).status).toBe("skipped");
    expect((await screenWithDetector("x", "en", undefined, "flag")).status).toBe("skipped");
  });

  it("skips documents in a language the model does not understand (English only for now)", async () => {
    expect(await screenWithDetector("x", "pt", det(result()), "flag")).toEqual({ status: "skipped", reason: "language" });
    expect(await screenWithDetector("x", "es", det(result()), "block")).toEqual({ status: "skipped", reason: "language" });
  });

  it("flag mode records a flag finding; block mode a block finding", async () => {
    const f = await screenWithDetector("x", "en", det(result()), "flag");
    expect(f.status).toBe("flagged");
    expect(f.status === "flagged" && f.finding).toMatchObject({ kind: "semantic_injection", severity: "flag" });
    const b = await screenWithDetector("x", "en", det(result()), "block");
    expect(b.status).toBe("blocked");
    expect(b.status === "blocked" && b.finding.severity).toBe("block");
  });

  it("a clean verdict passes", async () => {
    expect((await screenWithDetector("x", "en", det(result({ flagged: false, score: 0.01 })), "block")).status).toBe("clean");
  });
});
