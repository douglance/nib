import crypto from "node:crypto";
import type { ActivityEvent, ProjectWorkspace, ViewerState, WorkspaceNote } from "../shared/types";
import { readStore, writeStore } from "./store";

const defaultViewer: ViewerState = {
  drawer: "half",
  activeTab: "feedback",
  viewport: "fluid"
};

export async function getWorkspace(projectId: string): Promise<ProjectWorkspace> {
  const store = await readStore();
  const existing = store.workspaces[projectId];
  if (existing) {
    const workspace = normalizeWorkspace(existing);
    if (workspace !== existing) {
      store.workspaces[projectId] = workspace;
      await writeStore(store);
    }
    return workspace;
  }
  const workspace: ProjectWorkspace = {
    projectId,
    notes: [],
    viewer: defaultViewer,
    updatedAt: new Date().toISOString()
  };
  store.workspaces[projectId] = workspace;
  await writeStore(store);
  return workspace;
}

export async function patchWorkspace(
  projectId: string,
  patch: Partial<Pick<ProjectWorkspace, "viewer">> & { note?: string; screenshotUrl?: string | null }
): Promise<ProjectWorkspace> {
  const store = await readStore();
  const current =
    store.workspaces[projectId] ??
    ({
      projectId,
      notes: [],
      viewer: defaultViewer,
      updatedAt: new Date().toISOString()
    } satisfies ProjectWorkspace);

  const notes = [...current.notes];
  if (patch.note?.trim()) {
    const note: WorkspaceNote = {
      id: crypto.randomUUID(),
      text: patch.note.trim(),
      screenshotUrl: patch.screenshotUrl ?? null,
      createdAt: new Date().toISOString()
    };
    notes.unshift(note);
    store.activity = appendActivityToList(store.activity, {
      kind: "note",
      projectId,
      message: "Added note",
      data: note
    });
  }

  const normalized = normalizeWorkspace(current);
  const workspace: ProjectWorkspace = {
    ...current,
    notes: notes.slice(0, 100),
    viewer: patch.viewer ? normalizeViewer({ ...normalized.viewer, ...patch.viewer }) : normalized.viewer,
    updatedAt: new Date().toISOString()
  };
  store.workspaces[projectId] = workspace;
  await writeStore(store);
  return workspace;
}

function normalizeWorkspace(workspace: ProjectWorkspace): ProjectWorkspace {
  const viewer = normalizeViewer(workspace.viewer);
  if (viewer === workspace.viewer) return workspace;
  return { ...workspace, viewer };
}

function normalizeViewer(viewer: ViewerState): ViewerState {
  const legacyTab = viewer.activeTab as string;
  const activeTab = legacyTab === "notes" || legacyTab === "screenshots" ? "feedback" : viewer.activeTab;
  if (activeTab === viewer.activeTab) return viewer;
  return { ...viewer, activeTab };
}

export async function appendActivity(event: Omit<ActivityEvent, "id" | "createdAt">): Promise<ActivityEvent> {
  const store = await readStore();
  const activity = materializeActivity(event);
  store.activity = [activity, ...(store.activity ?? [])].slice(0, 500);
  await writeStore(store);
  return activity;
}

export async function listActivity(projectId?: string): Promise<ActivityEvent[]> {
  const store = await readStore();
  const activity = store.activity ?? [];
  return projectId ? activity.filter((event) => event.projectId === projectId) : activity;
}

function appendActivityToList(
  activity: ActivityEvent[] | undefined,
  event: Omit<ActivityEvent, "id" | "createdAt">
): ActivityEvent[] {
  return [materializeActivity(event), ...(activity ?? [])].slice(0, 500);
}

function materializeActivity(event: Omit<ActivityEvent, "id" | "createdAt">): ActivityEvent {
  return {
    ...event,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString()
  };
}
