import { type Page } from "@playwright/test";
import {
  expect,
  expectAccount,
  privateOrigin,
  signInWithMagicLink,
  test,
  uniqueEmail,
} from "./fixtures";

test("one account opens the same workspace in independent browser contexts", async ({
  browser,
  page,
  consoleErrors: _consoleErrors,
}, testInfo) => {
  const email = uniqueEmail(testInfo, "account");

  await page.goto("/account");
  await expect(page).toHaveURL(/\/signin\?callbackURL=%2Faccount$/);
  await signInWithMagicLink(page, email);
  const firstWorkspace = await expectAccount(page, email);
  await testInfo.attach("account-desktop", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });

  const secondContext = await browser.newContext({ baseURL: privateOrigin });
  const secondPage = await secondContext.newPage();
  const secondErrors = collectErrors(secondPage);
  await signInWithMagicLink(secondPage, email);
  expect(await expectAccount(secondPage, email)).toBe(firstWorkspace);
  expect(secondErrors).toEqual([]);
  await secondContext.close();

  await page.reload();
  await expectAccount(page, email);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/signin$/);
  expect((await page.request.get("/api/account")).status()).toBe(401);
});

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
