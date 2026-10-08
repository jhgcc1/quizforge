#!/usr/bin/env node
/**
 * Takes screenshots of the Langfuse pages used by the architecture page (site/img/langfuse-*.png).
 *   node scripts/langfuse-shots.mjs
 * It opens a VISIBLE browser: sign in to Langfuse there yourself (the script never sees your password).
 * When the project page loads, it captures the pages one by one and closes. Nothing is committed (site/ is git-ignored).
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const P = process.env.LANGFUSE_PROJECT_URL ?? "https://us.cloud.langfuse.com/project/cmuyh1njb00yxad0j2ixxfwnq";
const report = JSON.parse(readFileSync(`${root}/docs/eval/structure-comparison.json`, "utf8"));
const lf = report.langfuse ?? {};
const trace = report.cells.find((c) => c.ok && c.traceId && c.structure === "critique-loop" && c.trail.some((t) => t.includes("revise")));
const runIds = (lf.runs && report.variants.filter((v) => /baseline$/.test(v.id)).map((v) => lf.runs[(v.langfuseRuns ?? [])[0]]).filter(Boolean)) || [];

const pages = [
  ["langfuse-1-traces.png", `${P}/traces`],
  ["langfuse-2-trace.png", trace ? `${P}/traces/${trace.traceId}` : `${P}/traces`],
  ["langfuse-3-scores.png", `${P}/scores`],
  ["langfuse-4-datasets.png", `${P}/datasets`],
  ["langfuse-5-compare.png", lf.datasetId && runIds.length ? `${P}/datasets/${lf.datasetId}/compare?${runIds.map((r) => `runs=${r}`).join("&")}` : `${P}/datasets`],
  ["langfuse-6-models.png", `${P}/settings/models`],
  ["langfuse-7-dashboards.png", `${P}/dashboards`],
];

mkdirSync(`${root}/site/img`, { recursive: true });
const browser = await chromium.launch({ headless: false });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(`${P}/traces`);
console.log("Sign in to Langfuse in the browser window that just opened. Waiting up to 10 minutes...");
// "signed in" = on a project page, no sign-in form, and stable for 5 seconds (the project URL flashes before the redirect to /auth/sign-in)
const signedIn = async () => !page.url().includes("/auth/") && page.url().includes("/project/") && (await page.getByText("Sign in to your account").count()) === 0 && (await page.getByText("You do not have access").count()) === 0;
let stable = 0;
for (let i = 0; i < 600 && stable < 5; i++) {
  await page.waitForTimeout(1000);
  stable = (await signedIn().catch(() => false)) ? stable + 1 : 0;
}
if (stable < 5) throw new Error("Not signed in within 10 minutes");
console.log("Signed in. Capturing...");

for (const [file, url] of pages) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(2500); // charts and tables render after the data arrives
  if (!(await signedIn())) throw new Error(`${file}: not a signed-in page (${page.url()}), nothing saved for it`);
  await page.screenshot({ path: `${root}/site/img/${file}` });
  console.log(`saved site/img/${file}`);
}
await browser.close();
console.log("Done. Rebuild the page: cd site && python3 build.py");
