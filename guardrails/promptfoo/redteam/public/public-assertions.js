// Assertion of the PUBLIC dataset cases. The nightly REPORTS and never fails on a finding (a contaminated quiz, a blocked language that reached
// the model, an attack that no layer flagged): those are counted by aggregate.ts and become metrics and alarms. The only thing checked here is
// that the harness produced a readable answer for the case.
const parse = (output) => JSON.parse(typeof output === "string" ? output : output?.output ?? "{}");

export function harness(output) {
  const r = parse(output);
  const ok = r.status !== undefined && r.status !== "error";
  return { pass: ok, score: ok ? 1 : 0, reason: ok ? `status=${r.status}` : `harness error: ${r.reason ?? "no status"}` };
}
