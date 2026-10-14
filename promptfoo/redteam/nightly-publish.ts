/**
 * The AWS part of the nightly run: put the files of one run in S3, move the `latest/` pointer, and tell the alarm topic when a canary leaked.
 * The Fargate image has no AWS CLI, so this uses the AWS SDK for JavaScript (the task role gives the credentials).
 *
 *   s3://BUCKET/redteam/RUN_ID/{summary.json,report.html,new-failures.json,redteam-nightly.json,...}   never overwritten (a second upload fails)
 *   s3://BUCKET/redteam/latest/{summary.json,report.html}                                              overwritten every night (a copy, never read by the run)
 *
 *   tsx promptfoo/redteam/nightly-publish.ts --bucket B --run-id ID --dir DIR [--topic ARN] [--extra file.json ...]
 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PutObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Summary } from "./nightly-report.js";

export const SEVEN_DAYS = 7 * 24 * 3600;

const TYPES: Record<string, string> = { ".json": "application/json", ".html": "text/html; charset=utf-8" };
export const contentType = (file: string): string => TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream";

export interface Sender {
  send(command: unknown): Promise<unknown>;
}

export interface UploadFile {
  /** Local path. */
  path: string;
  /** File name inside the run folder. */
  name: string;
}

/** Every file goes to redteam/RUN_ID/NAME with "If-None-Match: *": an existing object is never replaced (the run folder is immutable). */
export async function uploadRun(s3: Sender, bucket: string, runId: string, files: UploadFile[]): Promise<string[]> {
  const keys: string[] = [];
  for (const f of files) {
    const key = `redteam/${runId}/${f.name}`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: readFileSync(f.path), ContentType: contentType(f.name), IfNoneMatch: "*" }));
    keys.push(key);
  }
  return keys;
}

/** The pointer to the newest run: a plain overwrite of two small files. */
export async function updateLatest(s3: Sender, bucket: string, dir: string): Promise<string[]> {
  const keys: string[] = [];
  for (const name of ["summary.json", "report.html"]) {
    const key = `redteam/latest/${name}`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: readFileSync(resolve(dir, name)), ContentType: contentType(name) }));
    keys.push(key);
  }
  return keys;
}

export type Presign = (bucket: string, key: string, expiresIn: number) => Promise<string>;

export const defaultPresign =
  (s3: S3Client): Presign =>
  (bucket, key, expiresIn) =>
    getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });

/**
 * The text of the alarm message. NOTE: a link signed with the temporary credentials of a task role stops working when those credentials
 * expire (a few hours), even if it asks for 7 days. The message says so and names the helper that makes a fresh link.
 */
export function alarmMessage(s: Summary, link: string, bucket: string): { subject: string; body: string } {
  const r = s.run;
  const byLang = Object.entries(s.byLanguage)
    .filter(([, c]) => c.leaked > 0)
    .map(([l, c]) => `${l}: ${c.leaked}`)
    .join(", ");
  return {
    subject: `QuizForge red team: ${s.leaked} canary leak(s) in ${r.runId}`.slice(0, 100),
    body: [
      `The nightly red team run ${r.runId} found ${s.leaked} leak(s) out of ${s.cases} cases (commit ${r.gitSha.slice(0, 12)}, model ${r.model}).`,
      `Rejected before the model: ${s.rejectedBeforeModel}. Rejected by the output rails: ${s.rejectedByRails}. Valid quiz: ${s.validQuiz}. Other failures: ${s.otherFailures}.`,
      byLang ? `Leaks by language: ${byLang}.` : "",
      "",
      `Report (link made with the task role: it works for a few hours at most, even though it asks for 7 days): ${link}`,
      `Report in S3: s3://${bucket}/redteam/${r.runId}/report.html`,
      "For a fresh link run: scripts/redteam-latest.sh",
    ]
      .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
      .join("\n"),
  };
}

export async function notifyLeaks(sns: Sender, topicArn: string, s: Summary, link: string, bucket: string): Promise<boolean> {
  if (s.leaked === 0) return false;
  const m = alarmMessage(s, link, bucket);
  await sns.send(new PublishCommand({ TopicArn: topicArn, Subject: m.subject, Message: m.body }));
  return true;
}

export interface PublishArgs {
  bucket: string;
  runId: string;
  dir: string;
  topic?: string;
  extra: string[];
}

export function parsePublishArgs(argv: string[]): PublishArgs {
  const get = (n: string): string | undefined => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const bucket = get("--bucket");
  const runId = get("--run-id");
  const dir = get("--dir");
  if (!bucket || !runId || !dir) throw new Error("usage: nightly-publish.ts --bucket B --run-id ID --dir DIR [--topic ARN] [--extra file ...]");
  const extra: string[] = [];
  for (let i = argv.indexOf("--extra") + 1; argv.includes("--extra") && i < argv.length && !argv[i]!.startsWith("--"); i++) extra.push(argv[i]!);
  const topic = get("--topic");
  return { bucket, runId, dir: resolve(dir), extra, ...(topic ? { topic } : {}) };
}

/** Upload, move the pointer, and (when a canary leaked and a topic is set) publish one message. Returns what it did. */
export async function publish(a: PublishArgs, deps: { s3: Sender; sns?: Sender; presign: Presign }): Promise<{ keys: string[]; latest: string[]; notified: boolean }> {
  const summary = JSON.parse(readFileSync(resolve(a.dir, "summary.json"), "utf8")) as Summary;
  const files: UploadFile[] = [...["summary.json", "report.html", "new-failures.json"].map((name) => ({ path: resolve(a.dir, name), name })), ...a.extra.map((path) => ({ path: resolve(path), name: basename(path) }))];
  const keys = await uploadRun(deps.s3, a.bucket, a.runId, files);
  const latest = await updateLatest(deps.s3, a.bucket, a.dir);
  let notified = false;
  if (a.topic && deps.sns && summary.leaked > 0) {
    const link = await deps.presign(a.bucket, `redteam/${a.runId}/report.html`, SEVEN_DAYS);
    notified = await notifyLeaks(deps.sns, a.topic, summary, link, a.bucket);
  }
  return { keys, latest, notified };
}

async function main(): Promise<void> {
  const a = parsePublishArgs(process.argv.slice(2));
  const s3 = new S3Client({});
  const sns = a.topic ? new SNSClient({}) : undefined;
  const r = await publish(a, { s3, ...(sns ? { sns } : {}), presign: defaultPresign(s3) });
  console.log(`uploaded ${r.keys.length} files to s3://${a.bucket}/redteam/${a.runId}/ and updated redteam/latest/${r.notified ? "; alarm topic notified" : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
