/**
 * ECS injects the RDS-managed secret as separate fields (host, user, password...), and it cannot
 * compose a URL. This builds DATABASE_URL from them (URL-encoding the password) when DATABASE_URL
 * itself is not set. DB_SSL=true adds `sslmode=verify-full`: the server certificate AND hostname are
 * verified against the RDS CA bundle (NODE_EXTRA_CA_CERTS in the images).
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME } = env;
  if (!DB_HOST || !DB_USER || !DB_PASSWORD || !DB_NAME) {
    throw new Error("Set DATABASE_URL, or DB_HOST + DB_USER + DB_PASSWORD + DB_NAME");
  }
  const url = new URL(`postgres://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:${env.DB_PORT ?? "5432"}/${DB_NAME}`);
  if (env.DB_SSL === "true") url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}
