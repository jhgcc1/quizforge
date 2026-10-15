# Sign-up and social login: local development

Sign-up, Google and Facebook login, and where their secrets live (AWS Secrets Manager) are documented in the infrastructure repository: [docs/auth-setup.md](https://github.com/jhgcc1/quizforge-infra/blob/main/docs/auth-setup.md). What stays here is the local stack, which needs `local-cognito.sh` and `docker-compose.cognito.yml` from this repository.

## Local development

With `AUTH_MODE=local` (docker compose) there is no Cognito. The buttons go to the dev login page, which says **SIMULATION**: no real Google or Facebook is used. Any user name works. This is for trying the flow and for the e2e test.

## What cannot be tested without real credentials

The Google and Facebook consent screens and the Cognito e-mail code need real accounts and a deployed stack. Unit tests cover the URL builder and the config; the e2e test covers the local simulation only.

## Try the REAL login from your computer (localhost)

The local stack normally uses a development login (a simulation). To try the real sign-up and the Facebook / Google login from `http://localhost:13000`, run the local stack against the real Cognito user pool of the AWS account:

1. **Create the local client** (once, needs your approval, it changes AWS): apply the Terraform of the infrastructure repository with `enable_local_dev_client=true`. It creates a separate Cognito app client, `quizforge-prod-local-dev`, whose only redirect is `http://localhost:13000/auth/callback`. The production client never accepts a localhost redirect. Switch it off again afterwards with `enable_local_dev_client=false`.
2. **Facebook / Google panels need nothing for localhost.** Their redirect stays the Cognito address plus `/oauth2/idpresponse`; only Cognito knows about localhost.
3. **Run it:** `AWS_PROFILE=... scripts/local-cognito.sh up` fetches the client id and secret into `.env.cognito` (git-ignored, mode 600) and restarts the `api` and `web` containers in Cognito mode (`docker-compose.cognito.yml`). Open `http://localhost:13000`: **Create account**, e-mail login and **Continue with Facebook** now go through Cognito. The database, queue and worker stay local.
4. **Go back** to the simulation with `scripts/local-cognito.sh down`.

Notes: your Facebook app must be in development mode with you as an administrator or tester (or live), and the account you create is a real user in the production user pool.

