import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  CompatibilityCheck,
  CompatibilityInfo,
  ProjectInfo,
  RouteInfo,
  RouteMode,
  ScreenshotInfo,
  ViewportKey
} from "../shared/types";
import {
  HOST,
  PORT,
  PUBLIC_BASE_URL,
  SCREENSHOT_DIR,
  TAILSCALE_HOSTNAME,
  TAILSCALE_IP,
  ignoredCommandFragments,
  ignoredPorts
} from "./config";
import { probeHttp } from "./http";
import { readStore, writeStore } from "./store";
import { registeredTargetProjects } from "./targets";

const execFileAsync = promisify(execFile);

interface Listener {
  commandName: string;
  pid: number;
  host: string;
  bindHost: string;
  port: number;
  command: string | null;
}

const viewports: Record<ViewportKey, { width: number; height: number }> = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 1000 }
};

let projectCache: ProjectInfo[] = [];
let cacheAt = 0;

export function getCachedProject(id: string): ProjectInfo | undefined {
  return projectCache.find((project) => project.id === id);
}

export async function discoverProjects(force = false): Promise<ProjectInfo[]> {
  const now = Date.now();
  if (!force && now - cacheAt < 3000) return projectCache;

  const [listeners, processMap, store] = await Promise.all([readListeners(), readProcessMap(), readStore()]);
  const projectsById = new Map<string, ProjectInfo>();

  for (const listener of listeners) {
    const command = processMap.get(listener.pid) ?? listener.command;
    if (!shouldConsider(listener, command)) continue;

    const targetHost = listener.host === "::1" ? "[::1]" : listener.host;
    const directUrl = `http://${targetHost}:${listener.port}/`;
    const probe = await probeHttp(new URL(directUrl));
    if (!probe.ok) continue;

    const sourcePath = inferSourcePath(command);
    const baseName = inferName(sourcePath, command, listener.commandName, listener.port);
    const key = `${sourcePath ?? listener.commandName}:${listener.port}`;
    const id = stableId(key, listener.port);
    const stored = store.projects[id];
    const name = stored?.name ?? baseName;
    const publicDirectUrl = `http://${TAILSCALE_HOSTNAME}:${listener.port}/`;
    const directProbeUrl = `http://${TAILSCALE_IP}:${listener.port}/`;
    const directProbe = shouldTryDirect(listener) ? await probeHttp(new URL(directProbeUrl), 900) : null;
    const routes = buildRoutes(id, listener.port, publicDirectUrl, directProbe);
    const preferredRoute = pickPreferredRoute(stored?.preferredRoute, routes);
    const compatibility = buildCompatibility(listener, command, routes, probe.contentType);

    store.projects[id] = {
      ...stored,
      id,
      name: stored?.name,
      lastKey: key
    };

    const project: ProjectInfo = {
      id,
      name,
      targetKind: "local-app",
      processId: listener.pid,
      killable: true,
      port: listener.port,
      host: listener.host,
      sourcePath,
      command,
      framework: inferFramework(command, sourcePath, probe.contentType),
      status: "online",
      statusCode: probe.statusCode,
      contentType: probe.contentType,
      openPath: `/p/${id}/`,
      directUrl: publicDirectUrl,
      routes,
      preferredRoute,
      compatibility,
      lastSeenAt: new Date(now).toISOString(),
      screenshots: await createScreenshotMap(id)
    };
    if (!projectsById.has(project.id)) projectsById.set(project.id, project);
  }

  const targets = await registeredTargetProjects(now);
  for (const target of targets) {
    target.screenshots = await createScreenshotMap(target.id);
  }

  const projects = [...projectsById.values(), ...targets];
  projects.push(await createFeedbackLabProject(now));
  projects.sort((a, b) => a.name.localeCompare(b.name) || a.port - b.port);
  await writeStore(store);
  projectCache = projects;
  cacheAt = now;
  return projects;
}

async function createFeedbackLabProject(now: number): Promise<ProjectInfo> {
  const id = "prtl-feedback-lab";
  const route: RouteInfo = {
    mode: "pathProxy",
    url: "/lab/feedback/",
    available: true,
    label: "Lab",
    statusCode: 200,
    message: "Built-in feedback workflow lab."
  };
  return {
    id,
    name: "Feedback Lab",
    targetKind: "builtin",
    port: PORT,
    host: HOST,
    sourcePath: process.cwd(),
    command: "prtl built-in feedback lab",
    framework: "prtl",
    status: "online",
    statusCode: 200,
    contentType: "text/html",
    openPath: route.url,
    directUrl: `${PUBLIC_BASE_URL}${route.url}`,
    routes: { pathProxy: route },
    preferredRoute: "pathProxy",
    compatibility: {
      level: "excellent",
      checks: [
        {
          id: "lab",
          label: "Feedback Lab",
          status: "pass",
          message: "Always available inside prtl for feedback workflow testing."
        }
      ],
      updatedAt: new Date(now).toISOString()
    },
    lastSeenAt: new Date(now).toISOString(),
    screenshots: await createScreenshotMap(id),
    virtual: true
  };
}

export function getPortalMeta() {
  return {
    host: HOST,
    port: PORT,
    publicBaseUrl: PUBLIC_BASE_URL,
    generatedAt: new Date().toISOString()
  };
}

export async function createScreenshotMapForProject(projectId: string): Promise<Record<ViewportKey, ScreenshotInfo>> {
  const entries = await Promise.all(
    Object.entries(viewports).map(async ([viewport, size]) => {
      const fileName = `${projectId}-${viewport}.png`;
      let capturedAt: string | null = null;
      try {
        const stat = await fs.stat(path.join(SCREENSHOT_DIR, fileName));
        capturedAt = stat.mtime.toISOString();
      } catch {
        capturedAt = null;
      }
      return [
        viewport,
        {
          viewport,
          url: capturedAt ? `/screenshots/${fileName}` : null,
          capturedAt,
          error: null,
          width: size.width,
          height: size.height
        }
      ];
    })
  );
  return Object.fromEntries(entries) as Record<ViewportKey, ScreenshotInfo>;
}

const createScreenshotMap = createScreenshotMapForProject;

function shouldConsider(listener: Listener, command: string | null): boolean {
  if (ignoredPorts.has(listener.port)) return false;
  if (!["127.0.0.1", "::1", "0.0.0.0", "*", TAILSCALE_IP].includes(listener.bindHost)) return false;
  const haystack = `${listener.commandName} ${command ?? ""}`;
  const wranglerPort = command?.match(/\s--port\s+(\d+)/)?.[1];
  if (command?.includes("wrangler") && wranglerPort && Number(wranglerPort) !== listener.port) {
    return false;
  }
  if (command?.includes("workerd") && !command.includes(`entry=localhost:${listener.port}`) && !command.includes(`entry=127.0.0.1:${listener.port}`)) {
    return false;
  }
  return !ignoredCommandFragments.some((fragment) => haystack.includes(fragment));
}

async function readListeners(): Promise<Listener[]> {
  const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
  return stdout
    .split("\n")
    .slice(1)
    .map(parseLsofLine)
    .filter((listener): listener is Listener => Boolean(listener));
}

function parseLsofLine(line: string): Listener | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 9) return null;
  const commandName = parts[0];
  const pid = Number(parts[1]);
  const name = parts.slice(8).join(" ");
  const match = name.match(/(?:TCP\s+)?(.+):(\d+)\s+\(LISTEN\)$/);
  if (!match || !Number.isFinite(pid)) return null;
  let host = match[1];
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const bindHost = host;
  if (host === "*" || host === "0.0.0.0") host = "127.0.0.1";
  return {
    commandName,
    pid,
    host,
    bindHost,
    port: Number(match[2]),
    command: null
  };
}

function shouldTryDirect(listener: Listener): boolean {
  return ["*", "0.0.0.0", TAILSCALE_IP].includes(listener.bindHost);
}

function buildRoutes(
  projectId: string,
  port: number,
  publicDirectUrl: string,
  directProbe: Awaited<ReturnType<typeof probeHttp>> | null
): Partial<Record<RouteMode, RouteInfo>> {
  return {
    direct: {
      mode: "direct",
      url: publicDirectUrl,
      available: Boolean(directProbe?.ok),
      label: "Direct",
      statusCode: directProbe?.statusCode ?? null,
      message: directProbe?.ok ? "Reachable on the Tailscale network interface." : "Not reachable directly from Tailscale."
    },
    pathProxy: {
      mode: "pathProxy",
      url: `/p/${projectId}/`,
      available: true,
      label: "Proxy",
      statusCode: 200,
      message: "Available through the portal path proxy."
    },
    hostProxy: {
      mode: "hostProxy",
      url: `https://${projectId}.${TAILSCALE_HOSTNAME}/`,
      available: false,
      label: "Host proxy",
      statusCode: null,
      message: "Not configured. Use path proxy or direct route."
    }
  };
}

function pickPreferredRoute(
  storedPreference: RouteMode | undefined,
  routes: Partial<Record<RouteMode, RouteInfo>>
): RouteMode {
  if (storedPreference && routes[storedPreference]?.available) return storedPreference;
  if (routes.direct?.available) return "direct";
  if (routes.pathProxy?.available) return "pathProxy";
  return "pathProxy";
}

function buildCompatibility(
  listener: Listener,
  command: string | null,
  routes: Partial<Record<RouteMode, RouteInfo>>,
  contentType: string | null
): CompatibilityInfo {
  const checks: CompatibilityCheck[] = [
    routes.direct?.available
      ? {
          id: "direct",
          label: "Direct access",
          status: "pass",
          message: "Direct Tailscale link is available and should be most compatible."
        }
      : {
          id: "direct",
          label: "Direct access",
          status: ["127.0.0.1", "::1"].includes(listener.bindHost) ? "warn" : "fail",
          message: ["127.0.0.1", "::1"].includes(listener.bindHost)
            ? "Server is localhost-only, so portal proxy is required."
            : "Direct Tailscale probe did not succeed."
        },
    {
      id: "path-proxy",
      label: "Path proxy",
      status: routes.pathProxy?.available ? "pass" : "fail",
      message: routes.pathProxy?.available ? "Portal proxy route is available." : "Portal proxy route is unavailable."
    },
    {
      id: "compression",
      label: "Compression",
      status: "pass",
      message: "Proxy requests identity encoding and decodes compressed HTML when required."
    },
    {
      id: "websocket",
      label: "WebSocket",
      status: inferFramework(command, null, contentType) === "Vite" ? "warn" : "unknown",
      message:
        inferFramework(command, null, contentType) === "Vite"
          ? "Vite HMR uses WebSockets; path proxy supports upgrades, but direct access is preferred when available."
          : "No WebSocket requirement detected."
    }
  ];

  const hasFail = checks.some((check) => check.status === "fail");
  const hasWarn = checks.some((check) => check.status === "warn");
  const level = routes.direct?.available ? "excellent" : hasFail ? "limited" : hasWarn ? "good" : "good";
  return {
    level,
    checks,
    updatedAt: new Date().toISOString()
  };
}

async function readProcessMap(): Promise<Map<number, string>> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], { maxBuffer: 1024 * 1024 * 8 });
  const map = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (match) map.set(Number(match[1]), match[2]);
  }
  return map;
}

function inferSourcePath(command: string | null): string | null {
  if (!command) return null;
  const paths = command.match(/\/Users\/[^\s]+(?:\/[^\s]+)*/g) ?? [];
  const rawPath =
    paths.find((item) => item.includes("/Developer/") && !item.includes("/node_modules/.bin/")) ??
    paths.find((item) => item.includes("/Developer/")) ??
    paths.find((item) => !item.includes("/.nvm/") && !item.includes("/.npm/") && !item.includes("/Library/"));
  if (!rawPath) return null;
  const markers = ["/node_modules/", "/dist/", "/.next/", "/src/"];
  for (const marker of markers) {
    const index = rawPath.indexOf(marker);
    if (index > 0) return rawPath.slice(0, index);
  }
  return path.dirname(rawPath);
}

function inferName(sourcePath: string | null, command: string | null, commandName: string, port: number): string {
  if (sourcePath) return titleize(path.basename(sourcePath));
  if (command?.includes("wrangler")) return `Wrangler ${port}`;
  if (command?.includes("vite")) return `Vite ${port}`;
  return `${titleize(commandName)} ${port}`;
}

function inferFramework(command: string | null, sourcePath: string | null, contentType: string | null): string | null {
  const text = `${command ?? ""} ${sourcePath ?? ""}`.toLowerCase();
  if (text.includes("vite")) return "Vite";
  if (text.includes("next")) return "Next.js";
  if (text.includes("wrangler") || text.includes("workerd")) return "Cloudflare";
  if (text.includes("docusaurus")) return "Docusaurus";
  if (contentType?.includes("text/html")) return "Web";
  return null;
}

function stableId(key: string, port: number): string {
  const slug = titleize(key.split(":")[0] ?? "project")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 42);
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `${slug || "project"}-${port}-${hash.toString(36)}`;
}

function titleize(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
