import { CognitoJwtVerifier } from "aws-jwt-verify";
import { jwtVerify, SignJWT } from "jose";
import type { Config } from "./config.js";

export interface AuthUser {
  sub: string;
  /** Cognito groups of the token. `admin` reviews the requests to add a blocked document to the catalogue. */
  groups: readonly string[];
}

export const ADMIN_GROUP = "admin";
export const isAdmin = (user: AuthUser): boolean => user.groups.includes(ADMIN_GROUP);

/** The groups claim of an access token, as Cognito writes it. Anything else is treated as no groups. */
const groupsOf = (payload: { "cognito:groups"?: unknown }): readonly string[] =>
  Array.isArray(payload["cognito:groups"]) ? payload["cognito:groups"].filter((g): g is string => typeof g === "string") : [];

/** Throws if the token is not acceptable. Implementations must never return a user for an invalid token. */
export interface TokenVerifier {
  verify(token: string): Promise<AuthUser>;
}

/**
 * Real Cognito access tokens. aws-jwt-verify checks the signature against the pool's JWKS (cached),
 * `iss`, `exp`/`nbf`, `token_use === "access"` and that `client_id` is one of our app clients.
 * ID tokens are rejected on purpose: only access tokens may call the API.
 */
export function cognitoVerifier(cfg: Pick<Config, "COGNITO_USER_POOL_ID" | "clientIds">): TokenVerifier {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: cfg.COGNITO_USER_POOL_ID!,
    tokenUse: "access",
    clientId: cfg.clientIds,
  });
  return {
    async verify(token) {
      const payload = await verifier.verify(token);
      if (!payload.sub) throw new Error("token has no sub");
      return { sub: payload.sub, groups: groupsOf(payload) };
    },
  };
}

export const LOCAL_ISSUER = "quizforge-local";
export const LOCAL_AUDIENCE = "quizforge-api";

/** HS256 tokens for local development and automated tests only (config refuses it in production). */
export function localVerifier(secret: string): TokenVerifier {
  const key = new TextEncoder().encode(secret);
  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, key, { issuer: LOCAL_ISSUER, audience: LOCAL_AUDIENCE, algorithms: ["HS256"] });
      if (!payload.sub) throw new Error("token has no sub");
      return { sub: payload.sub, groups: groupsOf(payload as { "cognito:groups"?: unknown }) };
    },
  };
}

/** `groups` mirrors the Cognito claim, so local development and tests can exercise the admin path. */
export async function signLocalToken(secret: string, sub: string, ttlSeconds = 3600, groups: readonly string[] = []): Promise<string> {
  return new SignJWT(groups.length ? { "cognito:groups": [...groups] } : {})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(LOCAL_ISSUER)
    .setAudience(LOCAL_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(new TextEncoder().encode(secret));
}

export function createVerifier(cfg: Config): TokenVerifier {
  return cfg.AUTH_MODE === "local" ? localVerifier(cfg.LOCAL_JWT_SECRET!) : cognitoVerifier(cfg);
}
