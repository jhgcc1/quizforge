// Screenshots of the promptfoo HTML report (scripts/promptfoo.sh offline first with -o promptfoo/out/offline.html; run from the repo root).
import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1360, height: 760 }, colorScheme: "light" })).newPage();
await p.goto("file:///home/jhgcc1/int/promptfoo/out/offline.html", { waitUntil: "load" });
await p.waitForTimeout(2000);
await p.locator("input").first().fill("base64");
await p.waitForTimeout(1500);
await p.evaluate(() => window.scrollTo(0, 380));
await p.waitForTimeout(500);
await p.screenshot({ path: "site/img/pf-2-attack.png", fullPage: false });
await b.close();
