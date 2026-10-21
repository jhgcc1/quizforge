import { describe, expect, it, vi } from "vitest";
import type { GenerationProgress } from "@quizforge/llm";
import { createProgressReporter, DETAIL_THROTTLE_MS } from "./progress.js";

const p = (phase: GenerationProgress["phase"], step: number, detail?: string): GenerationProgress => ({ phase, step, totalSteps: 5, ...(detail ? { detail } : {}) });

describe("progress reporter", () => {
  it("writes each new phase, in order, one at a time", async () => {
    const order: string[] = [];
    const write = vi.fn(async (x: GenerationProgress) => {
      order.push(`start ${x.phase}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end ${x.phase}`);
    });
    const r = createProgressReporter(write, { warn: vi.fn() });
    r.report(p("reading_document", 1));
    r.report(p("writing_questions", 2));
    await r.flush();
    expect(order).toEqual(["start reading_document", "end reading_document", "start writing_questions", "end writing_questions"]);
  });

  it("skips an identical report and throttles sub-progress, but never a change of phase", async () => {
    let t = 1000;
    const write = vi.fn(async () => undefined);
    const r = createProgressReporter(write, { warn: vi.fn() }, () => t);
    r.report(p("writing_questions", 2, "section 1 of 5"));
    r.report(p("writing_questions", 2, "section 1 of 5")); // identical
    t += 100;
    r.report(p("writing_questions", 2, "section 2 of 5")); // too soon
    t += DETAIL_THROTTLE_MS;
    r.report(p("writing_questions", 2, "section 3 of 5")); // late enough
    r.report(p("checking", 3)); // a new phase is always written
    r.report({ ...p("checking", 3), totalSteps: 6 }); // the total changed (re-scaled bar)
    await r.flush();
    expect(write.mock.calls.map((c) => (c as unknown as [GenerationProgress])[0].detail ?? (c as unknown as [GenerationProgress])[0].phase)).toEqual(["section 1 of 5", "section 3 of 5", "checking", "checking"]);
  });

  it("a failing write is logged and dropped: report and flush never throw, later writes still happen", async () => {
    const warn = vi.fn();
    const write = vi.fn(async (x: GenerationProgress) => {
      if (x.phase === "reading_document") throw new Error("connection reset");
    });
    const r = createProgressReporter(write, { warn });
    expect(() => r.report(p("reading_document", 1))).not.toThrow();
    r.report(p("writing_questions", 2));
    await expect(r.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("uses the real clock by default", async () => {
    const write = vi.fn(async () => undefined);
    const r = createProgressReporter(write, { warn: vi.fn() });
    r.report(p("saving", 5));
    await r.flush();
    expect(write).toHaveBeenCalledOnce();
  });
});
