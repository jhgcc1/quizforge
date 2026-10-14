# @quizforge/contract

The public API contract of QuizForge: the zod schemas of every request and response of the REST API (`CreateQuizBodySchema`, `SaveAnswerBodySchema`, `QuizSummarySchema`, `AttemptResultSchema`, `ErrorBodySchema`, the catalog ...) and the types inferred from them.

**Who depends on it**
- `jhgcc1/quizforge-web` (browser form, BFF and client): depends on this package only.
- `packages/core` re-exports it, so the API, the worker and the other server packages keep importing from `@quizforge/core`.

**Rules (a test enforces the first two)**
- Only dependency: `zod`. No `node:` imports, no fs, no import from `@quizforge/core`.
- Small and browser-safe: no keyword rules, no attack corpus. The topic gets a BASIC local check here (2 to 200 characters, one line, no control, invisible, bidi or tag characters). The STRICT check (instruction phrases, encoded text) lives in `packages/core` as `CreateQuizBodyStrictSchema` and the API uses it.
- 100% statement coverage.

**Versioning**: by git tag `contract-vX.Y.Z`. A breaking change to a schema is a new major version.

## Releasing a version
1. Change `version` in `package.json` (semver: a breaking change of a schema is a new major version).
2. Merge to `main`, then push the tag `contract-vX.Y.Z` on that commit.
3. The workflow `release-contract.yml` packs the package and attaches `quizforge-contract-X.Y.Z.tgz` to a GitHub Release.
4. The front end (jhgcc1/quizforge-web) depends on the tarball URL, so it only changes when someone updates that URL:
   `https://github.com/jhgcc1/quizforge/releases/download/contract-vX.Y.Z/quizforge-contract-X.Y.Z.tgz`
