import fs from "node:fs/promises";
import path from "node:path";
import type { HtmlArtifactSummary, RegisteredTarget } from "../shared/types";
import { ARTIFACT_DIR } from "./config";
import { createScreenshotMapForProject } from "./discovery";
import { listTargets, getTarget } from "./targets";

export async function listHtmlArtifacts(): Promise<HtmlArtifactSummary[]> {
  const targets = (await listTargets()).filter((target) => target.targetKind === "html-artifact" && target.artifactPath);
  return Promise.all(targets.map((target) => summarizeArtifact(target)));
}

export async function getHtmlArtifact(id: string): Promise<HtmlArtifactSummary | null> {
  const target = await getTarget(id);
  if (!target || target.targetKind !== "html-artifact" || !target.artifactPath) return null;
  return summarizeArtifact(target);
}

async function summarizeArtifact(target: RegisteredTarget): Promise<HtmlArtifactSummary> {
  return {
    id: target.id,
    name: target.name,
    title: target.title ?? target.validation?.stats.title ?? target.name,
    artifactKind: target.artifactKind,
    artifactPath: target.artifactPath ?? "",
    sourceFile: target.sourceFile,
    hash: target.hash,
    tags: target.tags ?? [],
    validation: target.validation ?? null,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
    viewerUrl: `/view/${encodeURIComponent(target.id)}`,
    artifactUrl: `/artifacts/${encodeURIComponent(target.id)}/`,
    screenshots: await createScreenshotMapForProject(target.id)
  };
}

export async function exportHtmlArtifact(id: string, outDir: string): Promise<{ id: string; outDir: string; files: string[] }> {
  const artifact = await getHtmlArtifact(id);
  if (!artifact) throw new Error(`HTML artifact not found: ${id}`);
  await fs.mkdir(outDir, { recursive: true });
  const htmlOut = path.join(outDir, "artifact.html");
  const metaOut = path.join(outDir, "metadata.json");
  const indexOut = path.join(outDir, "index.html");
  await fs.copyFile(artifact.artifactPath, htmlOut);
  await fs.writeFile(metaOut, JSON.stringify(artifact, null, 2), "utf8");
  await fs.writeFile(indexOut, exportIndexHtml(artifact), "utf8");
  return { id, outDir, files: [htmlOut, metaOut, indexOut] };
}

function exportIndexHtml(artifact: HtmlArtifactSummary): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(artifact.name)}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; background: #11151b; color: #f7f8fa; }
    body { margin: 0; }
    header { padding: 14px 16px; border-bottom: 1px solid #2c333d; background: #151a21; }
    h1 { margin: 0; font-size: 1rem; }
    p { margin: 4px 0 0; color: #b7c1cf; }
    iframe { width: 100%; height: calc(100dvh - 70px); border: 0; background: white; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(artifact.name)}</h1>
    <p>${escapeHtml(artifact.artifactKind ?? "html-artifact")} · ${escapeHtml(artifact.hash ?? "no hash")}</p>
  </header>
  <iframe title="${escapeHtml(artifact.name)}" src="artifact.html"></iframe>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
