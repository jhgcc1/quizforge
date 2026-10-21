/**
 * Entrypoint of the SCORE role: consumes the scoring queue and judges quizzes the generate role already saved.
 * It is the second ECS service built from the worker image (`WORKER_ROLE=score`), with its own queue and DLQ.
 *
 * It is a separate service so the user does not wait for the judge: measured on real traces the judging was
 * 18 s of a 47 s generation. The two roles never call each other; they share Postgres and the two queues.
 *
 * Note what this role does NOT need, and why the small image is enough for it: no document fetching, so no
 * input guard and no semantic detector (the text it reads was already admitted and stored by the generate
 * role), and no LangGraph checkpointer, because judging is one call and is cheap to simply retry.
 */
import { ScoreJobMessageSchema, type ScoreJobMessage } from "@quizforge/core";
import type { Config } from "../../shared/config.js";
import { Consumer } from "../../shared/consumer.js";
import { runService, type RoleService, type ServiceContext } from "../../shared/service.js";
import { processScoreJob } from "./scorer.js";

/** Called by src/main.ts when WORKER_ROLE is `score`. Returns only when the process is shutting down. */
export async function start(config: Config): Promise<void> {
  await runService(config, build);
}

async function build(ctx: ServiceContext): Promise<RoleService> {
  const { config, log, db } = ctx;
  // A different model from the generator's by default: a model asked to judge its own output prefers its own
  // style. Empty MINIMAX_JUDGE_MODEL falls back to the same model, which is fine locally and wrong in production.
  const judgeLlm = ctx.llm(config.MINIMAX_JUDGE_MODEL || config.MINIMAX_MODEL);

  const consumer = new Consumer<ScoreJobMessage>({
    ...ctx.consumerDefaults,
    transport: ctx.transport,
    parse: (raw) => ScoreJobMessageSchema.parse(raw),
    handler: (msg, receive) =>
      processScoreJob(
        { db, judgeLlm, judgeSamples: config.JUDGE_SAMPLES, pricing: ctx.pricing, log },
        msg,
        { count: receive.count, max: config.SQS_MAX_RECEIVE },
      ),
  });

  return { consumer, modelName: judgeLlm.model };
}
