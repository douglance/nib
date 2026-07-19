import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promisify } from "node:util";
import packageJson from "../../package.json" with { type: "json" };
import type { CodeStateSnapshot, GitStateSnapshot, ProjectInfo } from "../shared/types";

const execFileAsync = promisify(execFile);

export async function captureCodeState(project: ProjectInfo, appPath = "/"): Promise<CodeStateSnapshot> {
  const route = project.routes[project.preferredRoute] ?? project.routes.pathProxy ?? Object.values(project.routes)[0];
  const git = project.sourcePath ? await captureGitState(project.sourcePath) : null;
  const runtime = {
    projectId: project.id,
    projectName: project.name,
    sourcePath: project.sourcePath,
    routeMode: route?.mode ?? project.preferredRoute,
    routeUrl: route?.url ?? project.openPath,
    appPath: normalizeAppPath(appPath),
    port: project.port,
    processCommand: project.command,
    portalVersion: packageJson.version
  };
  const fingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify({ runtime, git }))
    .digest("hex");

  return {
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    runtime,
    git,
    fingerprint
  };
}

export function compareCodeStates(requested: CodeStateSnapshot, current: CodeStateSnapshot): string | null {
  if (requested.fingerprint === current.fingerprint) return null;
  if (requested.git && current.git) {
    if (requested.git.head !== current.git.head) return "Git HEAD changed since this feedback was requested.";
    if (requested.git.diffHash !== current.git.diffHash) return "Working tree diff changed since this feedback was requested.";
    if (requested.git.dirty !== current.git.dirty) return "Working tree dirty state changed since this feedback was requested.";
  }
  if (requested.runtime.port !== current.runtime.port) return "The project is running on a different port.";
  if (requested.runtime.routeUrl !== current.runtime.routeUrl) return "The project route changed.";
  if (requested.runtime.processCommand !== current.runtime.processCommand) return "The project process command changed.";
  return "Runtime or code state changed since this feedback was requested.";
}

async function captureGitState(sourcePath: string): Promise<GitStateSnapshot | null> {
  try {
    const repoRoot = (await git(sourcePath, ["rev-parse", "--show-toplevel"])).trim();
    const [branch, head, status, diff] = await Promise.all([
      git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).then((value) => value.trim()).catch(() => null),
      git(repoRoot, ["rev-parse", "HEAD"]).then((value) => value.trim()).catch(() => null),
      git(repoRoot, ["status", "--short"]).catch(() => ""),
      git(repoRoot, ["diff", "--no-ext-diff"]).catch(() => "")
    ]);
    const statusSummary = summarizeStatus(status);
    return {
      repoRoot,
      branch,
      head,
      dirty: status.trim().length > 0,
      diffHash: crypto.createHash("sha256").update(diff).digest("hex"),
      statusSummary
    };
  } catch {
    return null;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: 4000,
    maxBuffer: 1024 * 1024 * 4
  });
  return stdout;
}

function summarizeStatus(status: string): string {
  const lines = status.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return "clean";
  return lines.slice(0, 10).join("\n") + (lines.length > 10 ? `\n... ${lines.length - 10} more` : "");
}

function normalizeAppPath(appPath: string): string {
  if (!appPath.trim()) return "/";
  return appPath.startsWith("/") ? appPath : `/${appPath}`;
}
