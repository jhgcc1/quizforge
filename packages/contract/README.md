# @quizforge/contract

The public API contract of QuizForge: the zod schemas of every request and response of the REST API (`CreateQuizBodySchema`, `SaveAnswerBodySchema`, `QuizSummarySchema`, `AttemptResultSchema`, `ErrorBodySchema`, the catalog ...) and the types inferred from them.

**Who depends on it**
- `apps/web` (browser form, BFF and client): depends on this package only.
- `packages/core` re-exports it, so the API, the worker and the other server packages keep importing from `@quizforge/core`.

**Rules (a test enforces the first two)**
- Only dependency: `zod`. No `node:` imports, no fs, no import from `@quizforge/core`.
- Small and browser-safe: no keyword rules, no attack corpus. The topic gets a BASIC local check here (2 to 200 characters, one line, no control, invisible, bidi or tag characters). The STRICT check (instruction phrases, encoded text) lives in `packages/core` as `CreateQuizBodyStrictSchema` and the API uses it.
- 100% statement coverage.

**Versioning**: by git tag `contract-vX.Y.Z`. A breaking change to a schema is a new major version.
