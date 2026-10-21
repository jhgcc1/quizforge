/**
 * Everything `@quizforge/core` offers: the quiz contract and scoring, the input guard and its keyword rules,
 * the attack corpus and the sample catalogue. It re-exports `@quizforge/contract` too (through contracts.js),
 * so server code has one import for both.
 *
 * Why a package rather than a folder in the API: the worker needs the same guard and the same scoring the API
 * needs, and the red team suites need exactly what production runs. A rule that lived in one service would be
 * a rule the other one did not have.
 */
export * from "./scoring.js";
export * from "./quiz-schema.js";
export * from "./contracts.js";
export * from "./catalog.js";
export * from "./guard.js";
export * from "./attacks.js";
export * from "./injection-rules.js";
export * from "./text.js";
export * from "./topic-rules.js";
export * from "./obfuscation.js";
