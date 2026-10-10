// Screenshot of the failing case in the promptfoo report of the demo (node site/shots-promptfoo-fail.mjs, after running promptfoo with the demo README into promptfoo/out/demo-fail.html)
import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1360, height: 820 }, colorScheme: "light" })).newPage();
await p.goto(`file://${process.cwd()}/promptfoo/out/demo-fail.html`, { waitUntil: "load" });
await p.waitForTimeout(2500);
await p.locator("input").first().fill("demo-injection");
await p.waitForTimeout(1500);
await p.evaluate(() => window.scrollTo(0, 200));
await p.waitForTimeout(500);
await p.screenshot({ path: "site/img/demo-4-promptfoo-fail.png", fullPage: false });
await b.close();
