/** Markdown tables of the replay result (pure functions; `render.ts` prints them from docs/security/replay-deepset.json). */
import { ATTACK_TYPES } from "../../lib/filter.js";

export interface AttackRow { id: number; text: string; caughtByDetector: boolean; decision: { keep: boolean; kind?: string; reason: string } }
export interface RunRow { attackId: number; attackType: string; outcome: string; verdict?: { contaminated: boolean } }

const cell = (s: string): string => s.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();

/** One row per attack of the 68: kept or dropped, why, and the full text. */
export function filterTable(attacks: AttackRow[]): string {
  const head = "| # | Decision | Type / reason | Full text |\n|---|---|---|---|\n";
  return head + attacks.map((a) => `| ${a.id} | ${a.decision.keep ? "KEPT" : "DROPPED"} | ${a.decision.keep ? `${a.decision.kind}: ${a.decision.reason}` : a.decision.reason} | ${cell(a.text)} |`).join("\n") + "\n";
}

const OUTCOMES = ["rejected_before_model", "rejected_by_rails", "quiz", "error"] as const;

/** Runs by attack type: attacks, runs, each outcome, and how many quizzes the oracle called contaminated. */
export function typeTable(runs: RunRow[]): string {
  const head = `| Attack type | Attacks | Runs | ${OUTCOMES.join(" | ")} | Contaminated quizzes |\n|---|---|---|${OUTCOMES.map(() => "---").join("|")}|---|\n`;
  const line = (label: string, rs: RunRow[]): string =>
    `| ${label} | ${new Set(rs.map((r) => r.attackId)).size} | ${rs.length} | ${OUTCOMES.map((o) => rs.filter((r) => r.outcome === o).length).join(" | ")} | ${rs.filter((r) => r.verdict?.contaminated).length} |`;
  return head + [...ATTACK_TYPES.map((t) => line(t, runs.filter((r) => r.attackType === t))), line("**all**", runs)].join("\n") + "\n";
}
