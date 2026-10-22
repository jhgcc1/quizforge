import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../shared/log.js";

const db = {
  findStaleQuizzes: vi.fn(),
  failQuiz: vi.fn(),
  findUnscoredJobs: vi.fn(),
  deleteOldCheckpointThreads: vi.fn(),
  createDb: vi.fn(),
  resolveDatabaseUrl: vi.fn(() => "postgres://resolved"),
};
vi.mock("@quizforge/db", () => db);

const sqsSent: { input: Record<string, unknown> }[] = [];
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class { send = async (c: { input: Record<string, unknown> }) => void sqsSent.push(c); },
  SendMessageCommand: class { constructor(public input: Record<string, unknown>) {} },
}));

const metrics: string[] = [];
const logSpy: { level: string; msg: string; obj: Record<string, unknown> }[] = [];
vi.mock("../../shared/log.js", () => ({
  createLogger: () => recorder(),
  emitMetrics: (m: unknown) => void metrics.push(JSON.stringify(m)),
}));
function recorder(): Logger {
  const rec = (level: string) => (obj: Record<string, unknown>, msg: string) => void logSpy.push({ level, msg, obj });
  return { error: rec("error"), warn: rec("warn"), info: rec("info"), debug: rec("debug"), child: () => recorder() };
}

const { sweepOnce } = await import("./sweep.js");
const { runSweep: main } = await import("./start.js");

const NOW = 1_700_000_000_000;
const quiz = (id: string, status: string, ageMin: number) => ({ id, status, updatedAt: new Date(NOW - ageMin * 60_000) });
const base = () => ({ db: {} as never, log: recorder(), now: () => NOW });

beforeEach(() => {
  Object.values(db).forEach((m) => "mockReset" in m && m.mockReset());
  db.resolveDatabaseUrl.mockReturnValue("postgres://resolved");
  db.findStaleQuizzes.mockResolvedValue([]);
  db.findUnscoredJobs.mockResolvedValue([]);
  db.deleteOldCheckpointThreads.mockResolvedValue(0);
  sqsSent.length = 0;
  metrics.length = 0;
  logSpy.length = 0;
});

describe("sweepOnce (fake database)", () => {
  it("asks for stale quizzes older than the requeue window, relative to now", async () => {
    await sweepOnce({ ...base(), publish: async () => {}, requeueAfterMs: 60_000, rescoreAfterMs: 120_000, checkpointMaxAgeMs: 3_600_000, publishScore: async () => {}, maxScoringAttempts: 2 });
    expect(db.findStaleQuizzes.mock.calls[0]![1]).toEqual(new Date(NOW - 60_000));
    expect(db.findUnscoredJobs.mock.calls[0]!.slice(1)).toEqual([new Date(NOW - 120_000), 2]);
    expect(db.deleteOldCheckpointThreads.mock.calls[0]![1]).toEqual(new Date(NOW - 3_600_000));
  });

  it("re-queues queued quizzes, fails long-generating ones, and ignores generating ones that are still plausible", async () => {
    db.findStaleQuizzes.mockResolvedValue([quiz("q1", "queued", 10), quiz("g1", "generating", 30), quiz("g2", "generating", 5)]);
    const published: string[] = [];
    const res = await sweepOnce({ ...base(), publish: async (id) => void published.push(id) });
    expect(res).toEqual({ requeued: 1, failed: 1, rescored: 0, checkpointsDeleted: 0 });
    expect(published).toEqual(["q1"]);
    expect(db.failQuiz).toHaveBeenCalledTimes(1);
    expect(db.failQuiz.mock.calls[0]![1]).toMatchObject({ quizId: "g1", error: expect.stringMatching(/timed out/) });
  });

  it("a failing step is logged and the sweep goes on with the next quiz", async () => {
    db.findStaleQuizzes.mockResolvedValue([quiz("a", "queued", 10), quiz("b", "queued", 10)]);
    const res = await sweepOnce({ ...base(), publish: async (id) => { if (id === "a") throw new Error("sqs down"); } });
    expect(res.requeued).toBe(1);
    expect(logSpy.filter((l) => l.msg === "sweep step failed")).toHaveLength(1);
  });

  it("re-queues unscored jobs through publishScore, counting only the ones that were sent", async () => {
    db.findUnscoredJobs.mockResolvedValue([{ quizId: "q1", jobId: "j1" }, { quizId: "q2", jobId: "j2" }]);
    const sent: unknown[] = [];
    const res = await sweepOnce({
      ...base(),
      publish: async () => {},
      publishScore: async (m) => {
        if (m.quizId === "q1") throw new Error("boom");
        sent.push(m);
      },
    });
    expect(res.rescored).toBe(1);
    expect(sent).toEqual([{ v: 1, quizId: "q2", jobId: "j2", requestId: "sweeper" }]);
    expect(logSpy.some((l) => l.msg === "scoring re-queue failed")).toBe(true);
  });

  it("does not look for unscored jobs when there is no scoring queue", async () => {
    await sweepOnce({ ...base(), publish: async () => {} });
    expect(db.findUnscoredJobs).not.toHaveBeenCalled();
  });

  it("reports the number of deleted checkpoint threads, and survives a retention failure", async () => {
    db.deleteOldCheckpointThreads.mockResolvedValueOnce(4);
    expect((await sweepOnce({ ...base(), publish: async () => {} })).checkpointsDeleted).toBe(4);
    expect(logSpy.some((l) => l.msg === "deleted expired checkpoint threads" && l.obj.checkpointsDeleted === 4)).toBe(true);
    db.deleteOldCheckpointThreads.mockRejectedValueOnce(new Error("db"));
    const res = await sweepOnce({ ...base(), publish: async () => {} });
    expect(res.checkpointsDeleted).toBe(0);
    expect(logSpy.some((l) => l.msg === "checkpoint retention failed")).toBe(true);
  });

  it("uses the wall clock when no clock is injected", async () => {
    const before = Date.now();
    await sweepOnce({ db: {} as never, log: recorder(), publish: async () => {} });
    const asked = (db.findStaleQuizzes.mock.calls[0]![1] as Date).getTime();
    expect(asked).toBeGreaterThanOrEqual(before - 3 * 60_000);
    expect(asked).toBeLessThanOrEqual(Date.now() - 3 * 60_000);
  });
});

describe("main (the scheduled task)", () => {
  const env = { ...process.env };
  const pool = { end: vi.fn(async () => {}) };
  beforeEach(() => {
    process.env = { ...env };
    delete process.env.SCORING_QUEUE_URL;
    pool.end.mockClear();
    db.createDb.mockReturnValue({ db: {}, pool });
  });

  it("refuses to run without a queue url", async () => {
    delete process.env.SQS_QUEUE_URL;
    await expect(main()).rejects.toThrow("SQS_QUEUE_URL is required");
  });

  it("sweeps once, re-queues through SQS with the sweeper request id, emits metrics and closes the pool", async () => {
    process.env.SQS_QUEUE_URL = "http://sqs/gen";
    db.findStaleQuizzes.mockResolvedValue([quiz("q1", "queued", 10)]);
    await main();
    // the pool error handler is not optional: pg emits `error` on an idle client that dies, and with no listener
    // that is an uncaught exception, which ends the task
    expect(db.createDb).toHaveBeenCalledWith("postgres://resolved", { max: 2, onPoolError: expect.any(Function) });
    // and it must log rather than throw: a sweep that dies on an idle client leaves the stuck quizzes stuck
    const onPoolError = db.createDb.mock.calls[0]![1]!.onPoolError as (e: Error) => void;
    expect(() => onPoolError(new Error("terminating connection due to administrator command"))).not.toThrow();
    expect(sqsSent).toHaveLength(1);
    expect(sqsSent[0]!.input).toEqual({ QueueUrl: "http://sqs/gen", MessageBody: JSON.stringify({ v: 1, quizId: "q1", requestId: "sweeper" }) });
    expect(JSON.parse(metrics[0]!)).toMatchObject({ SweeperRequeued: { value: 1 }, SweeperFailed: { value: 0 }, SweeperRescored: { value: 0 }, CheckpointsDeleted: { value: 0 } });
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it("with a scoring queue it also re-sends unscored jobs there", async () => {
    process.env.SQS_QUEUE_URL = "http://sqs/gen";
    process.env.SCORING_QUEUE_URL = "http://sqs/score";
    db.findUnscoredJobs.mockResolvedValue([{ quizId: "q9", jobId: "j9" }]);
    await main();
    expect(sqsSent.map((s) => s.input)).toEqual([{ QueueUrl: "http://sqs/score", MessageBody: JSON.stringify({ v: 1, quizId: "q9", jobId: "j9", requestId: "sweeper" }) }]);
    expect(JSON.parse(metrics[0]!)).toMatchObject({ SweeperRescored: { value: 1 } });
  });

  it("closes the pool even when the sweep throws", async () => {
    process.env.SQS_QUEUE_URL = "http://sqs/gen";
    db.findStaleQuizzes.mockRejectedValue(new Error("db down"));
    await expect(main()).rejects.toThrow("db down");
    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});
