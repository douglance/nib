import { expect, privateOrigin, signInWithMagicLink, test, uniqueEmail } from "./fixtures";

test("an expert token is shown once, scoped, and revocable", async ({ page }, testInfo) => {
  const email = uniqueEmail(testInfo, "expert-token");
  await signInWithMagicLink(page, email);

  await page.getByLabel("Token name").fill("Read-only review agent");
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByText("Copy this token now.")).toBeVisible();
  const token = (await page.locator("[data-token-value]").textContent()) ?? "";
  expect(token).toMatch(/^nib_pat_[0-9a-f]{32}_[A-Za-z0-9_-]+$/);
  await expect(page.getByText("Read-only review agent")).toBeVisible();

  const read = await page.request.get(`${privateOrigin}/api/requests`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(read.status()).toBe(200);

  const write = await page.request.post(`${privateOrigin}/api/feedback`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: { message: "must not be accepted" },
  });
  expect(write.status()).toBe(403);

  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("No active tokens.")).toBeVisible();
  const revoked = await page.request.get(`${privateOrigin}/api/requests`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(revoked.status()).toBe(401);
});
