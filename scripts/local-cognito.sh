#!/usr/bin/env bash
# Try the REAL login (e-mail sign-up, Google, Facebook through Amazon Cognito) from the local stack.
# Needs: the Cognito user pool deployed with the local dev client (terraform: enable_local_dev_client=true) and AWS access.
#   AWS_PROFILE=... scripts/local-cognito.sh up      fetch the client values, restart api and web in Cognito mode
#   scripts/local-cognito.sh down                    back to the development login (simulation)
# The client secret is written only to .env.cognito (git-ignored, mode 600).
set -euo pipefail
cd "$(dirname "$0")/.."
cmd="${1:?usage: local-cognito.sh up|down}"
REGION="${AWS_REGION:-us-east-2}"
compose=(docker compose -f docker-compose.yml -f docker-compose.cognito.yml --profile app)

case "$cmd" in
  up)
    command -v aws >/dev/null || { echo "aws CLI is required" >&2; exit 1; }
    POOL="${COGNITO_USER_POOL_ID:-$(python3 -c "import json;print(json.load(open('.local/links.json'))['pool'])" 2>/dev/null || true)}"
    [ -n "$POOL" ] || { echo "set COGNITO_USER_POOL_ID (or have .local/links.json)" >&2; exit 1; }
    NAME="quizforge-prod-local-dev"
    CID=$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL" --region "$REGION" --max-results 20 --query "UserPoolClients[?ClientName=='$NAME'].ClientId | [0]" --output text)
    [ "$CID" != "None" ] && [ -n "$CID" ] || { echo "the client '$NAME' does not exist: apply terraform with enable_local_dev_client=true first" >&2; exit 1; }
    SECRET=$(aws cognito-idp describe-user-pool-client --user-pool-id "$POOL" --client-id "$CID" --region "$REGION" --query 'UserPoolClient.ClientSecret' --output text)
    DOMAIN_PREFIX=$(aws cognito-idp describe-user-pool --user-pool-id "$POOL" --region "$REGION" --query 'UserPool.Domain' --output text)
    umask 077
    {
      echo "COGNITO_USER_POOL_ID=$POOL"
      echo "COGNITO_DOMAIN=https://${DOMAIN_PREFIX}.auth.${REGION}.amazoncognito.com"
      echo "COGNITO_LOCAL_CLIENT_ID=$CID"
      echo "COGNITO_LOCAL_CLIENT_SECRET=$SECRET"
      echo "SOCIAL_PROVIDERS=${SOCIAL_PROVIDERS:-facebook}"
    } > .env.cognito
    "${compose[@]}" --env-file .env --env-file .env.cognito up -d --force-recreate api web
    echo "Real login: http://localhost:13000  (Create account, e-mail login and the social buttons now go through Cognito)"
    ;;
  down)
    docker compose --profile app up -d --force-recreate api web
    echo "Development login (simulation): http://localhost:13000"
    ;;
  *) echo "usage: local-cognito.sh up|down" >&2; exit 2 ;;
esac
