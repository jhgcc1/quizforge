/** Hand-maintained OpenAPI 3.1 description of the public REST API. Served at /openapi.json and /docs. */

const idem = { name: "Idempotency-Key", in: "header", required: true, description: "Client-generated unique key (8-128 chars). Reuse the SAME key when retrying; the server returns the original outcome.", schema: { type: "string", minLength: 8, maxLength: 128 } };
const uuidParam = (name: string) => ({ name, in: "path", required: true, schema: { type: "string", format: "uuid" } });
const err = (description: string) => ({ description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });
const json = (ref: string, description = "OK") => ({ description, content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } } });

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "QuizForge API",
    version: "1.0.0",
    description:
      "Generates a 5-8 question multiple-choice quiz from a Markdown document, runs it, and scores it. Scoring: 4 points per fully correct answer; multi-answer questions get 4 x max(0, (hits - misses) / K); the final score is the weighted average of the question scores with weights 1.1^(i-1).",
  },
  servers: [{ url: "/" }],
  security: [{ bearer: [] }],
  paths: {
    "/healthz": { get: { security: [], summary: "Liveness", responses: { "200": { description: "ok" } } } },
    "/readyz": { get: { security: [], summary: "Readiness (checks the database)", responses: { "200": { description: "ready" }, "503": err("not ready") } } },
    "/v1/quizzes": {
      post: {
        summary: "Create a quiz (asynchronous)",
        description: "Returns 202 immediately; poll GET /v1/quizzes/{id} until status is `ready`. Replays with the same Idempotency-Key return 200 and the original quiz.",
        parameters: [idem],
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/CreateQuiz" } } } },
        responses: { "202": json("QuizEnvelope", "Accepted"), "200": json("QuizEnvelope", "Replay"), "400": err("Validation / source URL"), "401": err("Unauthenticated"), "422": err("Key reused with a different body"), "429": err("Quota or rate limit"), "503": err("Queue unavailable; retry with the same key") },
      },
      get: { summary: "List my quizzes", responses: { "200": { description: "OK" }, "401": err("Unauthenticated") } },
    },
    "/v1/quizzes/{id}": {
      get: { summary: "Get a quiz (questions appear when ready; the answer key never does)", parameters: [uuidParam("id")], responses: { "200": json("QuizWithQuestions"), "404": err("Not found") } },
    },
    "/v1/quizzes/{id}/attempts": {
      post: { summary: "Start (or resume) an attempt", parameters: [uuidParam("id"), idem], responses: { "201": { description: "Created" }, "200": { description: "Existing attempt returned" }, "409": err("Quiz not ready") } },
    },
    "/v1/attempts/{id}": { get: { summary: "Attempt progress, or the full result once submitted", parameters: [uuidParam("id")], responses: { "200": { description: "OK" }, "404": err("Not found") } } },
    "/v1/attempts/{id}/answers/{questionId}": {
      put: {
        summary: "Save the answer to one question (persisted immediately)",
        description: "Idempotent. `revision` must increase for each change of mind; a delayed retry with an older revision is acknowledged but ignored.",
        parameters: [uuidParam("id"), uuidParam("questionId")],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SaveAnswer" } } } },
        responses: { "200": { description: "saved | ignored" }, "409": err("Already submitted"), "422": err("Invalid option selection") },
      },
    },
    "/v1/attempts/{id}/submit": {
      post: { summary: "Submit and score the attempt", description: "Scores from the stored answers. Safe to repeat: later calls return the same result.", parameters: [uuidParam("id")], responses: { "200": { description: "Result with per-question breakdown, answer key and final score" }, "404": err("Not found") } },
    },
  },
  components: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "Amazon Cognito access token" } },
    schemas: {
      Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, requestId: { type: "string" } } } } },
      CreateQuiz: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceUrl: { type: "string", format: "uri", description: "Markdown document (github.com blob URLs are supported). Defaults to the server's DEFAULT_SOURCE_URL." },
          topic: { type: "string", description: "Optional focus within the document" },
          numQuestions: { type: "integer", minimum: 5, maximum: 8, default: 6 },
          strategy: { type: "string", enum: ["auto", "single-shot", "section-map-reduce"], default: "auto" },
          critique: { type: "boolean", default: true },
        },
      },
      SaveAnswer: { type: "object", required: ["optionIds", "revision"], properties: { optionIds: { type: "array", items: { type: "string", format: "uuid" }, minItems: 1, maxItems: 4 }, revision: { type: "integer", minimum: 0 } } },
      QuizEnvelope: { type: "object", properties: { quiz: { type: "object" } } },
      QuizWithQuestions: { type: "object", properties: { quiz: { type: "object" }, questions: { type: "array", items: { type: "object" } } } },
    },
  },
} as const;

export const swaggerHtml = `<!doctype html><html><head><meta charset="utf-8"><title>QuizForge API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>window.ui = SwaggerUIBundle({ url: "/openapi.json", dom_id: "#ui" });</script></body></html>`;
