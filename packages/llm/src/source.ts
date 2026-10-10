import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
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

export interface SourceDeps {
  fetch: typeof fetch;
  resolve: (hostname: string) => Promise<string[]>;
}

const defaultDeps: SourceDeps = {
  fetch: (...args) => fetch(...args),
  resolve: async (h) => (await lookup(h, { all: true })).map((r) => r.address),
};

export interface FetchedSource {
  url: string;
  rawUrl: string;
  text: string;
  sha256: string;
}

export interface FetchOptions {
  allowedHosts?: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SourceError(`document exceeds ${maxBytes} bytes`, "too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Normalize so hashing, grounding and chunking all see the same text. */
export function normalizeMarkdown(text: string): string {
  return text.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function fetchMarkdown(
  inputUrl: string,
  opts: FetchOptions = {},
  deps: SourceDeps = defaultDeps,
): Promise<FetchedSource> {
  const allowed = opts.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
  const maxBytes = opts.maxBytes ?? MAX_SOURCE_BYTES;
  assertAllowedUrl(inputUrl, allowed); // validate the URL as given, before any rewriting
  const rawUrl = toRawUrl(inputUrl);
  let current = assertAllowedUrl(rawUrl, allowed);

  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    const addrs = await deps.resolve(current.hostname);
    if (addrs.length === 0 || addrs.some(isPrivateAddress)) {
      throw new SourceError(`host resolves to a blocked address: ${current.hostname}`, "blocked_address");
    }
    let res: Response;
    try {
      res = await deps.fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        headers: { accept: "text/markdown, text/plain;q=0.9, */*;q=0.1", "user-agent": "quizforge/0.1" },
      });
    } catch (err) {
      throw new SourceError(`fetch failed: ${(err as Error).message}`, "fetch_failed");
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new SourceError("redirect without location", "fetch_failed");
      current = assertAllowedUrl(new URL(loc, current).toString(), allowed);
      continue;
    }
    if (!res.ok) throw new SourceError(`source returned HTTP ${res.status}`, "fetch_failed");
    const ctype = res.headers.get("content-type") ?? "";
    if (ctype && !/^text\/|markdown|octet-stream/i.test(ctype)) {
      throw new SourceError(`unexpected content-type: ${ctype}`, "not_text");
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new SourceError(`document exceeds ${maxBytes} bytes`, "too_large");
    const text = normalizeMarkdown(await readCapped(res, maxBytes));
    if (!text) throw new SourceError("document is empty", "empty");
    return { url: inputUrl, rawUrl: current.toString(), text, sha256: createHash("sha256").update(text).digest("hex") };
  }
  throw new SourceError("too many redirects", "too_many_redirects");
}

export interface Section {
  heading: string;
  level: number;
  text: string;
  tokens: number;
}

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/** Split by markdown headings (ignoring '#' lines inside fenced code). Preamble becomes its own section. */
export function splitSections(md: string): Section[] {
  const sections: Section[] = [];
  let heading = "(intro)";
  let level = 0;
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) sections.push({ heading, level, text, tokens: estimateTokens(text) });
    buf = [];
  };
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence ? /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (m) {
      flush();
      heading = m[2]!;
      level = m[1]!.length;
    }
    buf.push(line);
  }
  flush();
  return sections;
}
