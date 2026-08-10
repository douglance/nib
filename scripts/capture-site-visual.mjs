// Captures the exported Nib marketing site at exact desktop and mobile breakpoints.
// Usage: node scripts/capture-site-visual.mjs <outputDir> [baseUrl]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "../apps/portal/node_modules/playwright/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.resolve(process.argv[2] || path.join(root, ".visual/site"));
const baseUrl = process.argv[3] || "http://127.0.0.1:4321";

const viewports = [
  { name: "desktop", width: 1440, height: 900, scale: 1 },
  { name: "mobile", width: 390, height: 844, scale: 2, mobile: true },
];
const routes = [
  { name: "home", path: "/" },
  { name: "pricing", path: "/pricing" },
  { name: "docs", path: "/docs" },
  { name: "signup", path: "/signup" },
];

fs.mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch();
const overflow = [];

for (const viewport of viewports) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.scale,
    isMobile: Boolean(viewport.mobile),
    hasTouch: Boolean(viewport.mobile),
  });
  const page = await context.newPage();
  for (const route of routes) {
    await page.goto(`${baseUrl}${route.path}`, { waitUntil: "networkidle" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const report = await page.evaluate((width) => {
      const doc = document.documentElement;
      const wide = [];
      for (const node of document.querySelectorAll("body *")) {
        const box = node.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        if (box.right > width + 1 || box.left < -1) {
          wide.push({
            tag: node.tagName.toLowerCase(),
            className: typeof node.className === "string" ? node.className : "",
            left: Math.round(box.left),
            right: Math.round(box.right),
          });
        }
      }
      return {
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        offenders: wide.slice(0, 12),
      };
    }, viewport.width);
    if (report.scrollWidth > report.clientWidth || report.offenders.length) {
      overflow.push({ viewport: viewport.name, route: route.name, ...report });
    }
    await page.screenshot({
      path: path.join(outputDir, `${route.name}-${viewport.name}.png`),
      fullPage: true,
    });
    await page.screenshot({
      path: path.join(outputDir, `${route.name}-${viewport.name}-fold.png`),
      fullPage: false,
    });
  }
  await context.close();
}

await browser.close();
fs.writeFileSync(
  path.join(outputDir, "overflow.json"),
  `${JSON.stringify(overflow, null, 2)}\n`,
);
console.log(JSON.stringify(overflow, null, 2));
console.log(`captured to ${outputDir}`);
