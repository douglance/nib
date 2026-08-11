import { expect, test as base, type Page, type TestInfo } from "@playwright/test";

export const privateOrigin = "http://localhost:8789";
export const publicOrigin = "http://localhost:8790";
const e2eSecret = "nib-e2e-local-only";

type Fixtures = {
  consoleErrors: string[];
};

export const test = base.extend<Fixtures>({
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await use(errors);
    expect(errors, "browser console and page errors").toEqual([]);
  },
});

export { expect };

export function uniqueEmail(testInfo: TestInfo, prefix: string): string {
  const safeProject = testInfo.project.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `${prefix}-${safeProject}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
}

export async function requestMagicLink(
  page: Page,
  email: string,
  openSignIn = true,
): Promise<string> {
  if (openSignIn) await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Check your email. The link expires in 10 minutes.",
  );

  await expect
    .poll(async () => {
      const response = await page.request.get(
        `${privateOrigin}/__e2e__/magic-link?email=${encodeURIComponent(email)}`,
        { headers: { "x-nib-e2e-secret": e2eSecret } },
      );
      if (!response.ok()) return "";
      const payload = (await response.json()) as { url?: string };
      return payload.url ?? "";
    })
    .toMatch(/^http:\/\/localhost:8789\/api\/auth\/magic-link\/verify\?/);

  const response = await page.request.get(
    `${privateOrigin}/__e2e__/magic-link?email=${encodeURIComponent(email)}`,
    { headers: { "x-nib-e2e-secret": e2eSecret } },
  );
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { url: string }).url;
}

export async function signInWithMagicLink(page: Page, email: string): Promise<void> {
  const magicLink = await requestMagicLink(page, email);
  await page.goto(magicLink);
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { name: "Your Nib follows you." })).toBeVisible();
  await expect(page.locator("[data-account-email]")).toHaveText(email);
  await expect(page.locator("[data-account-workspace]")).not.toHaveText("Loading");
}

export async function expectAccount(page: Page, email: string): Promise<string> {
  await expect(page.locator("[data-account-email]")).toHaveText(email);
  const workspace = page.locator("[data-account-workspace]");
  await expect(workspace).not.toHaveText("Loading");
  return (await workspace.textContent()) ?? "";
}

export function idempotentHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "idempotency-key": crypto.randomUUID(),
  };
}
