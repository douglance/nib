import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  FeedbackRequest,
  RequestAttachment,
  RequestKind,
  RequestRecord,
  RequestResponse,
  RequestResponseKind,
  RequestStatus
} from "../shared/types";
import { ATTACHMENT_DIR } from "./config";
import { discoverProjects } from "./discovery";
import { sendRequestNotification } from "./notifications";
import { emitRequestEvent } from "./requestEvents";
import { mutateStore, readStore, writeStore } from "./store";
import { paneFingerprint } from "./waiting/detect";
import { appendActivity } from "./workspace";

const execFileAsync = promisify(execFile);

interface RequestCreateInput {
  kind?: RequestKind;
  title?: string;
  prompt?: string;
  body?: string | null;
  context?: string | null;
  choices?: string[];
  allowText?: boolean;
  projectId?: string;
  appPath?: string;
  url?: string;
  source?: string | null;
  priority?: "low" | "normal" | "high";
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
  tmux?: RequestRecord["target"]["tmux"];
  notify?: boolean;
}

interface RequestRespondInput {
  kind?: RequestResponseKind;
  text?: string;
  choice?: string;
  choiceIndex?: number;
  data?: Record<string, unknown> | null;
  deviceId?: string;
  acted?: boolean;
  decision?: "approve" | "reject" | "comment";
  comment?: string;
  annotations?: unknown[];
}

interface RequestPatchInput {
  status?: RequestStatus;
  staleReason?: string | null;
}

interface AttachmentInput {
  name?: string;
  contentType?: string;
  contentBase64?: string;
  metadata?: Record<string, unknown>;
}

export async function listRequests(projectId?: string, includeMissing = true): Promise<RequestRecord[]> {
  const store = await readStore();
  return Object.values(store.requests ?? {})
    .filter((request) => !projectId || request.target.projectId === projectId)
    .filter(isPublishedRequest)
    .filter((request) => includeMissing || request.status !== "stale")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getRequest(id: string): Promise<RequestRecord | null> {
  const store = await readStore();
  const request = store.requests?.[id];
  if (request) return request;
  const feedback = store.feedback?.[id];
  return feedback ? feedbackToRequest(feedback) : null;
}

export async function createRequest(input: RequestCreateInput): Promise<RequestRecord> {
  const prompt = input.prompt?.trim() || input.title?.trim() || input.body?.trim();
  if (!prompt) throw new Error("prompt is required");
  const now = new Date().toISOString();
  const visualReview = input.kind === "visual-review";
  if (visualReview && input.metadata?.contract !== "nib.visual-review/v1") {
    throw new RequestContractError("visual reviews require contract nib.visual-review/v1", 400);
  }
  const choices = (input.choices ?? []).map((choice) => choice.trim()).filter(Boolean);
  const project = input.projectId ? (await discoverProjects()).find((item) => item.id === input.projectId) : null;
  const projectId = project?.id ?? input.projectId;
  const appPath = normalizeAppPath(input.appPath ?? "/");
  const request: RequestRecord = {
    id: crypto.randomUUID(),
    kind: input.kind ?? (choices.length ? "choice" : "question"),
    title: input.title?.trim() || prompt,
    prompt,
    body: input.body?.trim() || null,
    context: input.context?.trim() || null,
    choices,
    allowText: input.allowText ?? true,
    target: {
      projectId,
      projectName: project?.name,
      appPath,
      url: targetUrl(projectId, appPath, input.url),
      tmux: input.tmux
    },
    status: "open",
    priority: input.priority ?? "normal",
    source: input.source?.trim() || null,
    createdAt: now,
    updatedAt: now,
    viewedAt: null,
    answeredAt: null,
    actedAt: null,
    resolvedAt: null,
    expiresAt: input.expiresAt ?? (visualReview ? defaultVisualReviewExpiry(now) : null),
    publishedAt: visualReview ? null : now,
    notifiedAt: null,
    notificationClickedAt: null,
    staleReason: null,
    attachments: [],
    responses: [],
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {}
  };
  const store = await readStore();
  store.requests[request.id] = request;
  await writeStore(store);
  await appendActivity({ kind: "feedback", projectId: request.target.projectId, message: "Created request", data: request });
  const created = input.notify === false || visualReview ? request : await sendRequestNotification(request);
  if (isPublishedRequest(created)) emitRequestEvent("created", created);
  return created;
}

export async function respondRequest(id: string, input: RequestRespondInput): Promise<RequestRecord | null> {
  const mutated = await mutateStore((store) => {
    const request = store.requests?.[id];
    if (!request) return;
    if (request.responses.length > 0) {
      throw new RequestContractError("request already has a response", 409);
    }
    if (request.kind === "visual-review" && !request.publishedAt) {
      throw new RequestContractError("visual review is not published", 409);
    }
    const now = new Date().toISOString();
    const visualResponse = request.kind === "visual-review" ? normalizeVisualResponse(input) : null;
    const choice = visualResponse?.decision ?? normalizeChoice(request.choices, input.choice, input.choiceIndex);
    const notificationResponse = isNotificationResponse(input.deviceId);
    const response: RequestResponse = {
      id: crypto.randomUUID(),
      kind: visualResponse ? "visual-review" : input.kind ?? (choice ? "choice" : "text"),
      text: visualResponse?.comment ?? (input.text?.trim() || choice || ""),
      choice,
      choiceIndex: typeof input.choiceIndex === "number" ? input.choiceIndex : choice ? request.choices.indexOf(choice) : undefined,
      data: visualResponse ?? normalizeData(input.data),
      deviceId: input.deviceId?.trim() || undefined,
      createdAt: now
    };
    const next: RequestRecord = {
      ...request,
      responses: [response],
      status: input.acted ? "acted" : "answered",
      viewedAt: notificationResponse ? request.viewedAt ?? now : request.viewedAt,
      answeredAt: request.answeredAt ?? now,
      actedAt: input.acted ? now : request.actedAt,
      notificationClickedAt: notificationResponse ? request.notificationClickedAt ?? now : request.notificationClickedAt,
      updatedAt: now
    };
    store.requests[id] = next;
  });
  const next = mutated.requests[id] ?? null;
  const response = next?.responses[0] ?? null;
  if (!next || !response) return null;
  await appendActivity({ kind: "feedback", projectId: next.target.projectId, message: "Answered request", data: response });
  emitRequestEvent("responded", next);
  if (shouldActuate(next)) return actuateRequest(next, response);
  return next;
}

export async function patchRequest(id: string, input: RequestPatchInput): Promise<RequestRecord | null> {
  const store = await readStore();
  const request = store.requests?.[id];
  if (!request) return null;
  const now = new Date().toISOString();
  const status = input.status ?? request.status;
  const next: RequestRecord = {
    ...request,
    status,
    staleReason: input.staleReason ?? request.staleReason,
    resolvedAt: status === "resolved" ? now : request.resolvedAt,
    updatedAt: now
  };
  store.requests[id] = next;
  await writeStore(store);
  await appendActivity({ kind: "feedback", projectId: next.target.projectId, message: `Marked request ${status}`, data: { id } });
  if (isPublishedRequest(next)) emitRequestEvent("updated", next);
  return next;
}

export async function markRequestNotificationClicked(id: string, when = new Date().toISOString()): Promise<RequestRecord | null> {
  const store = await readStore();
  const request = store.requests?.[id];
  if (!request) return null;
  const next: RequestRecord = {
    ...request,
    notificationClickedAt: request.notificationClickedAt ?? when,
    viewedAt: request.viewedAt ?? when,
    status: request.status === "open" ? "viewed" : request.status,
    updatedAt: when
  };
  store.requests[id] = next;
  await writeStore(store);
  if (isPublishedRequest(next)) emitRequestEvent("updated", next);
  return next;
}

export async function addRequestAttachment(id: string, input: AttachmentInput): Promise<RequestAttachment | null> {
  const store = await readStore();
  const request = store.requests?.[id];
  if (!request) return null;
  if (request.kind === "visual-review" && request.publishedAt) {
    throw new RequestContractError("visual review is already published", 409);
  }
  if (!input.contentBase64) throw new Error("contentBase64 is required");
  const buffer = Buffer.from(input.contentBase64, "base64");
  if (!buffer.length) throw new Error("attachment is empty");
  const contentType = input.contentType?.trim() || "application/octet-stream";
  const attachmentId = crypto.randomUUID();
  const safeName = sanitizeFileName(input.name || `attachment-${attachmentId}`);
  const ext = extensionFor(contentType, safeName);
  const fileName = `${attachmentId}${ext}`;
  await fs.mkdir(ATTACHMENT_DIR, { recursive: true });
  await fs.writeFile(path.join(ATTACHMENT_DIR, fileName), buffer);
  const now = new Date().toISOString();
  const attachment: RequestAttachment = {
    id: attachmentId,
    requestId: id,
    name: safeName,
    type: contentType.startsWith("image/") ? "image" : "file",
    contentType,
    bytes: buffer.length,
    url: `/attachments/${attachmentId}`,
    createdAt: now,
    metadata: input.metadata && typeof input.metadata === "object" ? { ...input.metadata, fileName } : { fileName }
  };
  const next: RequestRecord = {
    ...request,
    attachments: [attachment, ...request.attachments],
    updatedAt: now
  };
  store.requests[id] = next;
  store.attachments[attachmentId] = attachment;
  await writeStore(store);
  await appendActivity({ kind: "feedback", projectId: next.target.projectId, message: "Attached file to request", data: attachment });
  return attachment;
}

export async function publishRequest(id: string): Promise<RequestRecord | null> {
  const mutated = await mutateStore((store) => {
    const request = store.requests?.[id];
    if (!request) return;
    if (request.publishedAt) return;
    if (request.kind !== "visual-review") {
      throw new RequestContractError("only visual reviews require explicit publish", 400);
    }
    if (request.metadata.contract !== "nib.visual-review/v1") {
      throw new RequestContractError("visual review contract is invalid", 400);
    }
    const hasPreview = request.attachments.some((attachment) =>
      attachment.contentType.startsWith("image/") && attachment.metadata.role === "preview"
    );
    if (!hasPreview) throw new RequestContractError("visual review requires a preview image attachment", 400);
    const hasCanonical = request.attachments.some((attachment) =>
      attachment.contentType === "application/x-nib" && attachment.metadata.role === "canonical"
    );
    if (!hasCanonical) throw new RequestContractError("visual review requires a canonical .nib attachment", 400);
    const now = new Date().toISOString();
    const published: RequestRecord = { ...request, publishedAt: now, updatedAt: now };
    store.requests[id] = published;
  });
  const published = mutated.requests[id] ?? null;
  if (!published) return null;
  await appendActivity({ kind: "feedback", projectId: published.target.projectId, message: "Published visual review", data: { id } });
  const notified = await sendRequestNotification(published);
  emitRequestEvent("published", notified);
  return notified;
}

export async function attachmentFile(id: string): Promise<{ file: string; contentType: string; name: string } | null> {
  const store = await readStore();
  const attachment = store.attachments?.[id];
  const fileName = typeof attachment?.metadata.fileName === "string" ? attachment.metadata.fileName : null;
  if (!attachment || !fileName) return null;
  return {
    file: path.join(ATTACHMENT_DIR, path.basename(fileName)),
    contentType: attachment.contentType,
    name: attachment.name
  };
}

export function feedbackToRequest(feedback: FeedbackRequest): RequestRecord {
  return {
    id: feedback.id,
    kind: feedback.choices.length ? "choice" : "review",
    title: `Feedback: ${feedback.projectName}`,
    prompt: feedback.prompt,
    body: feedback.prompt,
    context: feedback.context,
    choices: feedback.choices,
    allowText: true,
    target: {
      projectId: feedback.resolvedProjectId ?? feedback.projectId,
      projectName: feedback.projectName,
      appPath: feedback.appPath,
      url: targetUrl(feedback.resolvedProjectId ?? feedback.projectId, feedback.appPath, undefined, { feedback: feedback.id })
    },
    status: feedback.status === "stale" ? "stale" : feedback.status,
    priority: "normal",
    source: "feedback",
    createdAt: feedback.createdAt,
    updatedAt: feedback.updatedAt,
    viewedAt: feedback.viewedAt,
    answeredAt: feedback.answeredAt,
    actedAt: null,
    resolvedAt: feedback.resolvedAt,
    expiresAt: null,
    notifiedAt: feedback.notifiedAt,
    notificationClickedAt: feedback.notificationClickedAt,
    staleReason: feedback.staleReason,
    attachments: feedback.artifacts.map((artifact) => ({
      id: artifact.id,
      requestId: feedback.id,
      name: artifact.label,
      type: "screenshot",
      contentType: "image/png",
      bytes: 0,
      url: artifact.url ?? "",
      createdAt: artifact.capturedAt,
      metadata: { viewport: artifact.viewport }
    })),
    responses: feedback.responses.map((response) => ({
      id: response.id,
      kind: response.kind,
      text: response.text,
      choice: response.choice,
      data: response.data,
      createdAt: response.createdAt
    })),
    metadata: {
      ...feedback.metadata,
      compatibility: "feedback"
    }
  };
}

async function actuateRequest(request: RequestRecord, response: RequestResponse): Promise<RequestRecord> {
  const tmux = request.target.tmux;
  if (!tmux) return request;
  const store = await readStore();
  const current = store.requests[request.id] ?? request;
  try {
    const text = await captureTmuxPane(tmux.session, tmux.paneId);
    const fingerprint = paneFingerprint(text);
    if (fingerprint !== tmux.fingerprint) {
      const stale = {
        ...current,
        status: "stale" as const,
        staleReason: "tmux pane changed before actuation",
        updatedAt: new Date().toISOString()
      };
      store.requests[request.id] = stale;
      await writeStore(store);
      return stale;
    }
    await sendTmuxResponse(tmux.session, tmux.paneId, request, response);
    const now = new Date().toISOString();
    const acted = {
      ...current,
      status: "acted" as const,
      actedAt: now,
      updatedAt: now
    };
    store.requests[request.id] = acted;
    await writeStore(store);
    await appendActivity({ kind: "feedback", message: "Acted on tmux request", data: { requestId: request.id, paneId: tmux.paneId } });
    return acted;
  } catch (error) {
    const stale = {
      ...current,
      status: "stale" as const,
      staleReason: error instanceof Error ? error.message : "tmux actuation failed",
      updatedAt: new Date().toISOString()
    };
    store.requests[request.id] = stale;
    await writeStore(store);
    return stale;
  }
}

function shouldActuate(request: RequestRecord): boolean {
  return Boolean(request.target.tmux && request.metadata?.actuate === true);
}

function isPublishedRequest(request: RequestRecord): boolean {
  return request.kind !== "visual-review" || Boolean(request.publishedAt);
}

function defaultVisualReviewExpiry(createdAt: string): string {
  return new Date(new Date(createdAt).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeVisualResponse(input: RequestRespondInput): Record<string, unknown> & {
  decision: "approve" | "reject" | "comment";
  comment?: string;
  annotations: unknown[];
} {
  if (!input.decision || !["approve", "reject", "comment"].includes(input.decision)) {
    throw new RequestContractError("visual review decision must be approve, reject, or comment", 400);
  }
  const comment = input.comment?.trim();
  if (input.decision === "comment" && !comment) {
    throw new RequestContractError("comment decision requires a comment", 400);
  }
  return {
    contract: "nib.visual-review/v1",
    decision: input.decision,
    ...(comment ? { comment } : {}),
    annotations: Array.isArray(input.annotations) ? input.annotations : []
  };
}

export class RequestContractError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "RequestContractError";
  }
}

async function captureTmuxPane(session: string, paneId: string): Promise<string> {
  const { stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-t", `${session}:${paneId}`], { encoding: "utf8" });
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-25)
    .join("\n");
}

async function sendTmuxResponse(session: string, paneId: string, request: RequestRecord, response: RequestResponse): Promise<void> {
  const target = `${session}:${paneId}`;
  const index = typeof response.choiceIndex === "number"
    ? response.choiceIndex
    : response.choice
      ? request.choices.indexOf(response.choice)
      : -1;
  if (index >= 0) {
    for (let i = 0; i < index; i += 1) {
      await execFileAsync("tmux", ["send-keys", "-t", target, "Down"]);
    }
    await execFileAsync("tmux", ["send-keys", "-t", target, "Enter"]);
    return;
  }
  if (response.text.trim()) {
    await execFileAsync("tmux", ["set-buffer", "-b", "nib-response", response.text]);
    await execFileAsync("tmux", ["paste-buffer", "-b", "nib-response", "-t", target]);
    await execFileAsync("tmux", ["send-keys", "-t", target, "Enter"]);
    return;
  }
  await execFileAsync("tmux", ["send-keys", "-t", target, "Enter"]);
}

function normalizeChoice(choices: string[], choice?: string, choiceIndex?: number): string | undefined {
  if (typeof choiceIndex === "number" && choices[choiceIndex]) return choices[choiceIndex];
  const trimmed = choice?.trim();
  if (!trimmed) return undefined;
  return choices.find((item) => item === trimmed) ?? trimmed;
}

function normalizeData(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isNotificationResponse(deviceId: string | undefined): boolean {
  return Boolean(deviceId?.trim().endsWith("-notification"));
}

function normalizeAppPath(appPath: string): string {
  if (!appPath.trim()) return "/";
  return appPath.startsWith("/") ? appPath : `/${appPath}`;
}

function targetUrl(
  projectId: string | undefined,
  appPath: string,
  explicitUrl?: string,
  params: Record<string, string> = {}
): string | undefined {
  const trimmed = explicitUrl?.trim();
  if (trimmed) return trimmed;
  if (!projectId) return undefined;
  const query = new URLSearchParams({ path: normalizeAppPath(appPath) });
  for (const [key, value] of Object.entries(params)) query.set(key, value);
  return `/view/${encodeURIComponent(projectId)}?${query.toString()}`;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "attachment";
}

function extensionFor(contentType: string, name: string): string {
  const existing = path.extname(name);
  if (existing) return existing;
  if (contentType === "image/jpeg") return ".jpg";
  if (contentType === "image/png") return ".png";
  if (contentType === "image/heic") return ".heic";
  if (contentType === "application/json") return ".json";
  return ".bin";
}
