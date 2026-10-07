import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "./url.js";

describe("resolveDatabaseUrl", () => {
  it("prefers an explicit DATABASE_URL", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: "postgres://a:b@h/db", DB_HOST: "x" })).toBe("postgres://a:b@h/db");
  });
  it("composes from parts and URL-encodes awkward passwords", () => {
    const u = new URL(resolveDatabaseUrl({ DB_HOST: "db.example.com", DB_USER: "quiz", DB_PASSWORD: "p@ss:/w#rd?&=", DB_NAME: "quizforge" }));
    expect(u.hostname).toBe("db.example.com");
    expect(decodeURIComponent(u.password)).toBe("p@ss:/w#rd?&=");
    expect(u.pathname).toBe("/quizforge");
    expect(u.searchParams.get("sslmode")).toBeNull();
  });
  it("DB_SSL=true requires full certificate + hostname verification", () => {
    const u = new URL(resolveDatabaseUrl({ DB_HOST: "h", DB_USER: "u", DB_PASSWORD: "p", DB_NAME: "d", DB_SSL: "true" }));
    expect(u.searchParams.get("sslmode")).toBe("verify-full");
  });
  it("fails loudly when nothing is configured", () => {
    expect(() => resolveDatabaseUrl({})).toThrow(/DATABASE_URL/);
    expect(() => resolveDatabaseUrl({ DB_HOST: "h" })).toThrow();
  });
});
