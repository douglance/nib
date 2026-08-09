import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CreateRequestInput } from "@nib/sdk";
import { nibCypressAdapter, requestFromCypressResult } from "../src/index.ts";

test("maps Cypress results to generic protocol concepts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nib-cypress-"));
  const screenshot = join(dir, "failure.png");
  const video = join(dir, "run.mp4");
  await writeFile(screenshot, Buffer.from("png"));
  await writeFile(video, Buffer.from("video"));

  const request = await requestFromCypressResult(
    { name: "checkout.cy.ts", relative: "cypress/e2e/checkout.cy.ts" },
    {
      video,
      stats: { failures: 1, tests: 2, passes: 1, duration: 500 },
      tests: [
        {
          title: ["checkout", "submits"],
          state: "failed",
          attempts: [{ state: "failed", error: { message: "Timed out" }, screenshots: [{ path: screenshot }] }],
        },
      ],
    },
    { browser: { name: "chrome", family: "chromium", isHeadless: true }, viewportWidth: 1280, viewportHeight: 720 },
  );

  assert.equal(request?.subject?.type, "test_run");
  assert.equal(request?.artifacts?.length, 2);
  assert.deepEqual(
    request?.artifacts?.map((artifact) => artifact.type),
    ["video", "image"],
  );
  assert.equal(JSON.stringify(request).includes('"cypress"'), true);
  assert.equal(JSON.stringify(request).includes('"cypressScreenshots"'), false);
});

test("registers after:spec and submits failed runs", async () => {
  const requests: CreateRequestInput[] = [];
  let handler: ((spec: unknown, result: unknown) => unknown) | undefined;
  const adapter = nibCypressAdapter({
    client: {
      request: async (input) => {
        requests.push(input);
        return {} as never;
      },
    },
  });

  adapter((event, registered) => {
    assert.equal(event, "after:spec");
    handler = registered;
  }, {});

  await handler?.({ name: "empty.cy.ts" }, { stats: { failures: 1 }, tests: [] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].subject?.type, "test_run");
});
