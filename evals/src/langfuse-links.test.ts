import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLangfuseRuns } from "./langfuse-links.js";

const ENV = { LANGFUSE_BASE_URL: "https://lf.example.com", LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" };
const page = (data: { id: string; name: string; datasetId?: string }[]) => new Response(JSON.stringify({ data }));

beforeEach(() => {
  vi.useFakeTimers();
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("fetchLangfuseRuns", () => {
  it("does nothing without keys, without a base URL or without run names (and makes no request)", async () => {
    const fetchFake = vi.fn();
    vi.stubGlobal("fetch", fetchFake);
    expect(await fetchLangfuseRuns([], { since: "x" })).toBeUndefined();
    for (const k of Object.keys(ENV)) {
      vi.stubEnv(k, "");
      expect(await fetchLangfuseRuns(["r"], { since: "x" }), k).toBeUndefined();
      vi.stubEnv(k, ENV[k as keyof typeof ENV]);
    }
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it("looks the runs up by name with Basic auth and the time window, and returns ids and the dataset id", async () => {
    const fetchFake = vi.fn(async () => page([{ id: "id-1", name: "run-a", datasetId: "ds-1" }, { id: "id-2", name: "run-b" }, { id: "id-3", name: "other" }]));
    vi.stubGlobal("fetch", fetchFake);
    const r = await fetchLangfuseRuns(["run-a", "run-b"], { since: "2026-10-01T00:00:00.000Z" });
    expect(r).toEqual({ datasetId: "ds-1", runs: { "run-a": "id-1", "run-b": "id-2" } });
    expect(fetchFake).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFake.mock.calls[0] as unknown as [string, { headers: { authorization: string } }];
    expect(url).toBe("https://lf.example.com/api/public/experiments?limit=100&fromStartTime=2026-10-01T00%3A00%3A00.000Z");
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from("pk:sk").toString("base64")}`);
  });

  it("asks again while runs are missing (Langfuse ingests asynchronously) and stops once all are found", async () => {
    const responses = [page([]), page([{ id: "1", name: "run-a" }]), page([{ id: "2", name: "run-b", datasetId: "ds" }])];
    const fetchFake = vi.fn(async () => responses.shift()!);
    vi.stubGlobal("fetch", fetchFake);
    const p = fetchLangfuseRuns(["run-a", "run-b"], { since: "x" });
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ datasetId: "ds", runs: { "run-a": "1", "run-b": "2" } });
    expect(fetchFake).toHaveBeenCalledTimes(3);
  });

  it("gives up after 6 attempts with what it has, tolerating a body without data", async () => {
    const fetchFake = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchFake);
    const p = fetchLangfuseRuns(["missing"], { since: "x" });
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ datasetId: null, runs: {} });
    expect(fetchFake).toHaveBeenCalledTimes(6);
  });

  it("an error status means no links at all (undefined), not a half answer", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 403 }));
    expect(await fetchLangfuseRuns(["r"], { since: "x" })).toBeUndefined();
  });
});
