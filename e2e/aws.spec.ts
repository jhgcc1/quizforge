import { expect, test } from "@playwright/test";

const user = process.env.E2E_USER ?? "";
const password = process.env.E2E_PASSWORD ?? "";

test.skip(!user || !password || !process.env.AWS_URL, "set AWS_URL, E2E_USER and E2E_PASSWORD");

test("deployed stack: Cognito sign-in -> AI generates -> answer -> score", async ({ page, context }) => {
  // 1. unauthenticated visitors are bounced to the Cognito Hosted UI (PKCE flow)
  await page.goto("/app");
  await page.waitForURL(/amazoncognito\.com/);
  expect(page.url()).toContain("code_challenge=");
  expect(page.url()).toContain("code_challenge_method=S256");

  // 2. sign in on the Hosted UI (the page renders desktop + mobile forms: take the visible one)
  await page.locator('input[name="username"]:visible').fill(user);
  await page.locator('input[name="password"]:visible').fill(password);
  await page.locator('input[name="signInSubmitButton"]:visible, button[name="signInSubmitButton"]:visible').first().click();
  await expect(page.getByRole("heading", { name: "Your quizzes" })).toBeVisible({ timeout: 60_000 });

  // tokens are httpOnly cookies, never readable by page scripts
  expect(await page.evaluate(() => document.cookie)).not.toMatch(/qf_at|qf_rt|eyJ/);
  const at = (await context.cookies()).find((c) => c.name === "qf_at");
  expect(at?.httpOnly).toBe(true);
  expect(at?.secure).toBe(true);

  // 3. real generation with the real model (wait for hydration: the button is disabled until the page is interactive)
  await expect(page.getByRole("button", { name: "Generate quiz" })).toBeEnabled();
  await page.getByLabel("Document").selectOption({ label: "Mastra README" });
  await page.getByLabel("Questions", { exact: true }).selectOption("5");
  await page.getByRole("button", { name: "Generate quiz" }).click();
  await expect(page).toHaveURL(/\/app\/quiz\/[0-9a-f-]{36}/);
  await expect(page.getByRole("heading", { name: /Ready: 5 questions/ })).toBeVisible({ timeout: 300_000 });

  // 4. take the quiz, with a reload in the middle
  await page.getByRole("button", { name: "Start quiz" }).click();
  await page.getByRole("radio").first().check();
  await expect(page.getByText("Saved ✓")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Start quiz" }).click();
  await expect(page.getByText("1/5 answered")).toBeVisible();
  await page.getByRole("button", { name: "Previous" }).click();
  await expect(page.getByRole("radio").first()).toBeChecked();
  for (let i = 1; i < 5; i++) {
    await page.getByRole("button", { name: "Next" }).click();
    const first = page.getByRole("radio").first();
    const box = page.getByRole("checkbox").first();
    if (await first.count()) await first.check();
    else await box.check();
    await expect(page.getByText("Saved ✓")).toBeVisible();
  }
  await page.getByRole("button", { name: "Submit", exact: true }).click();

  // 5. weighted score
  const score = page.getByTestId("final-score");
  await expect(score).toBeVisible();
  const value = parseFloat((await score.innerText()).split("/")[0]!);
  expect(value).toBeGreaterThanOrEqual(0);
  expect(value).toBeLessThanOrEqual(4);
  await expect(page.getByText("From the document:").first()).toBeVisible();
  console.log(`final weighted score on AWS: ${value.toFixed(2)} / 4`);

  // 6. sign out clears the session
  await page.goto("/app");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/amazoncognito\.com|\/$/);
  expect((await context.cookies()).find((c) => c.name === "qf_at")).toBeUndefined();
});
