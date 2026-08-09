import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CreateRequestInput } from "@nib/sdk";
import NibPlaywrightReporter, { artifactsFromAttachments } from "../src/index.ts";

test("maps screenshots, videos, and traces to protocol artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nib-playwright-"));
  const screenshot = join(dir, "failure.png");
  const video = join(dir, "run.webm");
  const trace = join(dir, "trace.zip");
  await writeFile(screenshot, Buffer.from("png"));
  await writeFile(video, Buffer.from("video"));
  await writeFile(trace, Buffer.from("trace"));

  const artifacts = await artifactsFromAttachments([
    { name: "screenshot", contentType: "image/png", path: screenshot },
    { name: "video", contentType: "video/webm", path: video },
    { name: "trace", contentType: "application/zip", path: trace },
    { name: "stdout", contentType: "text/plain", body: "details" },
  ]);

  assert.deepEqual(
    artifacts.map((artifact) => artifact.type),
    ["image", "video", "file", "file"],
  );
  assert.equal(artifacts[0].source.type, "embedded");
  assert.equal(artifacts[0].source.byteLength, 3);
  assert.match(artifacts[0].source.sha256, /^[a-f0-9]{64}$/);
});

test("reporter creates a request with test, browser, and device metadata", async () => {
  const requests: CreateRequestInput[] = [];
  const reporter = new NibPlaywrightReporter({
    client: {
      request: async (input) => {
        requests.push(input);
        return {} as never;
      },
    },
  });

  reporter.onTestEnd(
    {
      title: "checkout",
      titlePath: () => ["spec", "checkout"],
      project: {
        name: "Mobile Safari",
        use: { browserName: "webkit", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      },
      location: { file: "checkout.spec.ts", line: 10, column: 5 },
    },
    {
      status: "failed",
      duration: 123,
      retry: 1,
      attachments: [{ name: "screenshot", contentType: "image/png", body: Buffer.from("png") }],
      errors: [{ message: "expected visible" }],
    },
  );
  await reporter.onEnd();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].source?.system, "playwright");
  assert.equal(requests[0].subject?.type, "test_result");
  assert.equal(requests[0].artifacts?.[0]?.type, "image");
  assert.deepEqual(requests[0].metadata?.browser, {
    name: "webkit",
    viewport: { width: 390, height: 844 },
  });
  assert.deepEqual(requests[0].metadata?.device, {
    isMobile: true,
    hasTouch: true,
  });
});
