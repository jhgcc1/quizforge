# The local stack

Everything in this folder runs **on your machine and nowhere else**. Nothing here is built, deployed or read by
AWS: production comes from the three images the `publish` job pushes to ECR, configured by Terraform in
[`jhgcc1/quizforge-infra`](https://github.com/jhgcc1/quizforge-infra).

That is the whole point of the folder. If a file is here, it is local; if it is not, it either ships in an image
or runs in CI.

```bash
pnpm db:up        # Postgres + the SQS emulator — this is what `pnpm test:integration` needs
pnpm stack:up     # the lot: Postgres, SQS, migrations, api, worker (fake model) and the web UI
pnpm stack:logs
pnpm stack:down
```

## What it is

| File | What it is |
|---|---|
| `docker-compose.yml` | the services. `postgres` and `elasticmq` on their own are enough for the tests; the `app` profile adds `migrate`, `api`, `worker`, `scorer` and `web` |
| `elasticmq.conf` | the SQS emulator's queues, named like the real ones so the code needs no local branch |

## Two things worth knowing

**The images are the real ones.** `api` and `worker` build from `api/Dockerfile` and `worker/Dockerfile` — the same
files CI builds for ECR, with the build context set to the repository root. A local run therefore exercises the
production image, not a simplified copy of it. The worker uses the `runtime-detector` target, so the semantic
detector is loaded here too.

**The web service needs the front end.** It is its own repository and is not vendored here. Check it out into
`web/` at the repository root (git-ignored) before `pnpm stack:up`:

```bash
git clone --depth 1 https://github.com/jhgcc1/quizforge-web web
```

There is no pinned commit between the two repositories: each side is tested against the main of the other, which
is the pair that runs in production.

## What is different from AWS

`AUTH_MODE=local` serves a development login that says **SIMULATION** — no Cognito, any user name works.
`LLM_MODE=fake` returns a scripted quiz, so the whole flow runs without an API key or a cent of spend; set
`LLM_MODE=minimax MINIMAX_API_KEY=…` to use the real model. Everything else — the schema, the queues, the guard,
the output rails — is what production runs.
