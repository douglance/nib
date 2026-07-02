import crypto from "node:crypto";
import type http from "node:http";
import type {
  FeedbackEdit,
  FeedbackArtifact,
  FeedbackRequest,
  FeedbackMetrics,
  FeedbackMetricsSummary,
  FeedbackResponseMode,
  FeedbackResponse,
  FeedbackResponseKind,
  FeedbackStatus,
  ProjectInfo,
  ViewportKey
} from "../shared/types";
import { captureCodeState, compareCodeStates } from "./codeState";
import { discoverProjects } from "./discovery";
import { sendFeedbackNotification } from "./notifications";
import { createFeedbackSurface } from "./feedbackSurface";
import { captureScreenshots } from "./screenshots";
import { readStore, writeStore } from "./store";
import { appendActivity } from "./workspace";

interface FeedbackCreateInput {
  projectId?: string;
  prompt?: string;
  context?: string;
  responseMode?: FeedbackResponseMode;
  responseSpec?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  feedbackSurfaceHtml?: string;
  feedbackSurfaceTitle?: string;
  path?: string;
  appPath?: string;
  choices?: string[];
}

interface FeedbackPatchInput {
  status?: FeedbackStatus;
}

interface FeedbackRespondInput {
  kind?: FeedbackResponseKind;
  text?: string;
  choice?: string;
  data?: Record<string, unknown> | null;
}

interface FeedbackEditInput {
  targetId?: string;
  selector?: string;
  tagName?: string;
  before?: string;
  after?: string;
}

const subscribers = new Map<string, Set<http.ServerResponse>>();

export async function listFeedback(projectId?: string, includeMissing = false): Promise<FeedbackRequest[]> {
  const store = await readStore();
  const projects = await discoverProjects();
  const normalized = Object.values(store.feedback).map((request) => normalizeFeedbackRequest(request, projects));
  store.feedback = Object.fromEntries(normalized.map((request) => [request.id, request]));
  await writeStore(store);
  return normalized
    .filter((request) => !projectId || request.projectId === projectId)
    .filter((request) => includeMissing || request.projectAvailable)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getFeedback(id: string): Promise<FeedbackRequest | null> {
  const store = await readStore();
  const request = store.feedback[id];
  if (!request) return null;
  const normalized = normalizeFeedbackRequest(request, await discoverProjects());
  store.feedback[id] = normalized;
  await writeStore(store);
  return normalized;
}

export async function createFeedback(input: FeedbackCreateInput): Promise<FeedbackRequest> {
  if (!input.projectId) throw new Error("projectId is required");
  if (!input.prompt?.trim()) throw new Error("prompt is required");
  const project = await requireProject(input.projectId);
  const appPath = normalizeAppPath(input.appPath ?? input.path ?? "/");
  const state = await captureCodeState(project, appPath);
  const now = new Date().toISOString();
  const responseSpec = input.responseSpec && typeof input.responseSpec === "object" ? input.responseSpec : null;
  const choices = (input.choices ?? []).map((choice) => choice.trim()).filter(Boolean);
  const feedbackSurface = createFeedbackSurface({
    prompt: input.prompt.trim(),
    context: input.context?.trim() || null,
    choices,
    responseMode: normalizeResponseMode(input.responseMode, choices),
    responseSpec,
    html: input.feedbackSurfaceHtml,
    title: input.feedbackSurfaceTitle,
    createdAt: now
  });
  const request: FeedbackRequest = {
    id: crypto.randomUUID(),
    projectId: project.id,
    projectName: project.name,
    canonicalProjectKey: canonicalProjectKey(project),
    projectAliases: projectAliases(project),
    resolvedProjectId: project.id,
    projectAvailable: true,
    prompt: input.prompt.trim(),
    context: input.context?.trim() || null,
    responseMode: normalizeResponseMode(input.responseMode, choices),
    responseSpec,
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
    feedbackSurface,
    appPath,
    choices,
    status: "open",
    createdAt: now,
    updatedAt: now,
    viewedAt: null,
    resolvedAt: null,
    notifiedAt: null,
    notificationClickedAt: null,
    firstInteractionAt: null,
    answeredAt: null,
    requestedState: state,
    currentState: state,
    answeredState: null,
    isStale: false,
    staleReason: null,
    artifacts: [],
    edits: [],
    responses: [],
    metrics: emptyMetrics()
  };
  const store = await readStore();
  store.feedback[request.id] = request;
  await writeStore(store);
  await appendActivity({ kind: "feedback", projectId: project.id, message: "Created feedback request", data: request });
  emitFeedback(request);
  return await sendFeedbackNotification(request);
}

export async function refreshFeedbackState(id: string, markViewed = false): Promise<FeedbackRequest | null> {
  const store = await readStore();
  const request = store.feedback[id];
  if (!request) return null;
  const project = await resolveProjectForFeedback(request);
  if (!project) {
    const missing = normalizeFeedbackRequest(request, await discoverProjects());
    store.feedback[id] = missing;
    await writeStore(store);
    return missing;
  }
  const currentState = await captureCodeState(project, request.appPath);
  const staleReason = compareCodeStates(request.requestedState, currentState);
  const now = new Date().toISOString();
  const next: FeedbackRequest = {
    ...request,
    currentState,
    viewedAt: markViewed && !request.viewedAt ? now : request.viewedAt,
    status: markViewed && request.status === "open" ? "viewed" : request.status,
    firstInteractionAt: markViewed && !request.firstInteractionAt ? now : request.firstInteractionAt,
    projectId: project.id,
    resolvedProjectId: project.id,
    projectAvailable: true,
    projectAliases: mergeAliases(request.projectAliases, projectAliases(project)),
    isStale: Boolean(staleReason),
    staleReason,
    updatedAt: now
  };
  next.metrics = calculateMetrics(next);
  store.feedback[id] = next;
  await writeStore(store);
  emitFeedback(next);
  return next;
}

export async function recordFeedbackEdit(id: string, input: FeedbackEditInput): Promise<FeedbackRequest | null> {
  const store = await readStore();
  const request = store.feedback[id];
  if (!request) return null;
  const project = await resolveProjectForFeedback(request);
  if (!project) return normalizeFeedbackRequest(request, await discoverProjects());
  const before = input.before ?? "";
  const after = input.after ?? "";
  if (before === after) return normalizeFeedbackRequest(request, await discoverProjects());
  const state = await captureCodeState(project, request.appPath);
  const staleReason = compareCodeStates(request.requestedState, state);
  const now = new Date().toISOString();
  const edit: FeedbackEdit = {
    id: crypto.randomUUID(),
    targetId: input.targetId?.trim() || "unknown",
    selector: input.selector?.trim() || "",
    tagName: input.tagName?.trim().toLowerCase() || "unknown",
    before,
    after,
    createdAt: now,
    state
  };
  const next: FeedbackRequest = {
    ...request,
    edits: [edit, ...(request.edits ?? [])].slice(0, 250),
    currentState: state,
    projectId: project.id,
    resolvedProjectId: project.id,
    projectAvailable: true,
    projectAliases: mergeAliases(request.projectAliases, projectAliases(project)),
    firstInteractionAt: request.firstInteractionAt ?? now,
    isStale: Boolean(staleReason),
    staleReason,
    updatedAt: now
  };
  next.metrics = calculateMetrics(next);
  store.feedback[id] = next;
  await writeStore(store);
  await appendActivity({ kind: "feedback", projectId: next.projectId, message: "Tracked feedback edit", data: edit });
  emitFeedback(next);
  return next;
}

export async function patchFeedback(id: string, input: FeedbackPatchInput): Promise<FeedbackRequest | null> {
  const store = await readStore();
  const request = store.feedback[id];
  if (!request) return null;
  const now = new Date().toISOString();
  const status = input.status ?? request.status;
  const next: FeedbackRequest = {
    ...request,
    status,
    resolvedAt: status === "resolved" ? now : request.resolvedAt,
    updatedAt: now
  };
  next.metrics = calculateMetrics(next);
  store.feedback[id] = next;
  await writeStore(store);
  await appendActivity({ kind: "feedback", projectId: next.projectId, message: `Marked feedback ${status}`, data: { id } });
  emitFeedback(next);
  return next;
}

export async function respondFeedback(id: string, input: FeedbackRespondInput): Promise<FeedbackRequest | null> {
  const store = await readStore();
  const request = store.feedback[id];
  if (!request) return null;
  const project = await resolveProjectForFeedback(request);
  if (!project) return normalizeFeedbackRequest(request, await discoverProjects());
  const state = await captureCodeState(project, request.appPath);
  const staleReason = compareCodeStates(request.requestedState, state);
  const response: FeedbackResponse = {
    id: crypto.randomUUID(),
    kind: input.kind ?? "note",
    text: input.text?.trim() || input.choice?.trim() || "",
    choice: input.choice?.trim() || undefined,
    data: normalizeResponseData(input.data),
    createdAt: new Date().toISOString(),
    state
  };
  const next: FeedbackRequest = {
    ...request,
    responses: [response, ...request.responses].slice(0, 100),
    answeredState: state,
    currentState: state,
    status: staleReason ? "stale" : "answered",
    projectId: project.id,
    resolvedProjectId: project.id,
    projectAvailable: true,
    projectAliases: mergeAliases(request.projectAliases, projectAliases(project)),
    firstInteractionAt: request.firstInteractionAt ?? response.createdAt,
    answeredAt: response.createdAt,
    isStale: Boolean(staleReason),
    staleReason,
    updatedAt: response.createdAt
  };
  next.metrics = calculateMetrics(next);
  store.feedback[id] = next;
  await writeStore(store);
  await appendActivity({ kind: "feedback", projectId: next.projectId, message: "Answered feedback request", data: response });
  emitFeedback(next);
  return next;
}

export async function captureFeedbackArtifacts(id: string): Promise<FeedbackRequest | null> {
  const store = await readStore();
  const request = store.feedback[id];
  if (!request) return null;
  const project = await resolveProjectForFeedback(request);
  if (!project) return normalizeFeedbackRequest(request, await discoverProjects());
  const [screenshots, state] = await Promise.all([captureScreenshots(project.id), captureCodeState(project, request.appPath)]);
  const artifacts: FeedbackArtifact[] = Object.entries(screenshots).map(([viewport, shot]) => ({
    id: crypto.randomUUID(),
    type: "screenshot",
    label: `${viewport} screenshot`,
    url: shot.url,
    viewport: viewport as ViewportKey,
    capturedAt: shot.capturedAt ?? new Date().toISOString(),
    state
  }));
  const staleReason = compareCodeStates(request.requestedState, state);
  const next: FeedbackRequest = {
    ...request,
    artifacts,
    edits: request.edits ?? [],
    currentState: state,
    projectId: project.id,
    resolvedProjectId: project.id,
    projectAvailable: true,
    projectAliases: mergeAliases(request.projectAliases, projectAliases(project)),
    isStale: Boolean(staleReason),
    staleReason,
    updatedAt: new Date().toISOString()
  };
  next.metrics = calculateMetrics(next);
  store.feedback[id] = next;
  await writeStore(store);
  await appendActivity({ kind: "feedback", projectId: next.projectId, message: "Captured feedback artifacts", data: artifacts });
  emitFeedback(next);
  return next;
}

export async function markFeedbackNotified(id: string, when = new Date().toISOString()): Promise<FeedbackRequest | null> {
  const store = await readStore();
  const request = store.feedback[id];
  if (!request) return null;
  const next = normalizeFeedbackRequest({ ...request, notifiedAt: request.notifiedAt ?? when, updatedAt: when }, await discoverProjects());
  next.metrics = calculateMetrics(next);
  store.feedback[id] = next;
  await writeStore(store);
  emitFeedback(next);
  return next;
}

export async function markFeedbackNotificationClicked(id: string, when = new Date().toISOString()): Promise<FeedbackRequest | null> {
  const store = await readStore();
  const request = store.feedback[id];
  if (!request) return null;
  const next = normalizeFeedbackRequest(
    {
      ...request,
      notificationClickedAt: request.notificationClickedAt ?? when,
      firstInteractionAt: request.firstInteractionAt ?? when,
      updatedAt: when
    },
    await discoverProjects()
  );
  next.metrics = calculateMetrics(next);
  store.feedback[id] = next;
  await writeStore(store);
  emitFeedback(next);
  return next;
}

export async function feedbackMetrics(): Promise<FeedbackMetricsSummary> {
  const requests = await listFeedback(undefined, true);
  const answered = requests.filter((request) => Boolean(request.answeredAt));
  const requestToAnswer = answered.map((request) => request.metrics.requestToAnswerMs).filter(isNumber);
  const notifyToOpen = answered.map((request) => request.metrics.notifyToOpenMs).filter(isNumber);
  const openToAnswer = answered.map((request) => request.metrics.openToAnswerMs).filter(isNumber);
  const ordered = answered.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const latest = ordered.at(-1)?.metrics.requestToAnswerMs ?? null;
  const previous = ordered.slice(0, -1).map((request) => request.metrics.requestToAnswerMs).filter(isNumber);
  const previousMedian = median(previous);
  return {
    totalRequests: requests.length,
    answeredRequests: answered.length,
    activeRequests: requests.filter((request) => ["open", "viewed", "stale"].includes(request.status) && request.projectAvailable).length,
    missingProjectRequests: requests.filter((request) => !request.projectAvailable).length,
    medianRequestToAnswerMs: median(requestToAnswer),
    medianNotifyToOpenMs: median(notifyToOpen),
    medianOpenToAnswerMs: median(openToAnswer),
    latestRequestToAnswerMs: latest,
    improvementRate: previousMedian && latest ? (previousMedian - latest) / previousMedian : null
  };
}

export function streamFeedbackEvents(id: string, res: http.ServerResponse): void {
  res.writeHead(200, {
    "access-control-allow-origin": "*",
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  const set = subscribers.get(id) ?? new Set<http.ServerResponse>();
  set.add(res);
  subscribers.set(id, set);
  res.write(`event: ready\ndata: ${JSON.stringify({ id })}\n\n`);
  res.on("close", () => {
    set.delete(res);
    if (set.size === 0) subscribers.delete(id);
  });
}

function emitFeedback(request: FeedbackRequest): void {
  const set = subscribers.get(request.id);
  if (!set) return;
  const payload = `event: feedback\ndata: ${JSON.stringify(request)}\n\n`;
  for (const res of set) res.write(payload);
}

async function requireProject(projectId: string): Promise<ProjectInfo> {
  const projects = await discoverProjects();
  const project = resolveProject(projectId, projects);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  return project;
}

async function resolveProjectForFeedback(request: FeedbackRequest): Promise<ProjectInfo | null> {
  return resolveProjectForRequest(request, await discoverProjects());
}

function resolveProjectForRequest(request: FeedbackRequest, projects: ProjectInfo[]): ProjectInfo | null {
  const aliases = new Set([request.projectId, request.resolvedProjectId, ...(request.projectAliases ?? [])].filter(Boolean));
  const key =
    request.canonicalProjectKey ??
    (request.requestedState?.runtime
      ? `${request.requestedState.runtime.sourcePath ?? request.projectName}:${request.requestedState.runtime.port}`
      : "");
  return (
    projects.find((project) => aliases.has(project.id)) ??
    projects.find((project) => canonicalProjectKey(project) === key) ??
    resolveProject(request.projectId, projects) ??
    resolveUniquePort(request.requestedState?.runtime?.port, projects)
  );
}

function resolveProject(identifier: string, projects: ProjectInfo[]): ProjectInfo | null {
  const lowered = identifier.toLowerCase();
  return (
    projects.find(
      (project) =>
        project.id === identifier ||
        project.name.toLowerCase() === lowered ||
        String(project.port) === identifier ||
        project.id.includes(lowered)
    ) ?? null
  );
}

function resolveUniquePort(port: number | undefined, projects: ProjectInfo[]): ProjectInfo | null {
  if (!port) return null;
  const matches = projects.filter((project) => project.port === port);
  return matches.length === 1 ? matches[0] : null;
}

function normalizeFeedbackRequest(request: FeedbackRequest, projects: ProjectInfo[]): FeedbackRequest {
  const project = resolveProjectForRequest(request, projects);
  const fallbackKey = request.requestedState?.runtime
    ? `${request.requestedState.runtime.sourcePath ?? request.projectName}:${request.requestedState.runtime.port}`
    : `${request.projectName}:${request.requestedState?.runtime?.port ?? "unknown"}`;
  const nowRequest = {
    ...request,
    canonicalProjectKey: request.canonicalProjectKey ?? (project ? canonicalProjectKey(project) : fallbackKey),
    projectAliases: request.projectAliases ?? [request.projectId],
    resolvedProjectId: project?.id ?? null,
    projectAvailable: Boolean(project),
    context: request.context ?? null,
    responseMode: request.responseMode ?? "mixed",
    responseSpec: request.responseSpec ?? null,
    metadata: request.metadata ?? {},
    feedbackSurface: request.feedbackSurface ?? null,
    edits: request.edits ?? [],
    notifiedAt: request.notifiedAt ?? null,
    notificationClickedAt: request.notificationClickedAt ?? null,
    firstInteractionAt: request.firstInteractionAt ?? request.viewedAt ?? null,
    answeredAt: request.answeredAt ?? request.responses?.[0]?.createdAt ?? null,
    metrics: request.metrics ?? emptyMetrics()
  } satisfies FeedbackRequest;
  if (project) {
    nowRequest.projectId = project.id;
    nowRequest.projectName = project.name;
    nowRequest.canonicalProjectKey = canonicalProjectKey(project);
    nowRequest.projectAliases = mergeAliases(nowRequest.projectAliases, projectAliases(project));
  }
  nowRequest.metrics = calculateMetrics(nowRequest);
  return nowRequest;
}

function canonicalProjectKey(project: ProjectInfo): string {
  return `${project.sourcePath ?? project.name}:${project.port}`;
}

function projectAliases(project: ProjectInfo): string[] {
  return [project.id, project.name.toLowerCase(), String(project.port), canonicalProjectKey(project)];
}

function mergeAliases(a: string[] | undefined, b: string[]): string[] {
  return [...new Set([...(a ?? []), ...b].filter(Boolean))].slice(0, 20);
}

function emptyMetrics(): FeedbackMetrics {
  return {
    notifiedAt: null,
    notificationClickedAt: null,
    firstInteractionAt: null,
    answeredAt: null,
    requestToNotifyMs: null,
    notifyToOpenMs: null,
    openToAnswerMs: null,
    requestToAnswerMs: null
  };
}

function calculateMetrics(request: FeedbackRequest): FeedbackMetrics {
  return {
    notifiedAt: request.notifiedAt,
    notificationClickedAt: request.notificationClickedAt,
    firstInteractionAt: request.firstInteractionAt,
    answeredAt: request.answeredAt,
    requestToNotifyMs: diffMs(request.createdAt, request.notifiedAt),
    notifyToOpenMs: diffMs(request.notifiedAt, request.notificationClickedAt ?? request.viewedAt),
    openToAnswerMs: diffMs(request.firstInteractionAt ?? request.viewedAt, request.answeredAt),
    requestToAnswerMs: diffMs(request.createdAt, request.answeredAt)
  };
}

function diffMs(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null;
  const value = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function isNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeAppPath(appPath: string): string {
  if (!appPath.trim()) return "/";
  return appPath.startsWith("/") ? appPath : `/${appPath}`;
}

function normalizeResponseMode(mode: FeedbackResponseMode | undefined, choices: string[] | undefined): FeedbackResponseMode {
  if (typeof mode === "string" && mode.trim()) return mode.trim();
  return choices?.length ? "choice" : "mixed";
}

function normalizeResponseData(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
