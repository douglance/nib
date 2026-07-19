import { discoverProjects } from "./discovery";

export interface KillProjectResult {
  projectId: string;
  name: string;
  processId: number;
  killed: boolean;
  signals: string[];
  stillRunning: boolean;
}

export async function killProject(projectId: string): Promise<KillProjectResult> {
  const project = (await discoverProjects(true)).find((item) => item.id === projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  if (project.targetKind !== "local-app" || project.virtual || !project.processId || !project.killable) {
    throw new Error(`Project is not killable: ${project.name}`);
  }
  if (project.processId === process.pid) {
    throw new Error("Refusing to kill the prtl server process.");
  }

  const signals: string[] = [];
  sendSignal(project.processId, "SIGTERM");
  signals.push("SIGTERM");
  let stillRunning = await waitForExit(project.processId, 1200);

  if (stillRunning) {
    sendSignal(project.processId, "SIGKILL");
    signals.push("SIGKILL");
    stillRunning = await waitForExit(project.processId, 1600);
  }

  await discoverProjects(true);
  return {
    projectId: project.id,
    name: project.name,
    processId: project.processId,
    killed: !stillRunning,
    signals,
    stillRunning
  };
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code !== "ESRCH") throw error;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isRunning(pid)) return false;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return isRunning(pid);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code === "ESRCH") return false;
    return true;
  }
}
