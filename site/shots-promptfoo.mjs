// Screenshots of the promptfoo HTML report. Run from the repo root, after:
//   node_modules/.bin/... or: npx promptfoo@0.124.1 eval -c promptfoo/guard.yaml -o promptfoo/out/offline.html   (Node 22.22+)
import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: "light" })).newPage();
await p.goto(`file://${process.cwd()}/promptfoo/out/offline.html`, { waitUntil: "load" });
await p.waitForTimeout(2500);
await p.screenshot({ path: "site/img/pf-1-offline.png", fullPage: false });
await p.setViewportSize({ width: 1360, height: 760 });
await p.locator("input").first().fill("base64");
await p.waitForTimeout(1500);
await p.evaluate(() => window.scrollTo(0, 380));
await p.waitForTimeout(500);
await p.screenshot({ path: "site/img/pf-2-attack.png", fullPage: false });
await b.close();
