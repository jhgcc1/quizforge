/**
 * Entrypoint of the SWEEP task: `node --import tsx src/sweeper.ts`, started by EventBridge every few minutes
 * (see `jhgcc1/quizforge-infra`). The sweep itself is in `roles/sweep/`; this file only runs it and reports.
 *
 * Keep it at this path: the scheduled task's command override names it. What it replaces is a guard inside the
 * sweep module that ran the task only when `process.argv[1]` happened to end in "sweeper.ts" — true on the
 * schedule, true in nothing else, and silently false the moment the file moved.
 */
import { runSweep } from "./roles/sweep/start.js";

try {
  await runSweep();
} catch (err) {
  // Exit non-zero so the schedule's failure alarm fires: a sweep that did not run leaves stuck quizzes stuck.
  console.error(err);
  process.exit(1);
}
