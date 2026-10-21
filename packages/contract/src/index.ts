/**
 * The public API contract, and the only thing the browser bundle imports from this repository.
 *
 * It is a package of its own, versioned by the git tag `contract-vX.Y.Z` and published to npm, because the
 * front end lives in another repository (`jhgcc1/quizforge-web`). Pure zod, no Node imports: anything that
 * cannot run in a browser does not belong here.
 */
export * from "./schemas";
