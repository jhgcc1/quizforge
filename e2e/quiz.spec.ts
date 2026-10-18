/**
 * The browser test: this repository's API, worker and scorer, driven through the REAL front end.
 *
 * ## This file lives here, but it drives a UI that lives somewhere else
 *
 * The front end is jhgcc1/quizforge-web. Both CI jobs pair main with main: this repository checks out the front end's
 * main, and the front end checks out this repository's main. The spec stays here because the harness around it is
 * anchored here — prepare.ts runs the real migrations from packages/db, and the assertions read @quizforge/core and
 * talk to Postgres directly. Neither package is published, so moving the spec would mean publishing them.
 *
 * ## The consequence, and how to get through it
 *
 * A change that alters the markup this file drives CANNOT be merged on either side alone:
 *
 *   a spec that only speaks the NEW markup fails against the front end's current main
 *   the CURRENT spec fails against the front end branch that introduces the new markup
 *
 * So neither repository can go first. Do it in two phases:
 *
 *   1. Here: make the spec accept BOTH markups, choosing at run time (see `isCombobox` below for a worked example,
 *      which handled the document `<select>` becoming a combobox). Merge it.
 *   2. There: merge the front end change. Its CI now picks up the tolerant spec from this main and passes.
 *   3. Here: delete the old arm.
 *
 * It is a ritual, not a trap, as long as you know it is coming — which is why it is written down here, in the file
 * you are reading when you hit it. Moving the spec to the front end would remove the ritual, at the price of
 * publishing @quizforge/core and @quizforge/db as versioned tarballs and bumping them on every change.
 *
 * ## Where it runs
 *
 * In the FRONT END's CI, not this one. There is no e2e job here any more: the test drives a UI that lives there, so
 * it belongs to the pull requests that change that UI. What covers this side is packages/contract and its boundary
 * tests, the integration suite against a real Postgres, and e2e/aws.spec.ts driving the DEPLOYED stack in a browser
 * after every deploy (the smoke step in quizforge-infra's apply.yml), with rollback.yml to go back.
 */
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { SAMPLE_CATALOG } from "@quizforge/core";

const login = async (page: Page, user: string) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/auth\/dev/); // unauthenticated -> sign-in (dev login stands in for Cognito)
  await page.getByLabel("User").fill(user);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Your quizzes" })).toBeVisible();
};

test("sign-up and social buttons exist in local mode and the sign-up path reaches the dev page and logs in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create account" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with Facebook" })).toBeVisible();

  await page.getByRole("link", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/auth\/dev\?mode=signup/);
  await expect(page.getByText("SIMULATION")).toBeVisible();
  await page.getByLabel("User").fill("new-person");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Your quizzes" })).toBeVisible();
});

test("anonymous visitors are sent to sign-in and cannot call the BFF", async ({ page, request }) => {
  await page.goto("/app/quiz/6f1d1e0c-9a0b-4c43-8a6e-1f2d3c4b5a69");
  await expect(page).toHaveURL(/\/auth\/dev/);
  const res = await request.get("/bff/v1/quizzes");
  expect(res.status()).toBe(401);
  const post = await request.post("/bff/v1/quizzes", { data: {}, headers: { "idempotency-key": "abcdefgh12345678" } });
  expect([401, 403]).toContain(post.status());
});

test("create -> generate -> answer (with reload) -> submit -> weighted score", async ({ page, context }) => {
  await login(page, "alice");

  // tokens live in httpOnly cookies only: JavaScript can't read them
  expect(await page.evaluate(() => document.cookie)).not.toMatch(/qf_at|qf_rt/);
  const cookies = await context.cookies();
  expect(cookies.find((c) => c.name === "qf_at")?.httpOnly).toBe(true);

  await expect(page.getByRole("button", { name: "Generate quiz" })).toBeEnabled(); // hydrated
  await page.getByLabel("Questions", { exact: true }).selectOption("5");
  await page.getByLabel(/Review questions with a second AI pass/).uncheck();
  await page.getByRole("button", { name: "Generate quiz" }).click();

  await expect(page).toHaveURL(/\/app\/quiz\/[0-9a-f-]{36}/);
  await expect(page.getByRole("heading", { name: /Ready: 5 questions/ })).toBeVisible(); // worker finished
  const quizUrl = page.url();

  await page.getByRole("button", { name: "Start quiz" }).click();
  await expect(page.getByText("Question 1 of 5")).toBeVisible();

  // answer Q1, reload the page, and the answer must still be there
  await page.getByRole("radio").first().check();
  await expect(page.getByText("Saved ✓")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Continue quiz" }).click(); // an attempt is open: the button says so once the history is loaded
  await expect(page.getByText("1/5 answered")).toBeVisible();
  await expect(page.getByText("Question 2 of 5")).toBeVisible(); // resumes at the first unanswered question
  await page.getByRole("button", { name: "Previous" }).click();
  await expect(page.getByRole("radio").first()).toBeChecked(); // the answer survived the reload

  // answer the rest (always the first option; the fake LLM puts the correct one at i % 4)
  for (let i = 1; i < 5; i++) {
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText(`Question ${i + 1} of 5`)).toBeVisible();
    await page.getByRole("radio").first().check();
    await expect(page.getByText("Saved ✓")).toBeVisible();
  }
  await page.getByRole("button", { name: "Submit", exact: true }).click();

  const score = page.getByTestId("final-score");
  await expect(score).toBeVisible();
  const value = parseFloat((await score.innerText()).split("/")[0]!);
  expect(value).toBeGreaterThanOrEqual(0);
  expect(value).toBeLessThanOrEqual(4);
  await expect(page.getByTestId("final-percent")).toContainText("%");
  await expect(page.getByText("From the document:").first()).toBeVisible(); // answer key + explanation revealed after submit

  // history: the dashboard shows the score next to the quiz, and the quiz page lists the result and offers a retake
  await page.goto("/app");
  await expect(page.getByText(/\d\.\d\d \/ 4/).first()).toBeVisible();
  await page.goto(quizUrl);
  await expect(page.getByRole("heading", { name: "Your results" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retake quiz" })).toBeVisible();
  await page.getByRole("button", { name: "View result" }).first().click();
  await expect(page.getByTestId("final-score")).toBeVisible();

  // a second user can't open Alice's quiz
  const other = await context.browser()!.newContext({ baseURL: "http://localhost:13000" });
  const p2 = await other.newPage();
  await login(p2, "bob");
  await p2.goto(quizUrl);
  await expect(p2.getByText("This quiz does not exist.")).toBeVisible();
  await other.close();
});

/** The picker itself. `exact` matters: the open listbox is labelled "Documents", which a loose match also finds. */
const documentBox = (page: Page) => page.getByLabel("Document", { exact: true });

/**
 * Choose a document.
 *
 * This job pairs THIS repository with the main of the front end, and the front end is replacing the document
 * `<select>` with a filtered combobox (jhgcc1/quizforge-web#10). Neither side can merge first if the spec only
 * speaks one of the two: this one would fail against the old front end, the old one fails against the new. So it
 * handles both for one release, and the `<select>` arm comes out once the front end has merged.
 */
async function isCombobox(page: Page) {
  return (await documentBox(page).getAttribute("role")) === "combobox";
}

async function chooseDocument(page: Page, title: string) {
  const box = documentBox(page);
  if (!(await isCombobox(page))) return box.selectOption({ label: title });
  await box.click();
  await box.fill(title === "Other: paste a URL…" ? "" : title);
  await page.getByRole("option", { name: title, exact: false }).first().click();
}

test("a bad source host is rejected with a clear message", async ({ page }) => {
  await login(page, "carol");
  await chooseDocument(page, "Other: paste a URL…");
  await page.getByLabel("Markdown URL").fill("https://evil.example.com/readme.md");
  await page.getByRole("button", { name: "Generate quiz" }).click();
  await expect(page.locator("p.alert")).toContainText(/host not allowed/i);
});

test("the document dropdown lists the sample catalog and explains each choice", async ({ page }) => {
  await login(page, "dave");
  const box = documentBox(page);
  const combobox = await isCombobox(page);
  if (combobox) await box.click();

  // Every curated document is offered, plus the paste-a-URL row. This is a FLOOR, not an exact count: earlier tests
  // in this same run generate quizzes, and a document that generates cleanly joins the catalogue (#98), so the list
  // grows while the suite runs.
  const rows = combobox ? page.getByRole("option") : box.locator("option");
  for (const e of SAMPLE_CATALOG) await expect(rows.filter({ hasText: e.title }).first()).toBeAttached();
  expect(await rows.count()).toBeGreaterThanOrEqual(SAMPLE_CATALOG.length + 1);

  if (combobox) {
    // Typing narrows it: that is the point of a combobox over a dropdown, and what the old test could not check.
    await box.fill("Aurora");
    expect(await page.getByRole("option").count()).toBeLessThan(SAMPLE_CATALOG.length);
    await page.getByRole("option", { name: "Biblioteca Aurora" }).click();
  } else {
    await box.selectOption({ label: "Biblioteca Aurora" });
  }
  await expect(page.locator("#doc-info")).toContainText("Portuguese");
  await expect(page.locator("#doc-info")).toContainText("Tests:");
  await expect(page.getByLabel("Markdown URL")).toHaveCount(0); // no URL to copy and paste

  await chooseDocument(page, "Other: paste a URL…");
  await expect(page.getByLabel("Markdown URL")).toBeVisible();
});

test("the browser refuses a malformed request before it reaches the network", async ({ page }) => {
  await login(page, "erin");
  let created = 0;
  await page.route("**/bff/v1/quizzes", (route) => (route.request().method() === "POST" ? (created++, route.abort()) : route.continue()));
  await chooseDocument(page, "Other: paste a URL…");
  await page.getByLabel("Markdown URL").fill("https://github.com/owner/repo/blob/main/README.md");
  await page.getByLabel("Topic (optional)").fill("x"); // the shared schema requires at least 2 characters
  await page.getByRole("button", { name: "Generate quiz" }).click();
  await expect(page.locator("p.alert")).toBeVisible();
  expect(created).toBe(0);
});

test("the quiz is ready first, and the scorer service judges it afterwards (own queue, own service)", async ({ page }) => {
  await login(page, "frank");
  await expect(page.getByRole("button", { name: "Generate quiz" })).toBeEnabled();
  await page.getByRole("button", { name: "Generate quiz" }).click();
  await expect(page).toHaveURL(/\/app\/quiz\/[0-9a-f-]{36}/);
  const quizId = page.url().split("/").pop()!;
  await expect(page.getByRole("heading", { name: /Ready: \d questions/ })).toBeVisible({ timeout: 60_000 });

  // The user already has the quiz. The judge scores arrive on their own, written by a different process.
  const db = new pg.Client({ connectionString: "postgres://quizforge:quizforge@localhost:5433/quizforge_e2e" });
  await db.connect();
  try {
    await expect
      .poll(async () => (await db.query("select evaluator from eval_scores where target_id = $1", [quizId])).rows.map((r) => r.evaluator as string), { timeout: 40_000, intervals: [500, 1000] })
      .toEqual(expect.arrayContaining(["quality_overall", "judge_overall", "grounded", "lint_pass"])); // every score comes from the scorer service: the worker saves the quiz and no scores
    const job = (await db.query("select scored_at, scoring_attempts from generation_jobs where quiz_id = $1", [quizId])).rows[0];
    expect(job.scored_at).not.toBeNull();
    expect(job.scoring_attempts).toBe(1);
  } finally {
    await db.end();
  }
});
