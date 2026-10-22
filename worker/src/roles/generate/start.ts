/**
 * Entrypoint of the GENERATE role: consumes the generation queue, builds the quiz, saves it as `ready` and
 * queues a scoring job. It is one of the two ECS services built from the worker image (`WORKER_ROLE=generate`).
 *
 * This file is wiring only — what to build and in which order. The work itself is in `processor.ts`, which
 * takes everything it needs as arguments so it can be tested without AWS, without a model and without a queue.
 */
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { QuizJobMessageSchema, type ScoreJobMessage } from "@quizforge/core";
import { parseAllowedLanguages, type InjectionDetector } from "@quizforge/llm";
import type { Config } from "../../shared/config.js";
import { Consumer } from "../../shared/consumer.js";
import type { Logger } from "../../shared/log.js";
import { runService, type RoleService, type ServiceContext } from "../../shared/service.js";
import { processQuizJob } from "./processor.js";

/** Called by src/main.ts when WORKER_ROLE is `generate`. Returns only when the process is shutting down. */
export async function start(config: Config): Promise<void> {
  await runService(config, build);
}

async function build(ctx: ServiceContext): Promise<RoleService> {
  const { config, log, db } = ctx;
  const detector = await loadDetector(config, log);

  // LangGraph checkpoints let a job that died mid-generation resume instead of paying for the whole quiz again.
  const checkpointer = PostgresSaver.fromConnString(config.databaseUrl, { schema: "langgraph" });
  await checkpointer.setup();

  const llm = ctx.llm(config.MINIMAX_MODEL);
  const publishScore = scorePublisher(ctx);
  if (!publishScore) log.warn({}, "SCORING_QUEUE_URL is not set: quizzes will be generated but not scored");

  const consumer = new Consumer({
    ...ctx.consumerDefaults,
    transport: ctx.transport,
    parse: (raw) => QuizJobMessageSchema.parse(raw),
    handler: (msg, receive) =>
      processQuizJob(
        {
          db,
          llm,
          publishScore,
          checkpointer,
          log,
          allowedHosts: config.allowedHosts,
          allowedLanguages: parseAllowedLanguages(config.ALLOWED_LANGUAGES),
          detector,
          detectorMode: config.INJECTION_DETECTOR,
          detectorBlockAt: config.INJECTION_DETECTOR_BLOCK_THRESHOLD,
          pricing: ctx.pricing,
        },
        msg,
        { count: receive.count, max: config.SQS_MAX_RECEIVE },
      ),
  });

  return { consumer, modelName: llm.model, close: () => checkpointer.end() };
}

/**
 * Sends the scoring job once the quiz is saved. Only ids travel: the scorer reads the quiz and the document
 * back from Postgres, so a message that sits in the queue never carries document text.
 * Returns undefined when no scoring queue is configured, which is how the local stack runs without a scorer.
 */
function scorePublisher(ctx: ServiceContext): ((msg: ScoreJobMessage) => Promise<void>) | undefined {
  const url = ctx.config.SCORING_QUEUE_URL;
  if (!url) return undefined;
  return async (msg) => {
    await ctx.sqs.send(
      new SendMessageCommand({
        QueueUrl: url,
        MessageBody: JSON.stringify(msg),
        ...(msg.requestId ? { MessageAttributes: { requestId: { DataType: "String", StringValue: msg.requestId } } } : {}),
      }),
    );
  };
}

/**
 * The optional semantic detector (Meta's Llama Prompt Guard 2 86M, multilingual).
 *
 * It is deliberately NOT a dependency of this package: its ONNX runtime and the 1.1 GB model add about 1.6 GB
 * to the image, so it is installed only by the Dockerfile target `runtime-detector` and loaded here by name at
 * run time. Asked for but absent = one loud log line and a service that keeps working without it, which is what
 * lets the scorer and the sweeper run from the small image.
 */
async function loadDetector(config: Config, log: Logger): Promise<InjectionDetector | undefined> {
  if (config.INJECTION_DETECTOR === "off") return undefined;
  try {
    const moduleName = process.env.INJECTION_DETECTOR_MODULE ?? "@quizforge/detector";
    const mod = (await import(/* @vite-ignore */ moduleName)) as { createOnnxDetector(): InjectionDetector };
    const detector = mod.createOnnxDetector();
    log.info({ mode: config.INJECTION_DETECTOR, detector: detector.name }, "semantic injection detector enabled");
    // Load the weights now (about 10 s) instead of inside the first job. A failure here is not fatal: the first
    // document retries it.
    void detector
      .detect("Warm-up paragraph with a few ordinary words so the model is loaded before the first document.")
      .catch((err: unknown) => log.error({ err }, "semantic detector warm-up failed"));
    return detector;
  } catch (err) {
    log.error({ err }, "INJECTION_DETECTOR is set but @quizforge/detector is not installed in this image: running without the semantic detector");
    return undefined;
  }
}
