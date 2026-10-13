import { SignJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cognitoVerify = vi.fn();
const createVerifierSpy = vi.fn();
vi.mock("aws-jwt-verify", () => ({
  CognitoJwtVerifier: { create: (opts: unknown) => (createVerifierSpy(opts), { verify: cognitoVerify }) },
}));

const { LOCAL_AUDIENCE, LOCAL_ISSUER, cognitoVerifier, createVerifier, localVerifier, signLocalToken } = await import("./auth.js");
const { loadConfig } = await import("./config.js");

const SECRET = "test-secret-test-secret-test-secret";
const key = new TextEncoder().encode(SECRET);

describe("local tokens", () => {
  it("round-trips: a signed token verifies to its subject", async () => {
    expect(await localVerifier(SECRET).verify(await signLocalToken(SECRET, "user-1"))).toEqual({ sub: "user-1" });
  });

  it("rejects a token signed with another secret, an expired one, and a foreign issuer or audience", async () => {
    const v = localVerifier(SECRET);
    await expect(v.verify(await signLocalToken("another-secret-another-secret-xx", "u"))).rejects.toThrow();
    await expect(v.verify(await signLocalToken(SECRET, "u", -10))).rejects.toThrow();
    const sign = (iss: string, aud: string) => new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject("u").setIssuer(iss).setAudience(aud).setExpirationTime("1h").sign(key);
    await expect(v.verify(await sign("evil", LOCAL_AUDIENCE))).rejects.toThrow();
    await expect(v.verify(await sign(LOCAL_ISSUER, "other"))).rejects.toThrow();
  });

  it("rejects a validly signed token without a subject", async () => {
    const t = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer(LOCAL_ISSUER).setAudience(LOCAL_AUDIENCE).setExpirationTime("1h").sign(key);
    await expect(localVerifier(SECRET).verify(t)).rejects.toThrow("token has no sub");
  });

  it("rejects garbage", async () => {
    await expect(localVerifier(SECRET).verify("not-a-jwt")).rejects.toThrow();
  });
});

describe("cognitoVerifier", () => {
  beforeEach(() => { cognitoVerify.mockReset(); createVerifierSpy.mockReset(); });

  it("only accepts access tokens of our pool and clients, and returns the sub", async () => {
    cognitoVerify.mockResolvedValue({ sub: "abc" });
    const v = cognitoVerifier({ COGNITO_USER_POOL_ID: "eu-1_x", clientIds: ["c1", "c2"] });
    expect(createVerifierSpy).toHaveBeenCalledWith({ userPoolId: "eu-1_x", tokenUse: "access", clientId: ["c1", "c2"] });
    expect(await v.verify("tok")).toEqual({ sub: "abc" });
    expect(cognitoVerify).toHaveBeenCalledWith("tok");
  });

  it("propagates a verification failure and rejects a payload without sub", async () => {
    const v = cognitoVerifier({ COGNITO_USER_POOL_ID: "p", clientIds: ["c"] });
    cognitoVerify.mockRejectedValue(new Error("expired"));
    await expect(v.verify("t")).rejects.toThrow("expired");
    cognitoVerify.mockResolvedValue({});
    await expect(v.verify("t")).rejects.toThrow("token has no sub");
  });
});

describe("createVerifier", () => {
  const db = { DATABASE_URL: "postgres://u:p@h/d" };
  it("picks the local verifier for AUTH_MODE=local", async () => {
    const cfg = loadConfig({ ...db, AUTH_MODE: "local", LOCAL_JWT_SECRET: SECRET, QUEUE_MODE: "memory" });
    expect(await createVerifier(cfg).verify(await signLocalToken(SECRET, "u"))).toEqual({ sub: "u" });
  });

  it("picks the cognito verifier otherwise", async () => {
    cognitoVerify.mockResolvedValue({ sub: "cog" });
    const cfg = loadConfig({ ...db, COGNITO_USER_POOL_ID: "p", COGNITO_CLIENT_IDS: "c", QUEUE_MODE: "memory" });
    expect(await createVerifier(cfg).verify("x")).toEqual({ sub: "cog" });
  });
});
