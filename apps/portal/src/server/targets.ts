import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CompatibilityInfo, ProjectInfo, RegisteredTarget, RouteInfo } from "../shared/types";
import { ARTIFACT_DIR, HOST, PORT, PUBLIC_BASE_URL } from "./config";
import { readStore, writeStore } from "./store";
import { validateHtml } from "../html/validate";

export interface AddUrlTargetInput {
  url?: string;
  name?: string;
}

export interface AddHtmlTargetInput {
  file?: string;
  name?: string;
  artifactKind?: string;
  tags?: string[];
}

export async function listTargets(): Promise<RegisteredTarget[]> {
  const store = await readStore();
  return Object.values(store.targets).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTarget(id: string): Promise<RegisteredTarget | null> {
  const store = await readStore();
  return store.targets[id] ?? null;
}

export async function addUrlTarget(input: AddUrlTargetInput): Promise<ProjectInfo> {
  if (!input.url) throw new Error("url is required");
  const url = new URL(input.url);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("url must be http or https");
  const now = new Date().toISOString();
  const name = input.name?.trim() || url.hostname;
  const id = stableTargetId("site", `${name}:${url.href}`);
  const target: RegisteredTarget = {
    id,
    name,
    targetKind: "website",
    url: url.href,
    createdAt: now,
    updatedAt: now
  };
  const store = await readStore();
  store.targets[id] = { ...store.targets[id], ...target, createdAt: store.targets[id]?.createdAt ?? now };
  await writeStore(store);
  return targetToProject(store.targets[id]);
}

export async function addHtmlTarget(input: AddHtmlTargetInput): Promise<{ project: ProjectInfo; validation: Awaited<ReturnType<typeof validateHtml>> }> {
  if (!input.file) throw new Error("file is required");
  const source = path.resolve(input.file);
  const validation = await validateHtml(source);
  if (!validation.valid) throw new Error(`HTML validation failed: ${validation.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join("; ")}`);

  const html = await fs.readFile(source);
  const hash = crypto.createHash("sha256").update(html).digest("hex").slice(0, 12);
  const title = validation.stats.title || path.basename(source, path.extname(source));
  const name = input.name?.trim() || title;
  const id = stableTargetId("html", `${name}:${source}:${hash}`);
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  const artifactPath = path.join(ARTIFACT_DIR, `${id}.html`);
  await fs.copyFile(source, artifactPath);

  const now = new Date().toISOString();
  const target: RegisteredTarget = {
    id,
    name,
    targetKind: "html-artifact",
    artifactPath,
    sourceFile: source,
    hash,
    title: validation.stats.title,
    validation,
    tags: input.tags?.map((tag) => tag.trim()).filter(Boolean) ?? [],
    artifactKind: input.artifactKind?.trim() || undefined,
    createdAt: now,
    updatedAt: now
  };
  const store = await readStore();
  store.targets[id] = { ...store.targets[id], ...target, createdAt: store.targets[id]?.createdAt ?? now };
  await writeStore(store);
  return { project: targetToProject(store.targets[id]), validation };
}

export async function removeTarget(id: string): Promise<{ removed: boolean; target?: RegisteredTarget }> {
  const store = await readStore();
  const target = store.targets[id];
  if (!target) return { removed: false };
  delete store.targets[id];
  await writeStore(store);
  return { removed: true, target };
}

export async function registeredTargetProjects(now = Date.now()): Promise<ProjectInfo[]> {
  const targets = await listTargets();
  return targets.map((target) => targetToProject(target, now));
}

export async function artifactFileForId(id: string): Promise<string | null> {
  const target = await getTarget(id);
  if (target?.targetKind !== "html-artifact" || !target.artifactPath) return null;
  return target.artifactPath;
}

function targetToProject(target: RegisteredTarget, now = Date.now()): ProjectInfo {
  const updatedAt = new Date(now).toISOString();
  if (target.targetKind === "website") {
    const route: RouteInfo = {
      mode: "direct",
      url: target.url ?? "",
      available: Boolean(target.url),
      label: "Website",
      statusCode: null,
      message: "Registered website target."
    };
    return {
      id: target.id,
      name: target.name,
      targetKind: "website",
      port: 0,
      host: "",
      sourcePath: null,
      command: "nib registered website target",
      framework: "Website",
      url: target.url,
      status: "online",
      statusCode: null,
      contentType: "text/html",
      openPath: target.url ?? "",
      directUrl: target.url ?? "",
      routes: { direct: route, pathProxy: route },
      preferredRoute: "direct",
      compatibility: compatibility("Website target", updatedAt),
      lastSeenAt: updatedAt,
      screenshots: emptyScreenshots(),
      virtual: true
    };
  }

  const route: RouteInfo = {
    mode: "pathProxy",
    url: `/artifacts/${target.id}/`,
    available: true,
    label: "Artifact",
    statusCode: 200,
    message: "Registered HTML artifact served through nib."
  };
  return {
    id: target.id,
    name: target.name,
    targetKind: "html-artifact",
    port: PORT,
    host: HOST,
    sourcePath: target.artifactPath ? path.dirname(target.artifactPath) : null,
    command: "nib registered html artifact",
    framework: "HTML Artifact",
    artifactPath: target.artifactPath,
    artifactKind: target.artifactKind,
    status: "online",
    statusCode: 200,
    contentType: "text/html",
    openPath: route.url,
    directUrl: `${PUBLIC_BASE_URL}${route.url}`,
    routes: { pathProxy: route },
    preferredRoute: "pathProxy",
    compatibility: compatibility("HTML artifact target", updatedAt),
    lastSeenAt: updatedAt,
    screenshots: emptyScreenshots(),
    virtual: true
  };
}

function compatibility(message: string, updatedAt: string): CompatibilityInfo {
  return {
    level: "excellent",
    checks: [{ id: "registered-target", label: "Registered target", status: "pass", message }],
    updatedAt
  };
}

function emptyScreenshots(): ProjectInfo["screenshots"] {
  return {
    phone: { viewport: "phone", url: null, capturedAt: null, error: null, width: 390, height: 844 },
    tablet: { viewport: "tablet", url: null, capturedAt: null, error: null, width: 820, height: 1180 },
    desktop: { viewport: "desktop", url: null, capturedAt: null, error: null, width: 1440, height: 1000 }
  };
}

function stableTargetId(prefix: string, key: string): string {
  const slug = key
    .split(":")[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 34);
  const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
  return `${prefix}-${slug || "target"}-${hash}`;
}
