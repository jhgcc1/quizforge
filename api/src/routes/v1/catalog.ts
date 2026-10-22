/**
 * The documents offered in the dropdown.
 *
 * The catalogue has three sources, in order of how much is known about the document:
 *   `readme`/`test` — the curated list that ships with the product
 *   `approved`      — the classifier refused it and a human decided it was fine anyway
 *   `used`          — it generated a quiz, so it is offered instead of being pasted again
 * The first entry for a URL wins, so a document that is both curated and used stays curated.
 */
import { SAMPLE_CATALOG } from "@quizforge/core";
import { approvedCatalogEntries, listedCatalogEntries } from "@quizforge/db";
import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./deps.js";

export function catalogRoutes(v1: FastifyInstance, { db }: RouteDeps): void {
  v1.get("/catalog", async () => {
    const seen = new Set<string>();
    const items = [...SAMPLE_CATALOG, ...(await approvedCatalogEntries(db)), ...(await listedCatalogEntries(db))].filter((e) =>
      seen.has(e.url) ? false : (seen.add(e.url), true),
    );
    return { items };
  });
}
