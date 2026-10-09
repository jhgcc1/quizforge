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
  await page.getByRole("button", { name: "Start quiz" }).click();
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

  // a second user can't open Alice's quiz
  const other = await context.browser()!.newContext({ baseURL: "http://localhost:13000" });
  const p2 = await other.newPage();
  await login(p2, "bob");
  await p2.goto(quizUrl);
  await expect(p2.getByText("This quiz does not exist.")).toBeVisible();
  await other.close();
});

test("a bad source host is rejected with a clear message", async ({ page }) => {
  await login(page, "carol");
  await page.getByLabel("Document").selectOption({ label: "Other: paste a URL…" });
  await page.getByLabel("Markdown URL").fill("https://evil.example.com/readme.md");
  await page.getByRole("button", { name: "Generate quiz" }).click();
  await expect(page.locator("p.alert")).toContainText(/host not allowed/i);
});

test("the document dropdown lists the sample catalog and explains each choice", async ({ page }) => {
  await login(page, "dave");
  const select = page.getByLabel("Document");
  await expect(select.locator("optgroup")).toHaveCount(2); // real READMEs, test documents
  await expect(select.locator("option")).toHaveCount(SAMPLE_CATALOG.length + 1); // + "Other: paste a URL…"
  for (const e of SAMPLE_CATALOG) await expect(select.locator("option", { hasText: e.title }).first()).toBeAttached();

  await select.selectOption({ label: "Biblioteca Aurora" });
  await expect(page.locator("#doc-info")).toContainText("Portuguese");
  await expect(page.locator("#doc-info")).toContainText("Tests:");
  await expect(page.getByLabel("Markdown URL")).toHaveCount(0); // no URL to copy and paste

  await select.selectOption({ label: "Other: paste a URL…" });
  await expect(page.getByLabel("Markdown URL")).toBeVisible();
});

test("the browser refuses a malformed request before it reaches the network", async ({ page }) => {
  await login(page, "erin");
  let created = 0;
  await page.route("**/bff/v1/quizzes", (route) => (route.request().method() === "POST" ? (created++, route.abort()) : route.continue()));
  await page.getByLabel("Document").selectOption({ label: "Other: paste a URL…" });
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
