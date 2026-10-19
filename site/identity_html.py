"""The section "Who is the user on every request, and how the database is queried", shared by both reports.

Verified against apps/api/src/auth.ts, apps/api/src/app.ts, packages/db/src/repo.ts, packages/db/src/index.ts, packages/db/src/url.ts,
packages/db/src/migrate.ts and the main of the front end repository (app/bff, lib/bff.ts, lib/session.ts, proxy.ts).
The route table is checked against app.ts by facts_repo.py: a route that is added or removed fails the build until this table is updated.
"""
from lib import callout, table
import facts as F

SUB = "<code>req.user.sub</code>"

# route -> (identity source, owner filter). Every /v1 route has the same identity source: the onRequest hook of the /v1 scope.
HOOK = "Bearer token, verified in the <code>onRequest</code> hook of <code>/v1</code> → " + SUB
V1 = {
    "POST /v1/quizzes": (HOOK, "<code>findQuizByKey</code>, <code>countRecentQuizzes</code>: <code>WHERE owner_sub = sub</code>. <code>createQuizIdempotent</code> writes <code>owner_sub = sub</code>"),
    "GET /v1/catalog": (HOOK, "None needed, and none wanted: the catalogue is the same list for everybody — the documents that ship with the product, those a reviewer approved, and those that generated a quiz cleanly. It holds no user data"),
    "POST /v1/document-requests": (HOOK, "<code>createQuizIdempotent</code>'s row is read through <code>getOwnedQuiz(quizId, sub)</code> first, so a request can only point at a quiz the caller owns. <code>createDocumentRequest</code> then writes <code>requested_by = sub</code>"),
    "GET /v1/document-requests": (HOOK + ", <b>and the group <code>admin</code></b>", "Deliberately unfiltered: the review queue is everyone's pending requests. The gate is the group, checked in the route and not only in the UI; a token without it gets 403"),
    "POST /v1/document-requests/:id/review": (HOOK + ", <b>and the group <code>admin</code></b>", "<code>reviewDocumentRequest</code> by request id, and only while it is still pending. Who decided is written to <code>reviewed_by</code>"),
    "GET /v1/quizzes": (HOOK, "<code>listQuizzes</code>: <code>WHERE owner_sub = sub</code>. <code>listAttemptsByQuiz</code>: <code>WHERE user_sub = sub</code>"),
    "GET /v1/quizzes/:id/attempts": (HOOK, "<code>getOwnedQuiz(id, sub)</code>, else 404. <code>listAttemptsForQuiz</code>: <code>WHERE quiz_id AND user_sub = sub</code>"),
    "GET /v1/quizzes/:id": (HOOK, "<code>getOwnedQuiz(id, sub)</code>, else 404. Then <code>getPublicQuestions(quizId)</code> reads by quiz id — without the sub, and only after the ownership check has already passed"),
    "POST /v1/quizzes/:id/attempts": (HOOK, "<code>getOwnedQuiz(id, sub)</code>, else 404. <code>findAttemptByKey</code>, <code>getOrCreateAttempt</code>, <code>getAttemptProgress</code>: <code>WHERE user_sub = sub</code>"),
    "GET /v1/attempts/:id": (HOOK, "<code>getAttemptProgress</code> and <code>getAttemptResult</code> start from <code>getOwnedAttempt</code>: <code>WHERE id AND user_sub = sub</code>, else 404"),
    "PUT /v1/attempts/:id/answers/:questionId": (HOOK, "<code>saveAnswer</code>: <code>WHERE id AND user_sub = sub</code> (row lock), else 404. The question and its options are then read through the attempt's own quiz"),
    "POST /v1/attempts/:id/submit": (HOOK, "<code>submitAttempt</code>: <code>WHERE id AND user_sub = sub</code> (row lock), else 404. The score is computed from stored data"),
}
PUBLIC = {
    "GET /healthz": "Always answers <code>ok</code>; no database read",
    "GET /readyz": "Runs the constant <code>select 1</code> to see that the database answers; no user data",
    "GET /openapi.json": "The API description; static",
    "GET /docs": "The Swagger page; static",
}
assert list(V1) == F.API_V1_ROUTES, ("the /v1 routes of app.ts changed: update the table of identity_html.py", F.API_V1_ROUTES)
assert list(PUBLIC) == F.API_PUBLIC_ROUTES, ("the public routes of app.ts changed: update identity_html.py", F.API_PUBLIC_ROUTES)


def section(full=False):
    body = callout("ok", "The short answer", F.tok(
        "<b>Yes.</b> On every route that returns or changes a user's data, the user comes from the verified access token (the Cognito <code>sub</code>), "
        "never from the body, the URL, a header the browser chose or a cookie value. The API reads it once, in one hook, and passes it to the repository functions, "
        "which put it in the <code>WHERE</code> clause. A resource of another user answers 404. <b>Checked route by route: [[api_v1_n]] routes under <code>/v1</code> and no route breaks the rule.</b> "
        "The ORM is <b>Drizzle ORM</b> (version [[drizzle_orm]]) on the <b>node-postgres</b> driver. There is no string-built SQL."))
    body += "<h3>How the token is checked</h3>" + table(["Check", "Where", "What happens if it fails"], [
        ["Token present, format <code>Bearer &lt;token&gt;</code>", "<code>onRequest</code> hook of the <code>/v1</code> scope in <code>apps/api/src/app.ts</code>, before any handler", "401 <code>unauthenticated</code>"],
        ["Signature against the user pool's public keys (JWKS, cached)", "<code>aws-jwt-verify</code> in <code>apps/api/src/auth.ts</code>", "401 <code>invalid_token</code>"],
        ["<code>iss</code> is our user pool, <code>exp</code> and <code>nbf</code> are valid", "same", "401"],
        ["<code>token_use</code> is <code>access</code> (an ID token is rejected)", "same (<code>tokenUse: \"access\"</code>)", "401"],
        ["<code>client_id</code> is one of our app clients", "same (<code>clientId</code>: the list from <code>COGNITO_CLIENT_IDS</code>)", "401"],
        ["The token has a <code>sub</code>", "<code>cognitoVerifier</code>", "401"],
        ["The user is then set once", "<code>req.user = {sub}</code>, added to every log line of the request; the rate limit is also keyed by it", "—"],
    ], widths=["38%", "36%", "26%"])
    body += "<p>The local development verifier (an HS256 secret) exists only for tests and local runs: the API configuration refuses <code>AUTH_MODE=local</code> when <code>NODE_ENV=production</code>.</p>"
    body += "<h3>Every route: identity source and owner filter</h3>"
    body += table(["Route", "Identity source", "Owner filter in the query"], [[f"<code>{r}</code>", s, f] for r, (s, f) in V1.items()], widths=["24%", "26%", "50%"])
    body += table(["Public route (no token)", "What it reads"], [[f"<code>{r}</code>", t] for r, t in PUBLIC.items()], widths=["24%", "76%"])
    body += F.tok(
        "<p>Of the [[api_db_n]] repository functions the API calls, [[api_db_scoped]] take the owner (<code>ownerSub</code> or <code>userSub</code>) and filter by it, "
        "directly or through <code>getOwnedQuiz</code> and <code>getOwnedAttempt</code>. The API integration test calls the six routes that take an id as another user "
        "and expects 404 on each (404, not 403, so the existence of a quiz does not leak).</p>")
    body += "<h3>The queries that do not filter by user, and why each is allowed to</h3>"
    body += F.tok(
        "<p>[[api_db_unscoped]] functions read or write without an owner filter. That is not an oversight to be tidied away later: each one is "
        "unfiltered because filtering would be wrong for what it does. The build refuses to produce this page if a function appears here "
        "without a reason written next to it (<code>API_UNSCOPED_REASON</code> in <code>site/facts_repo.py</code>), so a new unfiltered query "
        "cannot reach production quietly.</p>")
    body += table(["Function", "Why it does not filter by the signed-in user"],
                  [[f"<code>{n}</code>", why] for n, why in sorted(F.API_UNSCOPED_REASON.items())], widths=["28%", "72%"])
    body += callout("info", "The two shapes of exception",
                    "They are not the same kind of thing, and it is worth keeping them apart. <b>Shared by design</b> — the catalogue is one list for "
                    "everybody and holds nobody's data, so there is no user to filter by. <b>Admin by design</b> — the review queue is deliberately "
                    "everyone's requests, and what stands in for the owner filter is the Cognito group, checked in the route itself and not only in the "
                    "interface that calls it. The third shape is the oldest one: <code>getPublicQuestions</code> runs only after an ownership check has "
                    "already passed, so the filter happened a line earlier.")
    body += "<h3>The paths that are not a user request</h3>" + table(["Path", "How it reads", "Why it is not a user request"], [
        ["Worker (generation)", "<code>claimQuiz</code>, <code>completeQuiz</code>, <code>failQuiz</code>, <code>saveJobBudget</code>, <code>upsertSource</code>: by quiz id", "The id comes from an SQS message that the API sent only after its ownership checks (the sweeper can send it again). No HTTP, no token. A user cannot send to the queue: only the task roles of the API, the worker and the sweeper may"],
        ["Scorer", "<code>getQuizForScoring</code>, <code>claimScoring</code>, <code>releaseScoring</code>, <code>saveScores</code>: by quiz id and job id", "Messages come from the worker. It reads the quiz and writes the quality scores; it returns nothing to a user"],
        ["Sweeper (every 5 minutes)", "<code>findStaleQuizzes</code>, <code>findUnscoredJobs</code>, <code>deleteOldCheckpointThreads</code>: by time and status, across all users", "A scheduled task: it re-queues or fails stuck jobs and deletes old checkpoints. It has no user"],
        ["Migrate task", "Runs the SQL migrations", "A one-off ECS task started by the deploy"],
    ], widths=["18%", "42%", "40%"])
    body += F.tok("<p>These are [[repo_other_n]] of the [[repo_n]] functions of <code>packages/db/src/repo.ts</code>. The services use the same database login (the one RDS manages in Secrets Manager), and no user can reach these functions: there is no route that takes a quiz id and calls them for a user.</p>")
    body += "<h3>The front end (quizforge-web, the BFF)</h3>" + table(["Point", "What the code does"], [
        ["Where the token lives", "In httpOnly cookies (<code>qf_at</code>, <code>qf_rt</code>), secure, SameSite=Lax. The browser JavaScript never sees a token"],
        ["How a call reaches the API", "<code>app/bff/[...path]/route.ts</code> takes the access token from the cookie (refreshing it with the refresh token when it is about to expire) and sends <code>Authorization: Bearer &lt;token&gt;</code>. Only <code>/v1/...</code> paths are forwarded; only <code>content-type</code>, <code>idempotency-key</code> and <code>accept</code> are copied from the browser"],
        ["User id from the browser", "None is read and none is sent. The BFF never puts a user id in the call: the API takes it from the token it verifies itself"],
        ["<code>/bff/me</code>", "Returns the <code>sub</code> by decoding the token <b>without verifying it</b>, for display only (the small id in the menu). Nothing is authorised with it"],
        ["Page gate", "<code>proxy.ts</code> only checks that a session cookie exists and redirects to sign-in; it does not decide access to data. The API verifies every token"],
        ["CSRF", "Unsafe methods must have our <code>Origin</code> and the header <code>X-Requested-With</code>, on top of SameSite"],
        ["Dev login", "<code>/auth/dev</code> answers 404 unless the front end runs in local mode; the production API refuses local tokens"],
    ], widths=["24%", "76%"])
    body += "<p>Checked in the main of the front end repository.</p>"
    body += "<h3>Which ORM, and how the database is queried</h3>" + table(["Question", "Answer"], [
        ["ORM", F.tok("<b>Drizzle ORM</b> ([[drizzle_orm]]; the lock file resolves [[drizzle_locked]]) with <code>drizzle-orm/node-postgres</code>. The driver is <code>pg</code> (node-postgres [[pg_locked]]) with a pool of up to 10 connections. The schema is TypeScript (<code>packages/db/src/schema.ts</code>), so a query is typed against it")],
        ["Migrations", F.tok("SQL files ([[migrations_n]]) generated by <code>drizzle-kit</code> [[drizzle_kit]] from the schema and committed. CI fails if <code>schema.ts</code> changed without a new migration. In AWS they are applied by a one-off ECS task (<code>migrate</code>) that the deploy runs before the new code, never at service start; a Postgres advisory lock stops two runners at once")],
        ["Parameterised queries", F.tok("Every value goes through Drizzle's builders (<code>eq</code>, <code>and</code>, <code>inArray</code>, <code>values</code>) or a tagged <code>sql`...`</code> template, which sends the values as bound parameters. By code: [[sql_tagged]] tagged templates in the source, [[sql_const]] raw calls with a constant text (<code>select 1</code> and the two advisory-lock calls, which pass their value as a parameter), and <b>0</b> uses of <code>sql.raw</code>, <code>sql(...)</code> or a query text built from variables. The site build fails if one appears")],
        ["TLS to the database", "The services build the connection URL with <code>sslmode=verify-full</code> (<code>DB_SSL=true</code> in Terraform): the certificate and the host name are verified against the RDS CA bundle. The RDS parameter <code>rds.force_ssl=1</code> refuses a connection without TLS"],
        ["Database user and passwords", "The login is the one RDS manages: the password is generated and kept in Secrets Manager; ECS injects it as separate fields and the code encodes it into the URL. Every service uses it"],
    ], widths=["22%", "78%"])
    body += callout("warn", "What the database does not do", F.tok(
        "The rule is enforced by the application code, not by PostgreSQL. There is no row-level security, and the API connects with one database user. "
        "A new query written without the owner filter would not be stopped by the database. What protects against that: all queries are in one file (<code>repo.ts</code>), the API never builds a query itself, "
        "the integration tests above call every id route as another user, and the build checks that every API-called function without an owner filter is one of the [[api_db_unscoped]] that have a written reason — a new one fails this page."))
    return body
