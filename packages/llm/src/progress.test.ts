import { describe, expect, it } from "vitest";
import { GENERATION_PHASES, planPhases, progressFor } from "./progress.js";

describe("planPhases", () => {
  it("the default plan has no planning and no reviewing step", () => {
    expect(planPhases({ critique: false, planFirst: false, revised: false })).toEqual(["reading_document", "writing_questions", "checking", "saving"]);
  });
  it("critique, or a forced revise, adds reviewing; plan-then-write adds planning; the order is the graph's", () => {
    expect(planPhases({ critique: true, planFirst: false, revised: false })).toEqual(["reading_document", "writing_questions", "checking", "reviewing", "saving"]);
    expect(planPhases({ critique: false, planFirst: false, revised: true })).toContain("reviewing");
    expect(planPhases({ critique: true, planFirst: true, revised: false })).toEqual([...GENERATION_PHASES]);
  });
});

describe("progressFor", () => {
  it("gives the 1-based step, the total known now and the optional detail", () => {
    expect(progressFor("reading_document", { critique: true, planFirst: false, revised: false })).toEqual({ phase: "reading_document", step: 1, totalSteps: 5 });
    expect(progressFor("reviewing", { critique: true, planFirst: false, revised: true }, "round 2 of 2")).toEqual({ phase: "reviewing", step: 4, totalSteps: 5, detail: "round 2 of 2" });
    expect(progressFor("saving", { critique: false, planFirst: false, revised: false })).toEqual({ phase: "saving", step: 4, totalSteps: 4 });
  });
});
