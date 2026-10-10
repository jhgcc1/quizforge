// Screenshots of the PUBLIC GitHub pages used by the architecture report (run from the repo root: node site/shots-github.mjs).
// The run ids below are examples: pick recent ones (gh run list) when you refresh the report.
import { chromium } from "@playwright/test";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1360, height: 1000 }, colorScheme: "light" });
const p = await ctx.newPage();
const go = async (url) => { await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }); await p.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {}); await p.waitForTimeout(2500); };
const shot = async (name, clip) => { await p.screenshot({ path: `site/img/${name}.png`, fullPage: true, clip }); console.log("saved", name); };

await go("https://github.com/jhgcc1/quizforge/rules/24684524");
await p.locator("text=Show additional settings").last().click().catch((e) => console.log("click", String(e).slice(0, 80)));
await p.waitForTimeout(800);
await p.screenshot({ path: "site/img/gh-5-ruleset.png", fullPage: true, clip: { x: 300, y: 940, width: 760, height: 760 } });

await b.close();
