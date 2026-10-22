import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { binaryLike } from "@quizforge/core";
import { DEFAULT_ALLOWED_HOSTS, MAX_SOURCE_BYTES, SourceError, assertAllowedUrl, isPrivateAddress, toRawUrl } from "./url.js";

/**
 * Fetching the document, once its URL has passed `url.ts`. Everything here is a cap or a check on what comes
 * back: a size limit enforced while reading rather than after, a sniff of the first bytes to refuse what is not
 * text at all, redirects followed by hand so each hop is re-validated, and a normalisation pass so that hashing,
 * grounding and chunking all see exactly the same characters.
 */
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

/** Enough bytes to judge whether this is text at all, without waiting for the rest. */
const SNIFF_BYTES = 4096;

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let sniffed = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SourceError(`document exceeds ${maxBytes} bytes`, "too_large");
    }
    chunks.push(value);
    // The content type proves nothing here: raw.githubusercontent.com sets it from the file name, so an executable
    // committed as README.md arrives as text/plain. Judge the bytes, and hang up on the first ones instead of
    // downloading half a megabyte of a binary and spending seconds of the guard on it.
    if (!sniffed && total >= SNIFF_BYTES) {
      sniffed = true;
      const head = Buffer.concat(chunks);
      const reason = binaryLike(head.toString("utf8"), head);
      if (reason) {
        await reader.cancel();
        throw new SourceError(`that document is not text: ${reason}`, "not_text");
      }
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  // a document smaller than the sniff size was never judged above
  const reason = sniffed ? undefined : binaryLike(text, Buffer.concat(chunks));
  if (reason) throw new SourceError(`that document is not text: ${reason}`, "not_text");
  return text;
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
