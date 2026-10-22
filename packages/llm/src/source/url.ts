import { isIP } from "node:net";

/**
 * The Markdown URL is user-supplied, so fetching it is an SSRF surface. Defenses:
 * https only, host allowlist, no credentials in the URL, DNS answers must be public IPs,
 * redirects are followed manually and re-validated, with timeout and size caps.
 */

export class SourceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_url"
      | "host_not_allowed"
      | "blocked_address"
      | "too_many_redirects"
      | "fetch_failed"
      | "too_large"
      | "not_text"
      | "empty",
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export const DEFAULT_ALLOWED_HOSTS = ["github.com", "raw.githubusercontent.com"];
export const MAX_SOURCE_BYTES = 512 * 1024;

/** github.com/o/r/blob/ref/path -> raw.githubusercontent.com/o/r/ref/path; repo root -> README. */
export function toRawUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new SourceError(`not a valid URL: ${input}`, "invalid_url");
  }
  if (u.hostname === "github.com") {
    const [owner, repo, kind, ...rest] = u.pathname.split("/").filter(Boolean);
    if (owner && repo && kind === "blob" && rest.length >= 2) {
      return `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join("/")}`;
    }
    if (owner && repo && !kind) {
      return `https://raw.githubusercontent.com/${owner}/${repo.replace(/\.git$/, "")}/HEAD/README.md`;
    }
  }
  return u.toString();
}

export function assertAllowedUrl(raw: string, allowedHosts: readonly string[]): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SourceError(`not a valid URL: ${raw}`, "invalid_url");
  }
  if (u.protocol !== "https:") throw new SourceError("only https URLs are allowed", "invalid_url");
  if (u.username || u.password) throw new SourceError("credentials in URL are not allowed", "invalid_url");
  if (u.port && u.port !== "443") throw new SourceError("custom ports are not allowed", "invalid_url");
  if (!allowedHosts.includes(u.hostname.toLowerCase())) {
    throw new SourceError(`host not allowed: ${u.hostname}`, "host_not_allowed");
  }
  return u;
}

/** True for loopback, private, link-local (incl. cloud metadata), CGNAT, multicast and reserved ranges. */
export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPrivateAddress(mapped[1]!);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(ip) === 6) {
    const l = ip.toLowerCase();
    return l === "::" || l === "::1" || l.startsWith("fc") || l.startsWith("fd") || /^fe[89ab]/.test(l) || l.startsWith("ff");
  }
  return true; // not an IP at all: treat as unsafe
}
