/**
 * The document a user asked us to turn into a quiz: where it may come from, how it is fetched, and how it is
 * split. Kept as one import surface because `@quizforge/llm/source` is a published subpath -- the API imports
 * the URL policy from it to validate what a user typed, before any of this package's other code is involved.
 */
export * from "./url.js";
export * from "./fetch.js";
export * from "./sections.js";
