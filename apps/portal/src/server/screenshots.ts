import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import type { ScreenshotInfo, ViewportKey } from "../shared/types";
import { LOCAL_BASE_URL, SCREENSHOT_DIR } from "./config";
import { discoverProjects } from "./discovery";
import { ensureDataDirs } from "./store";

process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = "1";

const viewports: Record<ViewportKey, { width: number; height: number }> = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 1000 }
};

export async function captureScreenshots(projectId: string): Promise<Record<ViewportKey, ScreenshotInfo>> {
  await ensureDataDirs();
  const project = (await discoverProjects()).find((item) => item.id === projectId);
  const route = project?.routes[project.preferredRoute] ?? project?.routes.pathProxy ?? Object.values(project?.routes ?? {})[0];
  const url = route?.url
    ? route.url.startsWith("http")
      ? route.url
      : `${LOCAL_BASE_URL}${route.url}`
    : `${LOCAL_BASE_URL}/p/${projectId}/`;
  const browser = await chromium.launch({ headless: true });

  try {
    const entries = await Promise.all(
      (Object.entries(viewports) as Array<[ViewportKey, { width: number; height: number }]>).map(
        async ([viewport, size]) => {
          const result = await captureViewport(browser, projectId, url, viewport, size);
          return [viewport, result] as const;
        }
      )
    );
    return Object.fromEntries(entries) as Record<ViewportKey, ScreenshotInfo>;
  } finally {
    await browser.close();
  }
}

async function captureViewport(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  projectId: string,
  url: string,
  viewport: ViewportKey,
  size: { width: number; height: number }
): Promise<ScreenshotInfo> {
      const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
      const fileName = `${projectId}-${viewport}.png`;
      const filePath = path.join(SCREENSHOT_DIR, fileName);
      try {
        await page.goto(url, {
          waitUntil: "commit",
          timeout: 5000
        });
        await page.waitForTimeout(900);
        await page.screenshot({ path: filePath, fullPage: false, timeout: 2500 });
        return {
          viewport,
          url: `/screenshots/${fileName}?t=${Date.now()}`,
          capturedAt: new Date().toISOString(),
          error: null,
          ...size
        };
      } catch (error) {
        return {
          viewport,
          url: await fileExists(filePath) ? `/screenshots/${fileName}` : null,
          capturedAt: null,
          error: error instanceof Error ? error.message : "Screenshot failed",
          ...size
        };
      } finally {
        await page.close();
      }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
