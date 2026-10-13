import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = { ctor: [] as unknown[], get: vi.fn(), create: vi.fn() };
vi.mock("@langfuse/client", () => ({
  LangfuseClient: class {
    prompt = { get: state.get, create: state.create };
    constructor(opts: unknown) {
      state.ctor.push(opts);
    }
  },
}));
const { realApi } = await import("./publish-prompts.js");

beforeEach(() => {
  state.ctor.length = 0;
  state.get.mockReset();
  state.create.mockReset();
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk");
  vi.stubEnv("LANGFUSE_SECRET_KEY", "sk");
  vi.stubEnv("LANGFUSE_BASE_URL", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("the Langfuse adapter used by the pipeline", () => {
  it("builds the client from the environment, with a base URL only when one is set", async () => {
    await realApi();
    expect(state.ctor[0]).toEqual({ publicKey: "pk", secretKey: "sk" });
    vi.stubEnv("LANGFUSE_BASE_URL", "https://lf.example.com");
    await realApi();
    expect(state.ctor[1]).toEqual({ publicKey: "pk", secretKey: "sk", baseUrl: "https://lf.example.com" });
  });

  it("latest reads the production label without caching and maps the result", async () => {
    state.get.mockResolvedValue({ prompt: "text", version: 4 });
    expect(await (await realApi()).latest("quizforge/judge")).toEqual({ text: "text", version: 4 });
    expect(state.get).toHaveBeenCalledWith("quizforge/judge", { type: "text", label: "production", cacheTtlSeconds: 0 });
  });

  it("latest says 'no version yet' for a prompt that does not exist, but lets other errors through", async () => {
    const api = await realApi();
    state.get.mockRejectedValueOnce(new Error("Prompt not found: x"));
    expect(await api.latest("x")).toBeUndefined();
    state.get.mockRejectedValueOnce(new Error("Request failed with status 404"));
    expect(await api.latest("x")).toBeUndefined();
    state.get.mockRejectedValueOnce(new Error("503 upstream down"));
    await expect(api.latest("x")).rejects.toThrow("503");
  });

  it("create sends a text prompt with labels, config and commit message and returns the new version", async () => {
    state.create.mockResolvedValue({ version: 7 });
    const out = await (await realApi()).create({ name: "n", text: "t", labels: ["production"], config: { a: 1 }, commitMessage: "m" });
    expect(out).toEqual({ version: 7 });
    expect(state.create).toHaveBeenCalledWith({ name: "n", type: "text", prompt: "t", labels: ["production"], config: { a: 1 }, commitMessage: "m" });
  });
});
