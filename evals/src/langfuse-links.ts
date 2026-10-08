/**
 * Deep links into Langfuse for the report: the id of every experiment run (dataset run) by name.
 * Uses GET /api/public/experiments: the older dataset-runs endpoints are closed to new Langfuse organisations.
 */
export interface LangfuseRuns {
  datasetId: string | null;
  runs: Record<string, string>;
}

export async function fetchLangfuseRuns(runNames: string[], opts: { since: string }): Promise<LangfuseRuns | undefined> {
  const base = process.env.LANGFUSE_BASE_URL;
  const pk = process.env.LANGFUSE_PUBLIC_KEY;
  const sk = process.env.LANGFUSE_SECRET_KEY;
  if (!base || !pk || !sk || runNames.length === 0) return undefined;
  const wanted = new Set(runNames);
  const found: Record<string, string> = {};
  let datasetId: string | null = null;
  for (let attempt = 0; attempt < 6 && Object.keys(found).length < wanted.size; attempt++) {
    // Langfuse ingests asynchronously (a few minutes at most): ask again before giving up
    const res = await fetch(`${base}/api/public/experiments?limit=100&fromStartTime=${encodeURIComponent(opts.since)}`, { headers: { authorization: `Basic ${Buffer.from(`${pk}:${sk}`).toString("base64")}` } });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { data?: { id: string; name: string; datasetId?: string }[] };
    for (const r of body.data ?? []) if (wanted.has(r.name)) (found[r.name] = r.id), (datasetId ??= r.datasetId ?? null);
    if (Object.keys(found).length < wanted.size) await new Promise((r) => setTimeout(r, 10_000));
  }
  return { datasetId, runs: found };
}
