/**
 * Entrypoint of the worker image (`CMD ["node", "--import", "tsx", "src/main.ts"]`). It chooses a role and
 * hands over; everything else lives under `roles/`.
 *
 * One image, two long-running roles, picked by WORKER_ROLE:
 *   generate  consumes the generation queue: builds the quiz, saves it as `ready`, queues a scoring job
 *   score     consumes the scoring queue: judges a saved quiz and stores the scores
 * They never call each other: they share Postgres and the two queues. The third role, `sweep`, is a scheduled
 * task with its own entrypoint (`src/sweeper.ts`) because it runs once and exits instead of serving a queue.
 *
 * The import is dynamic so a role loads only its own code: the scorer never pulls in the generation graph or
 * the detector loader, and the generator never pulls in the judge. Keep this file at this path — the Dockerfile
 * CMD and the ECS task definitions in `jhgcc1/quizforge-infra` name it.
 */
import { loadConfig } from "./shared/config.js";

const config = loadConfig();
const { start } = config.WORKER_ROLE === "score" ? await import("./roles/score/start.js") : await import("./roles/generate/start.js");
await start(config);
