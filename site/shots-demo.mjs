// Screenshots for the pipeline demonstration (run from the repo root): node site/shots-demo.mjs <failRunId> <failPr> <mainRunId>
import { chromium } from "@playwright/test";
const [failRun, failPr, mainRun] = process.argv.slice(2);
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1360, height: 1000 }, colorScheme: "light" });
const p = await ctx.newPage();
const go = async (url) => { await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }); await p.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {}); await p.waitForTimeout(2500); };
const shot = async (name, clip) => { await p.screenshot({ path: `site/img/${name}.png`, fullPage: true, clip }); console.log("saved", name); };
if (failRun) { await go(`https://github.com/jhgcc1/quizforge/actions/runs/${failRun}`); await shot("demo-1-fail-run", { x: 0, y: 180, width: 1360, height: 820 }); }
if (failPr) {
  await go(`https://github.com/jhgcc1/quizforge/pull/${failPr}`);
  const t = p.locator("text=Merging is blocked").first();
  const bb = (await t.count()) ? await t.boundingBox() : null;
  await shot("demo-2-fail-pr", bb ? { x: 100, y: Math.max(0, bb.y - 330), width: 1160, height: 640 } : { x: 0, y: 180, width: 1360, height: 900 });
}
if (mainRun) { await go(`https://github.com/jhgcc1/quizforge/actions/runs/${mainRun}`); await shot("demo-3-main-run", { x: 0, y: 180, width: 1360, height: 900 }); }
await b.close();
