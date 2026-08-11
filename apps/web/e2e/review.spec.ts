import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  expect,
  idempotentHeaders,
  publicOrigin,
  signInWithMagicLink,
  test,
  uniqueEmail,
} from "./fixtures";

const reviewPng = readFileSync(new URL("../site/src/generated-ui-hero.png", import.meta.url));

test("an image request crosses the account gateway and returns a structured guest decision", async ({
  page,
  consoleErrors: _consoleErrors,
}, testInfo) => {
  const email = uniqueEmail(testInfo, "review");
  await signInWithMagicLink(page, email);

  const createResponse = await page.request.post("/v1/requests", {
    headers: idempotentHeaders(),
    data: {
      formatVersion: "1.0",
      title: "Approve the checkout image",
      description: "Check the primary checkout image and request the needed decision.",
      source: { type: "automation", system: "playwright-e2e" },
      subject: { type: "image", name: "checkout.png" },
      artifacts: [],
      decision: { type: "approval", prompt: "Should this image ship?" },
    },
  });
  const createBody = await createResponse.text();
  expect(createResponse.status(), createBody).toBe(201);
  const created = JSON.parse(createBody) as {
    request: { id: string };
    reviewLink: string;
  };
  expect(created.reviewLink).toMatch(/^\/t\/wsp_[^/]+\/r\/[^#]+#token=/);

  const initiateResponse = await page.request.post(
    `/v1/requests/${created.request.id}/artifacts`,
    {
      headers: idempotentHeaders(),
      data: {
        name: "checkout.png",
        contentType: "image/png",
        bytes: reviewPng.byteLength,
        sha256: createHash("sha256").update(reviewPng).digest("hex"),
        metadata: { role: "primary" },
      },
    },
  );
  expect(initiateResponse.status()).toBe(201);
  const artifact = ((await initiateResponse.json()) as { artifact: { id: string } })
    .artifact;
  const uploadResponse = await page.request.post(
    `/v1/requests/${created.request.id}/artifacts/${artifact.id}/complete`,
    {
      headers: {
        "content-type": "application/octet-stream",
        "idempotency-key": crypto.randomUUID(),
      },
      data: reviewPng,
    },
  );
  expect(uploadResponse.status()).toBe(200);

  await page.context().clearCookies();
  await page.goto(`${publicOrigin}${created.reviewLink}`);
  await expect(page.getByRole("heading", { name: "Approve the checkout image" })).toBeVisible();
  await expect(page.getByRole("img", { name: "checkout.png" })).toBeVisible();
  await page.getByLabel("Reviewer note").fill("Keep the current payment selector.");
  await page.getByRole("button", { name: "Request changes" }).click();
  await expect(page.getByRole("status")).toHaveText("Sent.");
  await testInfo.attach("guest-image-review", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });

  await signInWithMagicLink(page, email);
  const snapshotResponse = await page.request.get(`/v1/requests/${created.request.id}`);
  expect(snapshotResponse.status()).toBe(200);
  expect((await snapshotResponse.json()) as object).toMatchObject({
    status: "changes_requested",
    decision: {
      outcome: "changes_requested",
      comment: "Keep the current payment selector.",
    },
  });
});
