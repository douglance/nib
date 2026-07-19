import crypto from "node:crypto";
import { spawn } from "node:child_process";
import type http from "node:http";
import type { CommandEvent, CommandPreset, CommandRequest, CommandRun } from "../shared/types";
import { discoverProjects } from "./discovery";
import { readStore, writeStore } from "./store";
import { appendActivity } from "./workspace";

const activeRuns = new Map<
  string,
  {
    run: CommandRun;
    events: CommandEvent[];
    subscribers: Set<http.ServerResponse>;
  }
>();

export async function runProjectCommand(projectId: string, request: CommandRequest): Promise<CommandRun> {
  const command = request.command.trim();
  if (!command) throw new Error("Command is required");

  const project = (await discoverProjects()).find((item) => item.id === projectId);
  const cwd = request.cwd || project?.sourcePath || process.cwd();
  const run: CommandRun = {
    id: crypto.randomUUID(),
    projectId,
    command,
    cwd,
    status: "running",
    exitCode: null,
    signal: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    stdoutTail: "",
    stderrTail: ""
  };

  const state = { run, events: [] as CommandEvent[], subscribers: new Set<http.ServerResponse>() };
  activeRuns.set(run.id, state);
  emitEvent(run.id, "start", run);
  await appendActivity({ kind: "command", projectId, message: `Started: ${command}`, data: { commandId: run.id, cwd } });

  const child = spawn(command, {
    cwd,
    shell: process.env.SHELL || "/bin/zsh",
    env: process.env
  });

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    run.stdoutTail = tail(`${run.stdoutTail}${text}`);
    emitEvent(run.id, "stdout", text);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    run.stderrTail = tail(`${run.stderrTail}${text}`);
    emitEvent(run.id, "stderr", text);
  });

  child.on("error", async (error) => {
    run.status = "failed";
    run.stderrTail = tail(`${run.stderrTail}${error.message}\n`);
    finishRun(run, null, null);
    emitEvent(run.id, "error", error.message);
    await persistRun(run);
    await appendActivity({ kind: "command", projectId, message: `Failed: ${command}`, data: { commandId: run.id } });
  });

  child.on("exit", async (code, signal) => {
    run.status = code === 0 ? "exited" : "failed";
    finishRun(run, code, signal);
    emitEvent(run.id, "exit", run);
    await persistRun(run);
    await appendActivity({
      kind: "command",
      projectId,
      message: `Exited ${code ?? signal}: ${command}`,
      data: { commandId: run.id, exitCode: code, signal }
    });
    windowClose(run.id);
  });

  return run;
}

export async function listCommandRuns(projectId: string): Promise<CommandRun[]> {
  const store = await readStore();
  const stored = store.commands[projectId] ?? [];
  const active = [...activeRuns.values()].map((item) => item.run).filter((run) => run.projectId === projectId);
  const activeIds = new Set(active.map((run) => run.id));
  return [...active, ...stored.filter((run) => !activeIds.has(run.id))].slice(0, 100);
}

export function streamCommandEvents(commandId: string, res: http.ServerResponse): void {
  const state = activeRuns.get(commandId);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });

  if (!state) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: "Command is not running" })}\n\n`);
    res.end();
    return;
  }

  state.subscribers.add(res);
  for (const event of state.events) writeSse(res, event);
  res.on("close", () => state.subscribers.delete(res));
}

export async function getCommandPresets(projectId: string): Promise<CommandPreset[]> {
  const project = (await discoverProjects()).find((item) => item.id === projectId);
  const cwd = project?.sourcePath ?? process.cwd();
  const presets: CommandPreset[] = [
    { id: "pwd", label: "Print cwd", command: "pwd", cwd },
    { id: "ls", label: "List files", command: "ls -la", cwd },
    { id: "package-scripts", label: "Show package scripts", command: "node -e \"const p=require('./package.json'); console.log(p.scripts||{})\"", cwd },
    { id: "portal-health", label: "Portal health", command: "curl -k -sS https://dave.tail5d92b4.ts.net/api/health", cwd: process.cwd() },
    { id: "portal-logs", label: "Portal logs", command: "tail -80 .nib/logs/stderr.log .nib/logs/stdout.log", cwd: process.cwd() }
  ];
  return presets;
}

function emitEvent(commandId: string, type: CommandEvent["type"], data: CommandEvent["data"]): void {
  const state = activeRuns.get(commandId);
  if (!state) return;
  const event: CommandEvent = {
    commandId,
    type,
    data,
    createdAt: new Date().toISOString()
  };
  state.events.push(event);
  for (const subscriber of state.subscribers) writeSse(subscriber, event);
}

function writeSse(res: http.ServerResponse, event: CommandEvent): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function finishRun(run: CommandRun, code: number | null, signal: NodeJS.Signals | null): void {
  run.exitCode = code;
  run.signal = signal;
  run.finishedAt = new Date().toISOString();
  run.durationMs = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
}

async function persistRun(run: CommandRun): Promise<void> {
  const store = await readStore();
  const runs = store.commands[run.projectId] ?? [];
  store.commands[run.projectId] = [run, ...runs.filter((item) => item.id !== run.id)].slice(0, 100);
  await writeStore(store);
}

function windowClose(commandId: string): void {
  const state = activeRuns.get(commandId);
  if (!state) return;
  setTimeout(() => {
    for (const subscriber of state.subscribers) subscriber.end();
    activeRuns.delete(commandId);
  }, 30_000);
}

function tail(value: string, limit = 20_000): string {
  return value.length > limit ? value.slice(value.length - limit) : value;
}
