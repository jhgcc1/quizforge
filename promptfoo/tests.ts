/**
 * Test generators for promptfoo (the attack corpus lives in @quizforge/core, so vitest and promptfoo test the same attacks).
 *   offline: no model. Everything the guard must stop, plus the prompt safety rules. Runs on every pull request.
 *   live:    the real model. Plain-text attacks must not hijack it; the agent must stay on its purpose. Runs on main (before a deploy),
 *            every night and on demand.
 */
import { ATTACK_TECHNIQUES, BAD_TOPICS, SUPPORTED_LANGUAGE_DOCS, UNSUPPORTED_LANGUAGE_DOCS } from "@quizforge/core";

const A = (fn: string) => ({ type: "javascript", value: `file://assertions.js:${fn}` });
type Test = { description: string; vars: Record<string, string>; assert: ReturnType<typeof A>[] };

const blockedAttacks: Test[] = ATTACK_TECHNIQUES.filter((t) => t.expect === "block").map((t) => ({
  description: `BLOCK ${t.id}: ${t.how}`,
  vars: { kind: "attack", id: t.id },
  assert: [A("blocked")],
}));

const plainAttacks = (assert: string[]): Test[] =>
  ATTACK_TECHNIQUES.filter((t) => t.expect === "flag").map((t) => ({
    description: `RESIST ${t.id}: ${t.how}`,
    vars: { kind: "attack", id: t.id },
    assert: assert.map(A),
  }));

const languageTests: Test[] = [
  ...UNSUPPORTED_LANGUAGE_DOCS.map((d) => ({ description: `REJECT language ${d.language}`, vars: { kind: "language", id: d.id }, assert: [A("rejectedLanguage")] })),
  ...SUPPORTED_LANGUAGE_DOCS.map((d) => ({ description: `ACCEPT language ${d.id}`, vars: { kind: "clean", id: d.id }, assert: [A("acceptedQuiz")] })),
];

const topicTests: Test[] = BAD_TOPICS.map((b) => ({ description: `REFUSE topic ${b.id}`, vars: { kind: "topic", id: b.id }, assert: [A("rejectedInput")] }));

const ruleTests: Test[] = [{ description: "PROMPTS keep their safety rules", vars: { kind: "prompts" }, assert: [A("promptRules")] }];

export function offline(): Test[] {
  return [...ruleTests, ...blockedAttacks, ...languageTests, ...topicTests, ...plainAttacks(["sanitizedPrompt"])];
}

export function live(): Test[] {
  const offPurpose: Test[] = ["poem", "joke", "physics", "crypto"].map((id) => ({ description: `PURPOSE off-purpose topic ${id}`, vars: { kind: "off-purpose-topic", id }, assert: [A("resisted"), A("onPurpose")] }));
  return [
    { description: "CONTROL: a clean document gives an on-purpose quiz", vars: { kind: "clean", id: "english" }, assert: [A("acceptedQuiz"), A("onPurpose")] },
    ...plainAttacks(["resisted", "onPurpose"]),
    ...offPurpose,
  ];
}
