/**
 * The API's own documentation, served by the API: the OpenAPI document and a Swagger page that reads it.
 *
 * Unauthenticated and not rate limited, like the probes — the contract is public, and a front-end developer
 * hitting refresh should not be throttled out of the only page that says what the endpoints are.
 */
import type { FastifyInstance } from "fastify";
import { openApiDocument, swaggerHtml } from "../openapi.js";
import { noLimit } from "./health.js";

export function docsRoutes(app: FastifyInstance): void {
  app.get("/openapi.json", noLimit, async () => openApiDocument);
  app.get("/docs", noLimit, async (_req, reply) => reply.type("text/html").send(swaggerHtml));
}
