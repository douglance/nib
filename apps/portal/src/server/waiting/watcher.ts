import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WaitingPane } from "../../shared/types";
import { createRequest } from "../requests";
import { readStore, writeStore } from "../store";
import { classifyPane, paneFingerprint } from "./detect";

const execFileAsync = promisify(execFile);
const activeWaiting = new Map<string, WaitingPane>();
const lastNotified = new Map<string, string>();

export async function scanOnce(session = "0"): Promise<WaitingPane[]> {
  if (!(await hasTmux()) || !(await hasSession(session))) {
    await persistWaitingForSession(session, []);
    return [];
  }
  const panes = await listPanes(session);
  const now = new Date().toISOString();
  const waiting: WaitingPane[] = [];
  for (const pane of panes) {
    const text = await capturePane(session, pane.paneId).catch(() => "");
    const result = classifyPane(text);
    if (!result.waiting) continue;
    const existing = activeWaiting.get(waitingKey(session, pane.paneId));
    const item: WaitingPane = {
      session,
      paneId: pane.paneId,
      window: pane.windowName,
      reason: result.reason,
      since: existing?.since ?? now,
      fingerprint: paneFingerprint(text)
    };
    waiting.push(item);
  }
  const seen = new Set(waiting.map((item) => waitingKey(item.session, item.paneId)));
  for (const id of [...activeWaiting.keys()]) {
    if (!seen.has(id)) activeWaiting.delete(id);
  }
  for (const item of waiting) activeWaiting.set(waitingKey(item.session, item.paneId), item);
  await persistWaitingForSession(session, waiting);
  return waiting;
}

export async function notifyWaitingOnce(session = "0"): Promise<{ notified: number; waiting: WaitingPane[] }> {
  const waiting = await scanOnce(session);
  let notified = 0;
  for (const pane of waiting) {
    await createRequest({
      kind: "tmux",
      title: `${pane.window} needs input`,
      prompt: pane.reason,
      body: `${pane.reason} · pane ${pane.paneId}`,
      choices: inferChoices(pane.reason),
      allowText: true,
      source: "tmux",
      priority: "high",
      tmux: {
        session,
        paneId: pane.paneId,
        windowName: pane.window,
        fingerprint: pane.fingerprint,
        reason: pane.reason
      },
      metadata: { pane }
    });
    notified += 1;
  }
  return { notified, waiting };
}

export async function getWaiting(): Promise<WaitingPane[]> {
  const store = await readStore();
  const persisted = Object.values(store.waiting ?? {});
  const waiting = persisted.length ? persisted : [...activeWaiting.values()];
  return waiting.sort((a, b) => waitingKey(a.session, a.paneId).localeCompare(waitingKey(b.session, b.paneId)));
}

export async function startWatch(options: { session?: string; intervalMs?: number; actuate?: boolean } = {}): Promise<never> {
  const session = options.session ?? "0";
  const intervalMs = options.intervalMs ?? 20000;
  for (;;) {
    const waiting = await scanOnce(session).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      return [];
    });
    for (const pane of waiting) {
      const key = `${pane.reason}:${pane.fingerprint}`;
      const id = waitingKey(pane.session, pane.paneId);
      if (lastNotified.get(id) === key) continue;
      lastNotified.set(id, key);
      await createRequest({
        kind: "tmux",
        title: `${pane.window} needs input`,
        prompt: pane.reason,
        body: `${pane.reason} · pane ${pane.paneId}`,
        choices: inferChoices(pane.reason),
        allowText: true,
        source: options.actuate ? "tmux-actuate" : "tmux",
        priority: "high",
        tmux: {
          session,
          paneId: pane.paneId,
          windowName: pane.window,
          fingerprint: pane.fingerprint,
          reason: pane.reason
        },
        metadata: { pane, actuate: Boolean(options.actuate) }
      });
    }
    for (const paneId of [...lastNotified.keys()]) {
      if (!waiting.some((pane) => waitingKey(pane.session, pane.paneId) === paneId)) lastNotified.delete(paneId);
    }
    await sleep(intervalMs);
  }
}

export async function persistWaitingForSession(session: string, waiting: WaitingPane[]): Promise<void> {
  const store = await readStore();
  const next = { ...(store.waiting ?? {}) };
  for (const [key, pane] of Object.entries(next)) {
    if (pane.session === session || key.startsWith(`${session}:`)) delete next[key];
  }
  for (const pane of waiting) {
    const normalized = { ...pane, session };
    next[waitingKey(normalized.session, normalized.paneId)] = normalized;
  }
  store.waiting = next;
  store.waitingUpdatedAt = new Date().toISOString();
  await writeStore(store);
}

function waitingKey(session: string, paneId: string): string {
  return `${session}:${paneId}`;
}

async function hasTmux(): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["-V"], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

async function hasSession(session: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["has-session", "-t", session], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

async function listPanes(session: string): Promise<Array<{ paneId: string; windowName: string; command: string }>> {
  const { stdout } = await execFileAsync("tmux", [
    "list-panes",
    "-s",
    "-t",
    session,
    "-F",
    "#{window_index}.#{pane_index}|#{window_name}|#{pane_current_command}"
  ], { encoding: "utf8" });
  return stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [paneId, windowName, command] = line.split("|");
      return { paneId, windowName: windowName || "", command: command || "" };
    });
}

async function capturePane(session: string, paneId: string): Promise<string> {
  const { stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-t", `${session}:${paneId}`], { encoding: "utf8" });
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-25)
    .join("\n");
}

function inferChoices(reason: string): string[] {
  if (reason.includes("plan approval")) return ["Approve", "Reject", "Refine"];
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
