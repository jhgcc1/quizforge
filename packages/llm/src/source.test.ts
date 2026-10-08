import { describe, expect, it, vi } from "vitest";
import {
  SourceError,
  assertAllowedUrl,
  fetchMarkdown,
  isPrivateAddress,
  normalizeMarkdown,
  splitSections,
  toRawUrl,
  type SourceDeps,
} from "./source.js";
import { chooseStrategy } from "./router.js";

const publicDns = async () => ["140.82.112.3"];
const md = (text: string, init: ResponseInit = {}) =>
  new Response(text, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, ...init });
const deps = (fetchImpl: SourceDeps["fetch"], resolve = publicDns): SourceDeps => ({ fetch: fetchImpl, resolve });

describe("toRawUrl", () => {
  it("rewrites github blob URLs to raw.githubusercontent.com", () => {
    expect(toRawUrl("https://github.com/pipecat-ai/pipecat/blob/main/README.md")).toBe(
      "https://raw.githubusercontent.com/pipecat-ai/pipecat/main/README.md",
    );
    expect(toRawUrl("https://github.com/o/r/blob/feat/x/docs/a.md")).toBe(
      "https://raw.githubusercontent.com/o/r/feat/x/docs/a.md",
    );
  });
  it("maps a repo root to its README", () => {
    expect(toRawUrl("https://github.com/mastra-ai/mastra")).toBe(
      "https://raw.githubusercontent.com/mastra-ai/mastra/HEAD/README.md",
    );
  });
  it("leaves raw urls untouched and rejects garbage", () => {
    expect(toRawUrl("https://raw.githubusercontent.com/o/r/main/README.md")).toContain("raw.githubusercontent.com");
    expect(() => toRawUrl("not a url")).toThrow(SourceError);
  });
});

describe("assertAllowedUrl", () => {
  const allow = ["github.com", "raw.githubusercontent.com"];
  it.each([
    ["http://github.com/a", "invalid_url"],
    ["https://user:pw@github.com/a", "invalid_url"],
    ["https://github.com:8443/a", "invalid_url"],
    ["https://evil.com/a.md", "host_not_allowed"],
    ["https://github.com.evil.com/a.md", "host_not_allowed"],
    ["https://169.254.169.254/latest/meta-data", "host_not_allowed"],
    ["https://localhost/a", "host_not_allowed"],
  ])("rejects %s", (url, code) => {
    expect(() => assertAllowedUrl(url, allow)).toThrowError(expect.objectContaining({ code }));
  });
  it("accepts allowed https hosts", () => {
    expect(assertAllowedUrl("https://raw.githubusercontent.com/o/r/main/R.md", allow).hostname).toBe("raw.githubusercontent.com");
  });
});

describe("isPrivateAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"])(
    "%s is private",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(["140.82.112.3", "185.199.108.133", "172.32.0.1", "2606:50c0:8000::154"])("%s is public", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe("fetchMarkdown", () => {
  it("fetches, normalizes and hashes the document", async () => {
    const f = vi.fn(async () => md("﻿# Title\r\n\r\n\r\n\r\ntext  \r\n"));
    const r = await fetchMarkdown("https://github.com/o/r/blob/main/README.md", {}, deps(f));
    expect(r.text).toBe("# Title\n\ntext");
    expect(r.rawUrl).toBe("https://raw.githubusercontent.com/o/r/main/README.md");
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("blocks a host that resolves to a private address (DNS pointing inside)", async () => {
    const f = vi.fn();
    await expect(
      fetchMarkdown("https://raw.githubusercontent.com/o/r/main/R.md", {}, deps(f, async () => ["169.254.169.254"])),
    ).rejects.toMatchObject({ code: "blocked_address" });
    expect(f).not.toHaveBeenCalled();
  });

  it("re-validates redirects: allowed->allowed ok, ->evil host rejected", async () => {
    const ok = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://raw.githubusercontent.com/o/r/main/R.md" } }))
      .mockResolvedValueOnce(md("# hi"));
    await expect(fetchMarkdown("https://github.com/o/r/raw/main/R.md", {}, deps(ok))).resolves.toMatchObject({ text: "# hi" });

    const evil = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/x" } }));
    await expect(fetchMarkdown("https://raw.githubusercontent.com/o/r/main/R.md", {}, deps(evil))).rejects.toBeInstanceOf(SourceError);
  });

  it("gives up after too many redirects", async () => {
    const loop = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://raw.githubusercontent.com/o/r/main/R.md" } }));
    await expect(fetchMarkdown("https://raw.githubusercontent.com/o/r/main/R.md", {}, deps(loop))).rejects.toMatchObject({ code: "too_many_redirects" });
  });

  it("enforces the size cap while streaming (no content-length)", async () => {
    const big = vi.fn(async () => md("x".repeat(2000)));
    await expect(fetchMarkdown("https://raw.githubusercontent.com/o/r/main/R.md", { maxBytes: 1000 }, deps(big))).rejects.toMatchObject({ code: "too_large" });
  });

  it("rejects non-text content types, 404s and empty docs", async () => {
    const png = async () => new Response("x", { headers: { "content-type": "image/png" } });
    await expect(fetchMarkdown("https://raw.githubusercontent.com/o/r/main/R.md", {}, deps(png))).rejects.toMatchObject({ code: "not_text" });
    const nf = async () => new Response("no", { status: 404 });
    await expect(fetchMarkdown("https://raw.githubusercontent.com/o/r/main/R.md", {}, deps(nf))).rejects.toMatchObject({ code: "fetch_failed" });
    const empty = async () => md("  \n ");
    await expect(fetchMarkdown("https://raw.githubusercontent.com/o/r/main/R.md", {}, deps(empty))).rejects.toMatchObject({ code: "empty" });
  });
});

describe("splitSections", () => {
  it("splits by headings and ignores # lines inside code fences", () => {
    const doc = ["intro text", "# A", "a body", "```bash", "# not a heading", "echo hi", "```", "## B", "b body"].join("\n");
    const s = splitSections(doc);
    expect(s.map((x) => x.heading)).toEqual(["(intro)", "A", "B"]);
    expect(s[1]!.text).toContain("# not a heading");
  });
  it("normalizeMarkdown is idempotent", () => {
    const once = normalizeMarkdown("a\r\n\r\n\r\n\r\nb  \n");
    expect(normalizeMarkdown(once)).toBe(once);
  });
});

describe("chooseStrategy", () => {
  const section = (n: number) => `## Section ${n}\n${"Some meaningful sentence about the project. ".repeat(60)}\n`;
  it("short documents -> single-shot", () => {
    const r = chooseStrategy("# Tiny\n" + "word ".repeat(200));
    expect(r.strategy).toBe("single-shot");
  });
  it("long structured documents -> section-map-reduce", () => {
    const r = chooseStrategy("# Big\n" + Array.from({ length: 12 }, (_, i) => section(i)).join("\n"));
    expect(r.strategy).toBe("section-map-reduce");
    expect(r.stats.sections).toBeGreaterThanOrEqual(4);
  });
  it("long but unstructured documents stay single-shot", () => {
    const r = chooseStrategy("# One\n" + "Long paragraph without more headings. ".repeat(900));
    expect(r.strategy).toBe("single-shot");
  });
});
