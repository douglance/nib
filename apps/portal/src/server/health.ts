import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HealthResponse } from "../shared/types";
import { LOCAL_BASE_URL, PUBLIC_BASE_URL } from "./config";
import { discoverProjects } from "./discovery";

const execFileAsync = promisify(execFile);
const startedAt = Date.now();

export async function getHealth(): Promise<HealthResponse> {
  const [projects, tailscaleServe] = await Promise.all([discoverProjects(), readTailscaleServeStatus()]);
  const warnings: string[] = [];

  if (tailscaleServe !== "configured") {
    warnings.push("Tailscale Serve is not confirmed for the HTTPS home-screen URL.");
  }

  if (projects.length === 0) {
    warnings.push("No active project servers were found.");
  }

  const onlineProjectCount = projects.filter((project) => project.status === "online").length;

  return {
    ok: warnings.length === 0,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    publicBaseUrl: PUBLIC_BASE_URL,
    localUrl: LOCAL_BASE_URL,
    tailscaleServe,
    projectCount: projects.length,
    onlineProjectCount,
    generatedAt: new Date().toISOString(),
    warnings
  };
}

async function readTailscaleServeStatus(): Promise<HealthResponse["tailscaleServe"]> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["serve", "status"], { timeout: 2000 });
    return stdout.includes(PUBLIC_BASE_URL) && stdout.includes("127.0.0.1:4070") ? "configured" : "not_configured";
  } catch {
    return "unknown";
  }
}
