# Authentication

Sign-up, Google and Facebook login, and where their secrets live (AWS Secrets Manager) are documented in the
infrastructure repository: [docs/auth-setup.md](https://github.com/jhgcc1/quizforge-infra/blob/main/docs/auth-setup.md).

## Locally there is no Cognito

The local stack runs with `AUTH_MODE=local`. The buttons go to the dev login page, which says **SIMULATION**: no
real Google or Facebook is involved, and any user name works. That is what `docker compose --profile app up` gives
you, and what the e2e test drives.

Running the local stack against the **real** user pool used to be possible here, through a compose overlay and a
script that fetched the client secret into a git-ignored file. Both were removed: they were a developer
convenience that nothing in CI, in the worker or in the API depended on, and the real thing is reachable from the
deployed environment. If you need it back, it is in the history of this file's folder.

## What the API does with a token

Either way the API only ever sees a bearer token and verifies it (`api/src/auth.ts`): against the Cognito JWKS in
production, against a local secret in development. Nothing else in the application knows which mode it is in.
