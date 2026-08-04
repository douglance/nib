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
  RequestStatus,
  ReviewTranscript
} from "../shared/types";
import { ATTACHMENT_DIR, ATTACHMENT_MAX_BYTES } from "./config";
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
  transcript?: ReviewTranscript;
  notificationResponse?: boolean;
}

interface RequestPatchInput {
  status?: RequestStatus;
  staleReason?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AttachmentInput {
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
  const reviewContract = input.metadata?.contract;
  if (visualReview && reviewContract !== "nib.visual-review/v1" && reviewContract !== "nib.review/v2") {
    throw new RequestContractError("visual reviews require contract nib.visual-review/v1 or nib.review/v2", 400);
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
    const visualResponse = request.kind === "visual-review" ? normalizeVisualResponse(request, input) : null;
    const choice = visualResponse?.decision ?? normalizeChoice(request.choices, input.choice, input.choiceIndex);
    const notificationResponse = input.notificationResponse === true || isNotificationResponse(input.deviceId);
    const deviceId = input.deviceId?.trim() || undefined;
    const registeredDevice = deviceId ? store.devices?.[deviceId] : undefined;
    const responseAttachments = request.attachments.filter((attachment) => attachment.metadata.role === "response");
    const response: RequestResponse = {
      id: crypto.randomUUID(),
      kind: visualResponse ? "visual-review" : input.kind ?? (choice ? "choice" : "text"),
      text: visualResponse?.comment ?? (input.text?.trim() || choice || ""),
      choice,
      choiceIndex: typeof input.choiceIndex === "number" ? input.choiceIndex : choice ? request.choices.indexOf(choice) : undefined,
      data: visualResponse ?? normalizeData(input.data),
      deviceId,
      device: registeredDevice
        ? {
            id: registeredDevice.id,
            name: registeredDevice.name,
            platform: registeredDevice.platform,
            pushKind: registeredDevice.pushKind
          }
        : undefined,
      attachments: responseAttachments.length ? responseAttachments : undefined,
      transcript: normalizeTranscript(input.transcript)
        ?? (responseAttachments.length ? unavailableTranscript() : undefined),
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
    metadata: input.metadata && !request.publishedAt
      ? { ...request.metadata, ...input.metadata }
      : request.metadata,
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
  if (!input.contentBase64) throw new Error("contentBase64 is required");
  const buffer = Buffer.from(input.contentBase64, "base64");
  return addRequestAttachmentBytes(id, input, buffer);
}

export async function addRequestAttachmentBytes(
  id: string,
  input: Omit<AttachmentInput, "contentBase64">,
  buffer: Buffer
): Promise<RequestAttachment | null> {
  return persistRequestAttachment(id, input, { buffer, bytes: buffer.length });
}

export async function addRequestAttachmentFile(
  id: string,
  input: Omit<AttachmentInput, "contentBase64">,
  temporaryFile: string,
  bytes: number
): Promise<RequestAttachment | null> {
  return persistRequestAttachment(id, input, { temporaryFile, bytes });
}

async function persistRequestAttachment(
  id: string,
  input: Omit<AttachmentInput, "contentBase64">,
  source: { buffer: Buffer; bytes: number } | { temporaryFile: string; bytes: number }
): Promise<RequestAttachment | null> {
  if (!source.bytes) throw new RequestContractError("attachment is empty", 400);
  if (source.bytes > ATTACHMENT_MAX_BYTES) {
    throw new RequestContractError(`attachment exceeds ${ATTACHMENT_MAX_BYTES} byte limit`, 413);
  }
  const store = await readStore();
  const request = store.requests?.[id];
  if (!request) return null;
  const responseAttachment = input.metadata?.role === "response";
  if (request.kind === "visual-review" && request.publishedAt && !responseAttachment) {
    throw new RequestContractError("visual review is already published", 409);
  }
  if (responseAttachment && (!request.publishedAt || request.responses.length)) {
    throw new RequestContractError("response attachments require a published unanswered review", 409);
  }
  const contentType = input.contentType?.trim() || "application/octet-stream";
  if ("buffer" in source) validateAttachment(contentType, source.buffer);
  else await validateAttachmentFile(contentType, source.temporaryFile);
  const attachmentId = crypto.randomUUID();
  const safeName = sanitizeFileName(input.name || `attachment-${attachmentId}`);
  const ext = extensionFor(contentType, safeName);
  const fileName = `${attachmentId}${ext}`;
  await fs.mkdir(ATTACHMENT_DIR, { recursive: true });
  const destination = path.join(ATTACHMENT_DIR, fileName);
  if ("buffer" in source) await fs.writeFile(destination, source.buffer);
  else await fs.rename(source.temporaryFile, destination);
  const now = new Date().toISOString();
  const attachment: RequestAttachment = {
    id: attachmentId,
    requestId: id,
    name: safeName,
    type: attachmentType(contentType),
    contentType,
    bytes: source.bytes,
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
    if (request.metadata.contract !== "nib.visual-review/v1" && request.metadata.contract !== "nib.review/v2") {
      throw new RequestContractError("visual review contract is invalid", 400);
    }
    if (request.metadata.contract === "nib.visual-review/v1") {
      const hasPreview = request.attachments.some((attachment) =>
        attachment.contentType.startsWith("image/") && attachment.metadata.role === "preview"
      );
      if (!hasPreview) throw new RequestContractError("visual review requires a preview image attachment", 400);
      const hasCanonical = request.attachments.some((attachment) =>
        attachment.contentType === "application/x-nib" && attachment.metadata.role === "canonical"
      );
      if (!hasCanonical) throw new RequestContractError("visual review requires a canonical .nib attachment", 400);
    } else {
      validateReviewV2(request);
    }
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

function normalizeVisualResponse(request: RequestRecord, input: RequestRespondInput): Record<string, unknown> & {
  decision: "approve" | "reject" | "comment";
  comment?: string;
  annotations: unknown[];
} {
  if (!input.decision || !["approve", "reject", "comment"].includes(input.decision)) {
    throw new RequestContractError("visual review decision must be approve, reject, or comment", 400);
  }
  const comment = input.comment?.trim();
  const hasResponseAttachment = request.attachments.some((attachment) => attachment.metadata.role === "response");
  if (input.decision === "comment" && !comment && !hasResponseAttachment) {
    throw new RequestContractError("comment decision requires a comment", 400);
  }
  const annotations = Array.isArray(input.annotations) ? input.annotations : [];
  const contract = request.metadata.contract === "nib.review/v2"
    ? "nib.review/v2"
    : "nib.visual-review/v1";
  if (contract === "nib.review/v2" && reviewSubject(request)?.primary.kind === "video") {
    const untimed = annotations.find((annotation) => {
      if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)) return true;
      const timeMs = (annotation as Record<string, unknown>).timeMs;
      return typeof timeMs !== "number" || !Number.isFinite(timeMs) || timeMs < 0;
    });
    if (untimed) {
      throw new RequestContractError("video review annotations require a non-negative timeMs anchor", 400);
    }
  }
  return {
    contract,
    decision: input.decision,
    ...(comment ? { comment } : {}),
    annotations
  };
}

function normalizeTranscript(transcript: ReviewTranscript | undefined): ReviewTranscript | undefined {
  if (!transcript) return undefined;
  if (!["complete", "unavailable", "failed"].includes(transcript.status)) {
    throw new RequestContractError("transcript status is invalid", 400);
  }
  if (!["device", "origin-mac", "none"].includes(transcript.source)) {
    throw new RequestContractError("transcript source is invalid", 400);
  }
  if (!Array.isArray(transcript.segments)) {
    throw new RequestContractError("transcript segments must be an array", 400);
  }
  return {
    ...transcript,
    text: transcript.text?.trim() ?? "",
    segments: transcript.segments.map((segment) => ({
      startMs: Math.max(0, Number(segment.startMs)),
      endMs: Math.max(Number(segment.startMs), Number(segment.endMs)),
      text: segment.text?.trim() ?? ""
    }))
  };
}

function unavailableTranscript(): ReviewTranscript {
  return {
    status: "unavailable",
    source: "none",
    text: "",
    segments: [],
    error: "Device transcription was unavailable; origin-Mac fallback may retry"
  };
}

function validateReviewV2(request: RequestRecord): void {
  const subject = reviewSubject(request);
  if (!subject || subject.contract !== "nib.review/v2") {
    throw new RequestContractError("nib.review/v2 requires metadata.subject", 400);
  }
  const primary = request.attachments.find((attachment) => attachment.id === subject.primary.attachmentId);
  if (!primary) throw new RequestContractError("review subject primary attachment is missing", 400);
  const expectedPrefix = subject.primary.kind === "video" ? "video/" : "image/";
  if (!primary.contentType.startsWith(expectedPrefix)) {
    throw new RequestContractError(`review subject ${subject.primary.kind} content type does not match attachment`, 400);
  }
  if (subject.primary.kind === "video") {
    if (primary.contentType !== "video/mp4") {
      throw new RequestContractError("first-release video reviews require video/mp4", 400);
    }
    if (typeof subject.primary.durationMs !== "number" || subject.primary.durationMs <= 0) {
      throw new RequestContractError("video review subject requires durationMs", 400);
    }
    if (subject.primary.posterAttachmentId) {
      const poster = request.attachments.find((attachment) => attachment.id === subject.primary.posterAttachmentId);
      if (!poster?.contentType.startsWith("image/")) {
        throw new RequestContractError("video review poster attachment is missing", 400);
      }
    }
  }
}

function reviewSubject(request: RequestRecord): {
  contract?: unknown;
  primary: {
    attachmentId?: unknown;
    kind?: unknown;
    durationMs?: unknown;
    posterAttachmentId?: unknown;
  };
} | null {
  const subject = request.metadata.subject;
  if (!subject || typeof subject !== "object" || Array.isArray(subject)) return null;
  const primary = (subject as Record<string, unknown>).primary;
  if (!primary || typeof primary !== "object" || Array.isArray(primary)) return null;
  return {
    contract: (subject as Record<string, unknown>).contract,
    primary: primary as {
      attachmentId?: unknown;
      kind?: unknown;
      durationMs?: unknown;
      posterAttachmentId?: unknown;
    }
  };
}

function validateAttachment(contentType: string, buffer: Buffer): void {
  if (contentType !== "video/mp4") return;
  if (buffer.length < 12 || buffer.subarray(4, 8).toString("ascii") !== "ftyp") {
    throw new RequestContractError("video attachment is not an MP4 file", 400);
  }
  if (!buffer.includes(Buffer.from("avc1")) && !buffer.includes(Buffer.from("avc3"))) {
    throw new RequestContractError("first-release MP4 video must contain H.264 video", 400);
  }
}

async function validateAttachmentFile(contentType: string, file: string): Promise<void> {
  if (contentType !== "video/mp4") return;
  const handle = await fs.open(file, "r");
  try {
    const header = Buffer.alloc(12);
    const headerRead = await handle.read(header, 0, header.length, 0);
    if (headerRead.bytesRead < 12 || header.subarray(4, 8).toString("ascii") !== "ftyp") {
      throw new RequestContractError("video attachment is not an MP4 file", 400);
    }
    const chunk = Buffer.alloc(1024 * 1024 + 3);
    let offset = 0;
    let overlap = 0;
    let h264 = false;
    while (!h264) {
      const read = await handle.read(chunk, overlap, chunk.length - overlap, offset);
      if (!read.bytesRead) break;
      const used = overlap + read.bytesRead;
      const view = chunk.subarray(0, used);
      h264 = view.includes(Buffer.from("avc1")) || view.includes(Buffer.from("avc3"));
      if (h264) break;
      overlap = Math.min(3, used);
      view.copy(chunk, 0, used - overlap, used);
      offset += read.bytesRead;
    }
    if (!h264) {
      throw new RequestContractError("first-release MP4 video must contain H.264 video", 400);
    }
  } finally {
    await handle.close();
  }
}

function attachmentType(contentType: string): RequestAttachment["type"] {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType === "application/pdf" || contentType.startsWith("text/")) return "document";
  return "file";
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
  if (contentType === "video/mp4") return ".mp4";
  if (contentType === "audio/mp4") return ".m4a";
  if (contentType === "application/pdf") return ".pdf";
  if (contentType === "application/json") return ".json";
  return ".bin";
}
