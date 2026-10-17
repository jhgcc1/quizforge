import { describe, expect, it } from "vitest";
import { createDocumentRequest } from "./repo.js";
import type { Db } from "./index.js";

/**
 * The database paths that need no database: what happens when the insert fails.
 *
 * A duplicate is an ordinary outcome — somebody already asked for that document — and the caller turns it into a 409.
 * Anything else is a real failure and must surface instead of being read as "already asked", which would hide an outage
 * behind a friendly message. Everything else in repo.ts is covered against a real PostgreSQL in repo.int.test.ts.
 */
const dbThatFails = (err: unknown): Db =>
  ({
    insert: () => ({
      values: () => ({
        returning: () => Promise.reject(err),
      }),
    }),
  }) as unknown as Db;

const input = { url: "https://raw.githubusercontent.com/o/r/HEAD/README.md", title: "A document", requestedBy: "u-1" };

describe("createDocumentRequest when the insert fails", () => {
  it("treats a unique violation as 'somebody already asked'", async () => {
    const duplicate = Object.assign(new Error("duplicate key"), { code: "23505" });
    await expect(createDocumentRequest(dbThatFails(duplicate), input)).resolves.toBeUndefined();
  });

  it("recognises the violation when the driver nests it in `cause`", async () => {
    const nested = Object.assign(new Error("duplicate key"), { cause: { code: "23505" } });
    await expect(createDocumentRequest(dbThatFails(nested), input)).resolves.toBeUndefined();
  });

  it("lets any other failure through, so an outage is not reported as a duplicate", async () => {
    const outage = Object.assign(new Error("connection terminated"), { code: "57P01" });
    await expect(createDocumentRequest(dbThatFails(outage), input)).rejects.toThrow(/connection terminated/);
  });
});
