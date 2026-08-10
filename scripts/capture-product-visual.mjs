// Captures the real Nib reviewer (apps/cloudflare/src/review-page.ts) served by
// scripts/serve-review-visual.mjs, and records the request -> decision loop.
// Every asset produced here is a real browser capture of the shipped review UI.
//
// Usage: node scripts/capture-product-visual.mjs [reviewOrigin]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { chromium } from "../apps/portal/node_modules/playwright/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = process.argv[2] || "http://127.0.0.1:8767";
const assets = path.join(root, "apps/site/src");
const scratch = path.join(root, ".visual/product");
fs.mkdirSync(scratch, { recursive: true });

const checkout = `${origin}/r/req_checkout_review`;
const gate = `${origin}/r/req_release_gate`;
const token = "#token=nib_review_visual";
const note = encodeURIComponent("Index looks right. Ship it behind the flag.");

const browser = await chromium.launch();

async function clipOf(page, selector) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`missing ${selector}`);
  return box;
}

// 1. Desktop request view: the reviewer chrome around real attached evidence.
{
  const context = await browser.newContext({
    viewport: { width: 1040, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto(`${checkout}${token}`, { waitUntil: "networkidle" });
  await page.waitForSelector("#review:not([hidden])");
  await page.waitForTimeout(600);
  const header = await clipOf(page, ".request-header");
  const artifact = await clipOf(page, ".artifact-list .artifact:first-child");
  await page.screenshot({
    path: path.join(assets, "nib-review-desktop.png"),
    clip: {
      x: header.x - 24,
      y: 12,
      width: header.width + 48,
      height: artifact.y + artifact.height - 12 + 24,
    },
  });
  await context.close();
}

// 2. Decision band: the note field and the four real decision controls.
{
  const context = await browser.newContext({
    viewport: { width: 1040, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto(`${gate}?state=comment&note=${note}${token}`, {
    waitUntil: "networkidle",
  });
  await page.waitForSelector("#review:not([hidden])");
  await page.waitForTimeout(900);
  const main = await clipOf(page, "main");
  const feedback = await clipOf(page, ".feedback");
  const appLink = await clipOf(page, ".app-link");
  await page.screenshot({
    path: path.join(assets, "nib-review-decision.png"),
    clip: {
      x: main.x,
      y: feedback.y - 20,
      width: main.width,
      height: appLink.y + appLink.height - feedback.y + 40,
    },
  });
  await context.close();
}

// 3. Sent state: what the reviewer sees once the agent has its answer. Captured
// at a narrower viewport so the heading reflows inside the crop instead of
// running past its right edge.
{
  const context = await browser.newContext({
    viewport: { width: 700, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto(
    `${checkout}?state=approved&note=${note}${token}`,
    { waitUntil: "networkidle" },
  );
  await page.waitForSelector("#state.ok");
  await page.waitForFunction(
    () => document.getElementById("state").textContent.trim() === "Sent.",
    null,
    { timeout: 15000 },
  );
  await page.waitForTimeout(400);
  const main = await clipOf(page, "main");
  const description = await clipOf(page, "#description");
  await page.screenshot({
    path: path.join(assets, "nib-review-sent.png"),
    clip: {
      x: main.x,
      y: 10,
      width: main.width,
      height: description.y + description.height - 10 + 22,
    },
  });
  await context.close();
}

// 4. The same three views at a real phone breakpoint, so the marketing page can
// serve a legible capture instead of shrinking a desktop one.
async function phone(url, file, clip) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 900 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector("#review:not([hidden])");
  await page.waitForTimeout(700);
  await page.screenshot({
    path: path.join(assets, file),
    clip: await clip(page),
  });
  await context.close();
}

await phone(`${gate}${token}`, "nib-review-mobile.png", async (page) => {
  const main = await clipOf(page, "main");
  const appLink = await clipOf(page, ".app-link");
  return {
    x: 0,
    y: 0,
    width: 390,
    height: appLink.y + appLink.height + 16,
  };
});

await phone(
  `${checkout}${token}`,
  "nib-review-mobile-evidence.png",
  async (page) => {
    const artifact = await clipOf(page, ".artifact-list .artifact:first-child");
    return { x: 0, y: 0, width: 390, height: artifact.y + artifact.height + 14 };
  },
);

await phone(
  `${gate}?state=comment&note=${note}${token}`,
  "nib-review-mobile-decision.png",
  async (page) => {
    const feedback = await clipOf(page, ".feedback");
    const appLink = await clipOf(page, ".app-link");
    return {
      x: 0,
      y: feedback.y - 14,
      width: 390,
      height: appLink.y + appLink.height - feedback.y + 30,
    };
  },
);

// 5. The loop as a short film: open, read the evidence, write, decide, sent.
{
  const context = await browser.newContext({
    viewport: { width: 1040, height: 720 },
    deviceScaleFactor: 2,
    recordVideo: { dir: scratch, size: { width: 1040, height: 720 } },
  });
  const page = await context.newPage();
  await page.goto(`${checkout}${token}`, { waitUntil: "networkidle" });
  await page.waitForSelector("#review:not([hidden])");
  await page.waitForTimeout(1400);
  await page.mouse.wheel(0, 420);
  await page.waitForTimeout(1400);
  await page.mouse.wheel(0, 520);
  await page.waitForTimeout(1000);
  await page.locator("#comment").click();
  await page.locator("#comment").type("Payment selector is right. Approved.", {
    delay: 42,
  });
  await page.waitForTimeout(700);
  await page.locator('[data-outcome="approved"]').click();
  await page.waitForTimeout(700);
  await page.mouse.wheel(0, -1400);
  await page.waitForTimeout(1600);
  const video = page.video();
  await context.close();
  const webm = await video.path();
  const mp4 = path.join(assets, "nib-product-tour.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-i",
      webm,
      "-movflags",
      "+faststart",
      "-pix_fmt",
      "yuv420p",
      "-vf",
      "scale=1040:720:flags=lanczos",
      "-c:v",
      "libx264",
      "-crf",
      "26",
      "-preset",
      "slow",
      "-an",
      mp4,
    ],
    { stdio: "inherit" },
  );
  // The poster is a real frame of the recording, so the still and the film agree.
  execFileSync(
    "ffmpeg",
    ["-y", "-ss", "1.2", "-i", mp4, "-frames:v", "1", path.join(assets, "nib-product-tour-poster.png")],
    { stdio: "inherit" },
  );
}

await browser.close();
for (const asset of [
  "nib-review-desktop.png",
  "nib-review-decision.png",
  "nib-review-sent.png",
  "nib-review-mobile.png",
  "nib-review-mobile-evidence.png",
  "nib-review-mobile-decision.png",
  "nib-product-tour.mp4",
  "nib-product-tour-poster.png",
]) {
  const file = path.join(assets, asset);
  console.log(`${asset}\t${fs.statSync(file).size} bytes`);
}
