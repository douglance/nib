import {
  expect,
  expectAccount,
  requestMagicLink,
  test,
  uniqueEmail,
} from "./fixtures";

test("CLI device authorization resumes after sign-in and yields a user bearer", async ({
  page,
  request,
  consoleErrors: _consoleErrors,
}, testInfo) => {
  const email = uniqueEmail(testInfo, "device");
  const deviceResponse = await request.post("/api/auth/device/code", {
    data: {
      client_id: "nib-cli",
      scope: "requests:read requests:write",
      name: "Playwright CLI",
    },
  });
  expect(deviceResponse.status()).toBe(200);
  const device = (await deviceResponse.json()) as {
    device_code: string;
    user_code: string;
    verification_uri_complete: string;
  };

  await page.goto(device.verification_uri_complete);
  await expect(page).toHaveURL(/\/signin\?callbackURL=/);

  const magicLink = await requestMagicLink(page, email, false);
  await page.goto(magicLink);
  await expect(page).toHaveURL(/\/device\?user_code=/);
  await expect(page.locator("[data-device-code]")).toHaveText(
    device.user_code.replaceAll("-", ""),
  );
  await page.getByRole("button", { name: "Approve this device" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Device approved. Return to your client.",
  );

  const tokenResponse = await request.post("/api/auth/device/token", {
    data: {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.device_code,
      client_id: "nib-cli",
    },
  });
  const tokenBody = await tokenResponse.text();
  expect(tokenResponse.status(), tokenBody).toBe(200);
  const token = (JSON.parse(tokenBody) as { access_token: string }).access_token;
  expect(token).toBeTruthy();

  const accountResponse = await request.get("/api/account", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(accountResponse.status()).toBe(200);
  expect((await accountResponse.json()) as { email: string }).toMatchObject({ email });

  await page.goto("/account");
  await expectAccount(page, email);
});
