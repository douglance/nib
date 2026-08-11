import {
  expect,
  expectAccount,
  signInWithMagicLink,
  test,
  uniqueEmail,
} from "./fixtures";

test("a discoverable passkey signs the account back in", async ({
  context,
  page,
  consoleErrors: _consoleErrors,
}, testInfo) => {
  const email = uniqueEmail(testInfo, "passkey");
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await signInWithMagicLink(page, email);
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByRole("status")).toHaveText("Passkey added.");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: "Use a passkey" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expectAccount(page, email);
});
