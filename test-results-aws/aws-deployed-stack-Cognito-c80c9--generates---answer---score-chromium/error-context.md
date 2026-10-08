# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: aws.spec.ts >> deployed stack: Cognito sign-in -> AI generates -> answer -> score
- Location: e2e/aws.spec.ts:8:5

# Error details

```
Test timeout of 360000ms exceeded.
```

```
Error: page.waitForURL: Test timeout of 360000ms exceeded.
=========================== logs ===========================
waiting for navigation until "load"
  navigated to "https://dn4wo1snbdmwd.cloudfront.net/app"
  navigated to "https://dn4wo1snbdmwd.cloudfront.net/app"
============================================================
```

# Page snapshot

```yaml
- generic [active] [ref=f4e1]:
  - generic [ref=f4e2]:
    - banner [ref=f4e3]:
      - link "QuizForge" [ref=f4e4] [cursor=pointer]:
        - /url: /app
      - generic [ref=f4e5]:
        - generic "Your account id" [ref=f4e6]: 01bbb540…
        - button "Sign out" [ref=f4e7] [cursor=pointer]
    - main [ref=f4e8]:
      - heading "Your quizzes" [level=1] [ref=f4e9]
      - generic [ref=f4e10]:
        - heading "Create a quiz" [level=2] [ref=f4e11]
        - generic [ref=f4e12]:
          - generic [ref=f4e13]:
            - generic [ref=f4e14]: Document
            - combobox "Document" [ref=f4e15]:
              - option "Pipecat README" [selected]
              - option "Mastra README"
              - option "Custom URL…"
          - generic [ref=f4e16]:
            - generic [ref=f4e17]: Topic (optional)
            - textbox "Topic (optional)" [ref=f4e18]:
              - /placeholder: e.g. deployment, agents
          - generic [ref=f4e19]:
            - generic [ref=f4e20]: Questions
            - combobox "Questions" [ref=f4e21]:
              - option "5"
              - option "6" [selected]
              - option "7"
              - option "8"
          - generic [ref=f4e22]:
            - generic [ref=f4e23]: Strategy
            - combobox "Strategy" [ref=f4e24]:
              - option "Auto (pick from the document)" [selected]
              - option "Single shot (short docs)"
              - option "By section (long docs)"
        - paragraph [ref=f4e25]:
          - generic [ref=f4e26]:
            - checkbox "Review questions with a second AI pass (slower, higher quality)" [checked] [ref=f4e27]
            - text: Review questions with a second AI pass (slower, higher quality)
        - button "Generate quiz" [ref=f4e28] [cursor=pointer]
      - generic [ref=f4e29]:
        - heading "History" [level=2] [ref=f4e30]
        - list [ref=f4e31]:
          - listitem [ref=f4e32]:
            - generic [ref=f4e33]:
              - link [ref=f4e34] [cursor=pointer]:
                - /url: /app/quiz/1995b07d-6cfb-454d-93f8-08ddc9f60d07
                - strong [ref=f4e35]: mastra-ai/mastra
              - generic [ref=f4e36]: 5 questions · single-shot · 10/7/2026, 9:23:33 PM
            - generic [ref=f4e37]: ready
          - listitem [ref=f4e38]:
            - generic [ref=f4e39]:
              - link [ref=f4e40] [cursor=pointer]:
                - /url: /app/quiz/116fcf86-e1c5-47bf-9028-909c5cef032f
                - strong [ref=f4e41]: mastra-ai/mastra
              - generic [ref=f4e42]: 5 questions · single-shot · 10/7/2026, 9:17:19 PM
            - generic [ref=f4e43]: ready
          - listitem [ref=f4e44]:
            - generic [ref=f4e45]:
              - link [ref=f4e46] [cursor=pointer]:
                - /url: /app/quiz/9d5d5d08-8386-4913-8b11-d63bf4e16d88
                - strong [ref=f4e47]: mastra-ai/mastra
              - generic [ref=f4e48]: 5 questions · single-shot · 10/7/2026, 9:12:35 PM
            - generic [ref=f4e49]: ready
          - listitem [ref=f4e50]:
            - generic [ref=f4e51]:
              - link [ref=f4e52] [cursor=pointer]:
                - /url: /app/quiz/72631997-ee67-4aa2-a001-5eace4eabfca
                - strong [ref=f4e53]: pipecat-ai/pipecat
              - generic [ref=f4e54]: 5 questions · auto · 10/7/2026, 9:01:49 PM
            - generic [ref=f4e55]: failed
  - alert [ref=f4e56]
```

# Test source

```ts
  1  | import { expect, test } from "@playwright/test";
  2  | 
  3  | const user = process.env.E2E_USER ?? "";
  4  | const password = process.env.E2E_PASSWORD ?? "";
  5  | 
  6  | test.skip(!user || !password || !process.env.AWS_URL, "set AWS_URL, E2E_USER and E2E_PASSWORD");
  7  | 
  8  | test("deployed stack: Cognito sign-in -> AI generates -> answer -> score", async ({ page, context }) => {
  9  |   // 1. unauthenticated visitors are bounced to the Cognito Hosted UI (PKCE flow)
  10 |   await page.goto("/app");
  11 |   await page.waitForURL(/amazoncognito\.com/);
  12 |   expect(page.url()).toContain("code_challenge=");
  13 |   expect(page.url()).toContain("code_challenge_method=S256");
  14 | 
  15 |   // 2. sign in on the Hosted UI (the page renders desktop + mobile forms: take the visible one)
  16 |   await page.locator('input[name="username"]:visible').fill(user);
  17 |   await page.locator('input[name="password"]:visible').fill(password);
  18 |   await page.locator('input[name="signInSubmitButton"]:visible, button[name="signInSubmitButton"]:visible').first().click();
  19 |   await expect(page.getByRole("heading", { name: "Your quizzes" })).toBeVisible({ timeout: 60_000 });
  20 | 
  21 |   // tokens are httpOnly cookies, never readable by page scripts
  22 |   expect(await page.evaluate(() => document.cookie)).not.toMatch(/qf_at|qf_rt|eyJ/);
  23 |   const at = (await context.cookies()).find((c) => c.name === "qf_at");
  24 |   expect(at?.httpOnly).toBe(true);
  25 |   expect(at?.secure).toBe(true);
  26 | 
  27 |   // 3. real generation with the real model (wait for hydration: the button is disabled until the page is interactive)
  28 |   await expect(page.getByRole("button", { name: "Generate quiz" })).toBeEnabled();
  29 |   await page.getByLabel("Document").selectOption({ label: "Mastra README" });
  30 |   await page.getByLabel("Questions", { exact: true }).selectOption("5");
  31 |   await page.getByRole("button", { name: "Generate quiz" }).click();
  32 |   await expect(page).toHaveURL(/\/app\/quiz\/[0-9a-f-]{36}/);
  33 |   await expect(page.getByRole("heading", { name: /Ready: 5 questions/ })).toBeVisible({ timeout: 300_000 });
  34 | 
  35 |   // 4. take the quiz, with a reload in the middle
  36 |   await page.getByRole("button", { name: "Start quiz" }).click();
  37 |   await page.getByRole("radio").first().check();
  38 |   await expect(page.getByText("Saved ✓")).toBeVisible();
  39 |   await page.reload();
  40 |   await page.getByRole("button", { name: "Start quiz" }).click();
  41 |   await expect(page.getByText("1/5 answered")).toBeVisible();
  42 |   await page.getByRole("button", { name: "Previous" }).click();
  43 |   await expect(page.getByRole("radio").first()).toBeChecked();
  44 |   for (let i = 1; i < 5; i++) {
  45 |     await page.getByRole("button", { name: "Next" }).click();
  46 |     const first = page.getByRole("radio").first();
  47 |     const box = page.getByRole("checkbox").first();
  48 |     if (await first.count()) await first.check();
  49 |     else await box.check();
  50 |     await expect(page.getByText("Saved ✓")).toBeVisible();
  51 |   }
  52 |   await page.getByRole("button", { name: "Submit", exact: true }).click();
  53 | 
  54 |   // 5. weighted score
  55 |   const score = page.getByTestId("final-score");
  56 |   await expect(score).toBeVisible();
  57 |   const value = parseFloat((await score.innerText()).split("/")[0]!);
  58 |   expect(value).toBeGreaterThanOrEqual(0);
  59 |   expect(value).toBeLessThanOrEqual(4);
  60 |   await expect(page.getByText("From the document:").first()).toBeVisible();
  61 |   console.log(`final weighted score on AWS: ${value.toFixed(2)} / 4`);
  62 | 
  63 |   // 6. sign out clears the session
  64 |   await page.goto("/app");
  65 |   await page.getByRole("button", { name: "Sign out" }).click();
> 66 |   await page.waitForURL(/amazoncognito\.com|\/$/);
     |              ^ Error: page.waitForURL: Test timeout of 360000ms exceeded.
  67 |   expect((await context.cookies()).find((c) => c.name === "qf_at")).toBeUndefined();
  68 | });
  69 | 
```