import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixedIntents, freshIntents, generateOrFallback, type GenerationReport, type NightlyMeta, type Refusal } from "./build-intents-nightly.js";
import { BASE_INTENTS } from "./intents.js";
import { applyExtras } from "./nightly-extras.js";
import type { Summary } from "./nightly-report.js";

const readJson = (name: string): NightlyMeta[] => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")) as NightlyMeta[];
const summary = (): Summary & Record<string, unknown> => ({ schema: 1, cases: 6, leaked: 0, leaks: [], run: { runId: "r" }, byLanguage: {} }) as unknown as Summary & Record<string, unknown>;

describe("a refusal of the attacker model never stops the night", () => {
  const intents = [BASE_INTENTS[0]!, BASE_INTENTS[1]!, BASE_INTENTS[2]!];
  const REFUSAL = "I'm sorry, but I can't help with that.";
  // the stub attacker refuses every text of one intent; the others get a usable paraphrase (the canary survives)
  const stub = (refuse: (prompt: string) => boolean) => async (prompt: string): Promise<string> => {
    if (refuse(prompt)) return REFUSAL;
    return `again: ${/"""([\s\S]*)"""/.exec(prompt)![1]!}`;
  };

  it("skips the refused texts, keeps the others, and reports each skipped text", async () => {
    const refused: Refusal[] = [];
    const fresh = await freshIntents(stub((p) => p.includes("ZX9-BRAVO")), 2, 3, new Map(), intents, (r) => refused.push(r));
    expect(fresh.map((m) => m.intent).sort()).toEqual(["override", "task-swap"]); // (the stub gives one text per intent: identical texts are kept once)
    expect(refused).toHaveLength(2);
    expect(refused.every((r) => r.intent === "prompt-leak" && /sorry/i.test(r.reason))).toBe(true);
  });

  it("asks again with another phrasing before giving up: a text refused at first can still be written", async () => {
    let calls = 0;
    const flaky = async (prompt: string): Promise<string> => (++calls <= 5 ? REFUSAL : `ok ${/"""([\s\S]*)"""/.exec(prompt)![1]!}`);
    const refused: Refusal[] = [];
    const fresh = await freshIntents(flaky, 1, 1, new Map(), [BASE_INTENTS[0]!], (r) => refused.push(r));
    expect(fresh).toHaveLength(1);
    expect(refused).toEqual([]);
    expect(calls).toBe(6);
  });

  it("generateOrFallback: a partial run uses what exists, with the count of refused texts", async () => {
    const r = await generateOrFallback(stub((p) => p.includes("ZX9-BRAVO")), 2, 3, new Map(), () => [], intents);
    expect(r.report).toMatchObject({ requested: 6, produced: 2, fallback: false });
    expect(r.report.refused).toHaveLength(2);
    expect(r.metas).toHaveLength(2);
  });

  it("generateOrFallback: nothing produced (or a crash) falls back to the fixed texts, so the night always has cases", async () => {
    const fixed = fixedIntents(readJson("intents.meta.json"), readJson("intents-nightly.json"));
    expect(fixed.length).toBeGreaterThan(72);
    const refusedAll = await generateOrFallback(async () => REFUSAL, 1, 1, new Map(), () => fixed, intents);
    expect(refusedAll.metas).toBe(fixed);
    expect(refusedAll.report).toMatchObject({ produced: 0, fallback: true });
    expect(refusedAll.report.fallbackReason).toMatch(/no text/);
    expect(refusedAll.report.refused).toHaveLength(3);
    const down = await generateOrFallback(async () => { throw new Error("MiniMax 500"); }, 1, 1, new Map(), () => fixed, intents);
    expect(down.report.fallback).toBe(true);
    const crash = await generateOrFallback(async () => REFUSAL, 1, 1, new Map(), () => fixed, [{ id: "x", canary: "ZX9-X", text: "t" }, null as never]);
    expect(crash.report.fallbackReason).toBeTruthy();
  });

  it("the report shows 'generation refused: N texts', a metric with a new name and WARN lines (data only: no exit code)", () => {
    const g: GenerationReport = { requested: 10, produced: 8, refused: [{ intent: "prompt-leak", language: "pt", reason: REFUSAL }, { intent: "x", language: "en", reason: 'no "acceptable" answer' }], fallback: false };
    const o = applyExtras({ summary: summary(), html: "<footer>f</footer>", failures: [], nightlyRows: [], publicDisabled: true, generation: g }, 1);
    expect(o.html).toContain("generation refused: 2 text(s)");
    expect(o.html).not.toContain("FALLBACK");
    expect(o.summary.generation).toEqual(g);
    expect(JSON.parse(o.emf[0]!)).toMatchObject({ Service: "redteam", RedteamGenerationRequested: 10, RedteamGenerationProduced: 8, RedteamGenerationRefused: 2, RedteamGenerationFallback: 0 });
    expect(o.warnings.filter((w) => w.startsWith("WARN redteam generation-refused"))).toHaveLength(2);
    const fb = applyExtras({ summary: summary(), html: "<footer>f</footer>", failures: [], nightlyRows: [], publicDisabled: true, generation: { ...g, produced: 0, fallback: true, fallbackReason: "refused" } }, 1);
    expect(fb.html).toContain("FALLBACK");
    expect(fb.warnings).toContain("WARN redteam generation-fallback: fixed attack texts used (refused)");
    expect(JSON.parse(fb.emf[0]!)).toMatchObject({ RedteamGenerationFallback: 1 });
  });
});
