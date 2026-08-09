type JsonValue = unknown;
type JsonObject = Record<string, unknown>;

export type CapabilityScope = "view" | "comment" | "decide";
export type ArtifactStatus = "pending" | "completed" | "aborted";

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list<T>(prefix: string): Promise<Map<string, T>>;
}

export interface MediaStore {
  put(key: string, value: ArrayBuffer | Uint8Array, options?: {
    httpMetadata?: { contentType?: string };
    customMetadata?: Record<string, string>;
  }): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
  createMultipart(key: string, options?: MediaWriteOptions): Promise<{ uploadId: string }>;
  uploadMultipartPart(key: string, uploadId: string, partNumber: number, value: ArrayBuffer | Uint8Array): Promise<UploadedPart>;
  completeMultipart(key: string, uploadId: string, parts: UploadedPart[], options?: MediaWriteOptions): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

export interface MediaWriteOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface ContinuationDelivery {
  url: string;
  event: HostedEvent;
  request: HostedRequest;
  headers: Record<string, string>;
}

export interface ContinuationHooks {
  dispatch?(delivery: ContinuationDelivery): Promise<{ ok: boolean; status: number }>;
  sign?(delivery: Omit<ContinuationDelivery, "headers">): Promise<string>;
}

export interface HostedRequest {
  id: string;
  formatVersion: string;
  revision: number;
  kind: string;
  title: string;
  description?: string;
  prompt: string;
  body: string | null;
  context: string | null;
  choices: string[];
  allowText: boolean;
  target: JsonObject;
  status: string;
  priority: "low" | "normal" | "high";
  source: JsonObject;
  subject?: JsonObject;
  artifacts: JsonObject[];
  decision: JsonObject;
  routing: JsonObject;
  policy: JsonObject;
  continuation: JsonObject;
  reviewable: boolean;
  metering: {
    firstReviewableRevision: number | null;
    currentReviewableRevision: number | null;
  };
  createdAt: string;
  updatedAt: string;
  viewedAt: string | null;
  answeredAt: string | null;
  actedAt: string | null;
  resolvedAt: string | null;
  expiresAt: string | null;
  publishedAt: string | null;
  notifiedAt: string | null;
  notificationClickedAt: string | null;
  staleReason: string | null;
  attachments: unknown[];
  responses: unknown[];
  metadata: JsonObject;
}

export interface HostedRevision {
  id: string;
  requestId: string;
  number: number;
  requestRevision: number;
  patch: JsonObject;
  createdAt: string;
  createdBy: string;
}

export interface HostedDecision {
  id: string;
  type: "decision";
  requestId: string;
  requestRevision: number;
  sequence: number;
  outcome: string;
  value: string;
  comment: string | null;
  data: JsonObject;
  terminal: boolean;
  createdAt: string;
  createdBy: string;
  reviewer: JsonObject;
  capabilityId: string | null;
}

export interface HostedFeedback {
  id: string;
  requestId: string;
  kind: string;
  message: string;
  data: JsonObject;
  createdAt: string;
  createdBy: string;
  capabilityId: string | null;
}

export interface HostedCapability {
  id: string;
  requestId: string;
  tokenHash: string;
  scopes: CapabilityScope[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  name: string | null;
}

export interface HostedReviewSession {
  id: string;
  requestId: string;
  sessionHash: string;
  capabilityId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface HostedArtifact {
  id: string;
  requestId: string;
  objectKey: string;
  name: string;
  contentType: string;
  bytes: number;
  sha256: string | null;
  uploadMode: "single" | "multipart";
  uploadId: string | null;
  partSize: number;
  parts: HostedArtifactPart[];
  status: ArtifactStatus;
  uploadUrl: string;
  completeUrl: string;
  abortUrl: string;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
  abortedAt: string | null;
  metadata: JsonObject;
}

export interface HostedArtifactPart {
  number: number;
  bytes: number;
  url: string;
  status?: "pending" | "completed";
  sha256?: string | null;
  etag?: string | null;
}

export interface HostedEvent {
  id: string;
  cursor: string;
  sequence: number;
  type: string;
  requestId: string | null;
  requestRevision: number | null;
  createdAt: string;
  data: JsonObject;
}

interface IdempotencyRecord {
  fingerprint: string;
  status: number;
  body: JsonValue;
  createdAt: string;
}

interface MutationOptions {
  idempotencyKey: string;
  subject?: string;
  capabilityToken?: string;
}

interface AccessContext {
  subject: string;
  capabilityId: string | null;
  scopes: CapabilityScope[] | "*";
}

interface FetchOptions {
  subject: string | null;
  origin: string;
}

const SINGLE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MULTIPART_PART_BYTES = 32 * 1024 * 1024;
const MIN_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
export const REVIEW_SESSION_COOKIE = "nib_review_session";
const REVIEW_SESSION_MAX_AGE_SECONDS = 15 * 60;

export interface HostedRequestCore {
  createRequest(input: Record<string, unknown>, options: MutationOptions): Promise<Response>;
  listRequests(): Promise<{ requests: HostedRequest[] }>;
  getRequest(id: string, capabilityToken?: string, subject?: string): Promise<Response>;
  createRevision(id: string, input: Record<string, unknown>, options: MutationOptions): Promise<Response>;
  listRevisions(id: string, capabilityToken?: string, subject?: string): Promise<Response>;
  createDecision(id: string, input: Record<string, unknown>, options: MutationOptions): Promise<Response>;
  listDecisions(id: string, capabilityToken?: string, subject?: string): Promise<Response>;
  createFeedback(id: string, input: Record<string, unknown>, options: MutationOptions): Promise<Response>;
  listFeedback(id: string, capabilityToken?: string, subject?: string): Promise<Response>;
  createCapability(id: string, input: Record<string, unknown>, options: MutationOptions): Promise<Response>;
  listCapabilities(id: string): Promise<Response>;
  revokeCapability(id: string, capabilityId: string, options: MutationOptions): Promise<Response>;
  initiateArtifact(id: string, input: Record<string, unknown>, options: MutationOptions): Promise<Response>;
  completeArtifact(id: string, artifactId: string, body: ArrayBuffer | Uint8Array, options: MutationOptions): Promise<Response>;
  finalizeArtifact(id: string, artifactId: string, options: MutationOptions): Promise<Response>;
  abortArtifact(id: string, artifactId: string, options: MutationOptions): Promise<Response>;
  listArtifacts(id: string, capabilityToken?: string, subject?: string): Promise<Response>;
  listEvents(options: { after?: string; lastEventId?: string; requestId?: string }): Promise<{ events: HostedEvent[] }>;
  fetch(request: Request, options: FetchOptions): Promise<Response>;
}

export class HostedRequestCoreService implements HostedRequestCore {
  constructor(
    private readonly store: KeyValueStore,
    private readonly media: MediaStore,
    private readonly now: () => Date = () => new Date(),
    private readonly continuationHooks: ContinuationHooks = {}
  ) {}

  async fetch(request: Request, options: FetchOptions): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/v1/requests") {
      if (request.method === "GET") {
        if (!options.subject) return unauthorized();
        return json(await this.listRequests());
      }
      if (request.method === "POST") {
        if (!options.subject) return unauthorized();
        return this.createRequest(await request.json<Record<string, unknown>>(), {
          idempotencyKey: request.headers.get("idempotency-key") || "",
          subject: options.subject
        });
      }
    }
    if (path === "/v1/events" && request.method === "GET") {
      if (!options.subject) return unauthorized();
      const events = await this.listEvents({
        after: url.searchParams.get("after") || undefined,
        lastEventId: request.headers.get("last-event-id") || undefined,
        requestId: url.searchParams.get("requestId") || undefined
      });
      if ((request.headers.get("accept") || "").includes("text/event-stream")) return eventStream(events.events);
      return json(events);
    }

    const match = path.match(/^\/v1\/requests\/([^/]+)(?:\/([^/]+)(?:\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?)?)?$/);
    if (!match) return json({ error: "Not found" }, 404);
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    const nestedId = match[3] ? decodeURIComponent(match[3]) : "";
    const terminal = match[4] ? decodeURIComponent(match[4]) : "";
    const terminalId = match[5] ? decodeURIComponent(match[5]) : "";
    const capabilityToken = capabilityTokenFor(request);
    if (!action && request.method === "GET") return this.getRequest(id, capabilityToken, options.subject || undefined);
    if (action === "session" && request.method === "POST") {
      return this.createReviewSession(id, rawCapabilityTokenFor(request));
    }
    if (action === "events" && request.method === "GET") {
      const access = await this.access(id, "view", { subject: options.subject || undefined, capabilityToken });
      if (!access.ok) return access.response;
      const events = await this.listEvents({
        after: url.searchParams.get("after") || undefined,
        lastEventId: request.headers.get("last-event-id") || undefined,
        requestId: id
      });
      if ((request.headers.get("accept") || "").includes("text/event-stream")) return eventStream(events.events);
      return json(events);
    }
    if (action === "revisions") {
      if (request.method === "GET") return this.listRevisions(id, capabilityToken, options.subject || undefined);
      if (request.method === "POST" && nestedId && terminal === "publish") {
        if (!options.subject) return unauthorized();
        return this.publishRevision(id, Number.parseInt(nestedId, 10), {
          idempotencyKey: request.headers.get("idempotency-key") || "",
          subject: options.subject
        });
      }
      if (request.method === "POST") {
        if (!options.subject) return unauthorized();
        return this.createRevision(id, await request.json<Record<string, unknown>>(), {
          idempotencyKey: request.headers.get("idempotency-key") || "",
          subject: options.subject
        });
      }
    }
    if (action === "decisions") {
      if (request.method === "GET") return this.listDecisions(id, capabilityToken, options.subject || undefined);
      if (request.method === "POST") {
        return this.createDecision(id, await request.json<Record<string, unknown>>(), {
          idempotencyKey: request.headers.get("idempotency-key") || "",
          subject: options.subject || undefined,
          capabilityToken
        });
      }
    }
    if (action === "feedback") {
      if (request.method === "GET") return this.listFeedback(id, capabilityToken, options.subject || undefined);
      if (request.method === "POST") {
        return this.createFeedback(id, await request.json<Record<string, unknown>>(), {
          idempotencyKey: request.headers.get("idempotency-key") || "",
          subject: options.subject || undefined,
          capabilityToken
        });
      }
    }
    if (action === "capabilities") {
      if (request.method === "GET" && !nestedId) {
        if (!options.subject) return unauthorized();
        return this.listCapabilities(id);
      }
      if (request.method === "POST" && !nestedId) {
        if (!options.subject) return unauthorized();
        return this.createCapability(id, await request.json<Record<string, unknown>>(), {
          idempotencyKey: request.headers.get("idempotency-key") || "",
          subject: options.subject
        });
      }
      if (request.method === "POST" && nestedId && terminal === "revoke") {
        if (!options.subject) return unauthorized();
        return this.revokeCapability(id, nestedId, {
          idempotencyKey: request.headers.get("idempotency-key") || "",
          subject: options.subject
        });
      }
    }
    if (action === "artifacts") {
      if (request.method === "GET" && !nestedId) return this.listArtifacts(id, capabilityToken, options.subject || undefined);
      if (request.method === "POST" && !nestedId) {
        if (!options.subject) return unauthorized();
        return this.initiateArtifact(id, await request.json<Record<string, unknown>>(), {
          idempotencyKey: request.headers.get("idempotency-key") || "",
          subject: options.subject
        });
      }
      if ((request.method === "POST" || request.method === "PUT") && nestedId && terminal === "complete") {
        if (!options.subject) return unauthorized();
        return this.completeArtifact(id, nestedId, await request.arrayBuffer(), {
          idempotencyKey: request.headers.get("idempotency-key") || "",
          subject: options.subject
        });
      }
      if (request.method === "POST" && nestedId && terminal === "finalize") {
        if (!options.subject) return unauthorized();
        return this.finalizeArtifact(id, nestedId, {
          idempotencyKey: request.headers.get("idempotency-key") || "",
          subject: options.subject
        });
      }
      if (request.method === "GET" && nestedId && terminal === "content") {
        return this.artifactContent(id, nestedId, request, {
          subject: options.subject || undefined,
          capabilityToken
        });
      }
      if (request.method === "POST" && nestedId && terminal === "abort") {
        if (!options.subject) return unauthorized();
        return this.abortArtifact(id, nestedId, {
          idempotencyKey: request.headers.get("idempotency-key") || "",
          subject: options.subject
        });
      }
      if ((request.method === "POST" || request.method === "PUT") && nestedId && terminal === "parts") {
        if (!options.subject) return unauthorized();
        const partNumber = Number.parseInt(terminalId, 10);
        return this.completeArtifactPart(id, nestedId, partNumber, await request.arrayBuffer(), {
          idempotencyKey: request.headers.get("idempotency-key") || "",
          subject: options.subject
        });
      }
    }
    return json({ error: "Method not allowed" }, 405);
  }

  async createRequest(input: Record<string, unknown>, options: MutationOptions): Promise<Response> {
    return this.withIdempotency("POST", "/v1/requests", input, options.idempotencyKey, async () => {
      const now = this.now().toISOString();
      const formatVersion = text(input.formatVersion) || "1.0";
      const major = Number.parseInt(formatVersion.split(".")[0] || "", 10);
      if (major !== 1) return { status: 400, body: { error: "Unsupported request formatVersion major" } };
      const source = sourceValue(input.source);
      if (!source.type) return { status: 400, body: { error: "source.type is required" } };
      const continuation = continuationValue(input.continuation);
      if (!continuation.ok) return { status: 400, body: { error: continuation.error } };
      const prompt = text(input.prompt) || text(input.title) || "Human input requested";
      const choices = Array.isArray(input.choices) ? input.choices.map(text).filter(Boolean).slice(0, 32) : [];
      const kind = text(input.kind) || (choices.length ? "choice" : "question");
      const draft = input.draft === true || input.status === "draft";
      const reviewable = !draft;
      const revision = 1;
      const request: HostedRequest = {
        id: crypto.randomUUID(),
        formatVersion,
        revision,
        kind,
        title: text(input.title) || prompt,
        description: nullableText(input.description) || undefined,
        prompt,
        body: nullableText(input.body),
        context: nullableText(input.context),
        choices,
        allowText: input.allowText !== false,
        target: object(input.target),
        status: draft ? "draft" : "pending",
        priority: input.priority === "low" || input.priority === "high" ? input.priority : "normal",
        source,
        subject: Object.keys(object(input.subject)).length ? object(input.subject) : undefined,
        artifacts: canonicalArtifacts(input.artifacts),
        decision: decisionRequirement(input.decision, prompt, choices),
        routing: object(input.routing),
        policy: object(input.policy),
        continuation: continuation.public,
        reviewable,
        metering: {
          firstReviewableRevision: reviewable ? revision : null,
          currentReviewableRevision: reviewable ? revision : null
        },
        createdAt: now,
        updatedAt: now,
        viewedAt: null,
        answeredAt: null,
        actedAt: null,
        resolvedAt: null,
        expiresAt: nullableText(input.expiresAt),
        publishedAt: kind === "visual-review" ? null : now,
        notifiedAt: null,
        notificationClickedAt: null,
        staleReason: null,
        attachments: [],
        responses: [],
        metadata: object(input.metadata)
      };
      await this.store.put(`request:${request.id}`, request);
      if (continuation.privateWebhookUrl) await this.store.put(`request:${request.id}:continuation:webhook`, { url: continuation.privateWebhookUrl });
      await this.appendEvent("request.created", request.id, request.revision, { request: publicRequest(request) });
      const reviewLink = reviewable ? await this.createDefaultReviewLink(request) : undefined;
      return { status: 201, body: cleanUndefined({ request: publicRequest(request), status: snapshotStatus(request), reviewLink }) };
    });
  }

  async listRequests(): Promise<{ requests: HostedRequest[] }> {
    const stored = await this.store.list<HostedRequest>("request:");
    return {
      requests: [...stored.values()]
        .filter((item) => item.kind !== "visual-review" || item.publishedAt)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(publicRequest)
    };
  }

  async getRequest(id: string, capabilityToken?: string, subject?: string): Promise<Response> {
    const access = await this.access(id, "view", { capabilityToken, subject });
    if (!access.ok) return access.response;
    const request = await this.getRequestRecord(id);
    return request ? json(await this.snapshotBody(request)) : notFound();
  }

  async createRevision(id: string, input: Record<string, unknown>, options: MutationOptions): Promise<Response> {
    return this.withIdempotency("POST", `/v1/requests/${id}/revisions`, input, options.idempotencyKey, async () => {
      const request = await this.getRequestRecord(id);
      if (!request) return { status: 404, body: { error: "Request not found" } };
      const patch = revisionPatch(input);
      const revisions = await this.revisions(id);
      const now = this.now().toISOString();
      const revision: HostedRevision = {
        id: crypto.randomUUID(),
        requestId: id,
        number: revisions.length + 1,
        requestRevision: (request.revision || 1) + 1,
        patch,
        createdAt: now,
        createdBy: options.subject || "unknown"
      };
      const draft = input.draft === true || input.status === "draft";
      const terminalStatus = terminalRevisionStatus(patch.status);
      applyRevision(request, patch);
      request.revision = revision.requestRevision;
      request.status = terminalStatus ?? (draft ? "draft" : "pending");
      request.reviewable = false;
      request.metering.currentReviewableRevision = null;
      if (terminalStatus) request.resolvedAt = now;
      request.updatedAt = now;
      await Promise.all([
        this.store.put(`request:${id}`, request),
        this.store.put(`request:${id}:revision:${revision.number.toString().padStart(12, "0")}`, revision)
      ]);
      await this.appendEvent("request.revised", id, request.revision, { revision: revision as unknown as JsonObject, request: publicRequest(request) });
      if (terminalStatus) {
        await this.appendEvent(`request.${terminalStatus}`, id, request.revision, { request: publicRequest(request) });
      }
      return { status: 201, body: { revision, request: publicRequest(request), status: snapshotStatus(request) } };
    });
  }

  async publishRevision(id: string, requestRevision: number, options: MutationOptions): Promise<Response> {
    return this.withIdempotency("POST", `/v1/requests/${id}/revisions/${requestRevision}/publish`, {}, options.idempotencyKey, async () => {
      const request = await this.getRequestRecord(id);
      if (!request) return { status: 404, body: { error: "Request not found" } };
      if (request.revision !== requestRevision) return { status: 409, body: { error: "Revision is not current" } };
      request.status = "pending";
      request.reviewable = true;
      request.metering.firstReviewableRevision ??= request.revision;
      request.metering.currentReviewableRevision = request.revision;
      request.updatedAt = this.now().toISOString();
      await this.store.put(`request:${id}`, request);
      await this.appendEvent("request.published", id, request.revision, { request: publicRequest(request) });
      const reviewLink = await this.createDefaultReviewLink(request);
      return { status: 200, body: { request: publicRequest(request), status: snapshotStatus(request), reviewLink } };
    });
  }

  async listRevisions(id: string, capabilityToken?: string, subject?: string): Promise<Response> {
    const access = await this.access(id, "view", { capabilityToken, subject });
    if (!access.ok) return access.response;
    return json({ revisions: await this.revisions(id) });
  }

  async createDecision(id: string, input: Record<string, unknown>, options: MutationOptions): Promise<Response> {
    return this.withIdempotency("POST", `/v1/requests/${id}/decisions`, input, options.idempotencyKey, async () => {
      const access = await this.access(id, "decide", options);
      if (!access.ok) return { status: access.response.status, body: await access.response.json() as JsonObject };
      const request = await this.getRequestRecord(id);
      if (!request) return { status: 404, body: { error: "Request not found" } };
      const submittedOutcome = text(input.outcome) || text(input.value) || text(input.decision) || text(input.choice);
      const outcome = normalizedOutcome(submittedOutcome);
      if (!outcome) return { status: 400, body: { error: "Decision value is required" } };
      const now = this.now().toISOString();
      const decisionSequence = (await valuesByCreatedAt<HostedDecision>(this.store, `request:${id}:decision:`)).length + 1;
      const decision: HostedDecision = {
        id: crypto.randomUUID(),
        type: "decision",
        requestId: id,
        requestRevision: request.revision || 0,
        sequence: decisionSequence,
        outcome,
        value: outcome,
        comment: nullableText(input.comment),
        data: decisionData(input, submittedOutcome, outcome),
        terminal: input.terminal === true,
        createdAt: now,
        createdBy: access.context.subject,
        reviewer: reviewerIdentity(input.reviewer, access.context.subject),
        capabilityId: access.context.capabilityId
      };
      request.status = outcome;
      request.reviewable = false;
      request.answeredAt ??= now;
      request.updatedAt = now;
      await Promise.all([
        this.store.put(`request:${id}`, request),
        this.store.put(`request:${id}:decision:${decision.id}`, decision)
      ]);
      const event = await this.appendEvent("decision.created", id, decision.requestRevision, { decision: decision as unknown as JsonObject });
      if (decision.terminal) await this.deliverContinuation(request, event);
      return { status: 201, body: { decision, request: publicRequest(request), status: snapshotStatus(request, decision) } };
    });
  }

  async listDecisions(id: string, capabilityToken?: string, subject?: string): Promise<Response> {
    const access = await this.access(id, "view", { capabilityToken, subject });
    if (!access.ok) return access.response;
    return json({ decisions: await valuesByCreatedAt<HostedDecision>(this.store, `request:${id}:decision:`) });
  }

  async createFeedback(id: string, input: Record<string, unknown>, options: MutationOptions): Promise<Response> {
    return this.withIdempotency("POST", `/v1/requests/${id}/feedback`, input, options.idempotencyKey, async () => {
      const access = await this.access(id, "comment", options);
      if (!access.ok) return { status: access.response.status, body: await access.response.json() as JsonObject };
      const message = text(input.message) || text(input.comment) || text(input.text);
      if (!message) return { status: 400, body: { error: "Feedback message is required" } };
      const now = this.now().toISOString();
      const feedback: HostedFeedback = {
        id: crypto.randomUUID(),
        requestId: id,
        kind: text(input.kind) || "comment",
        message,
        data: object(input.data),
        createdAt: now,
        createdBy: access.context.subject,
        capabilityId: access.context.capabilityId
      };
      await this.store.put(`request:${id}:feedback:${feedback.id}`, feedback);
      await this.appendEvent("feedback.created", id, (await this.getRequestRecord(id))?.revision ?? 0, { feedback: feedback as unknown as JsonObject });
      return { status: 201, body: { feedback } };
    });
  }

  async listFeedback(id: string, capabilityToken?: string, subject?: string): Promise<Response> {
    const access = await this.access(id, "view", { capabilityToken, subject });
    if (!access.ok) return access.response;
    return json({ feedback: await valuesByCreatedAt<HostedFeedback>(this.store, `request:${id}:feedback:`) });
  }

  async createCapability(id: string, input: Record<string, unknown>, options: MutationOptions): Promise<Response> {
    return this.withIdempotency("POST", `/v1/requests/${id}/capabilities`, input, options.idempotencyKey, async () => {
      if (!await this.getRequestRecord(id)) return { status: 404, body: { error: "Request not found" } };
      const scopes = normalizedCapabilityScopes(input.scopes);
      const token = randomToken("nib_review");
      const now = this.now().toISOString();
      const capability: HostedCapability = {
        id: crypto.randomUUID(),
        requestId: id,
        tokenHash: await sha256(token),
        scopes,
        createdAt: now,
        expiresAt: nullableText(input.expiresAt),
        revokedAt: null,
        lastUsedAt: null,
        name: nullableText(input.name)
      };
      await this.store.put(`request:${id}:capability:${capability.id}`, capability);
      await this.appendEvent("capability.created", id, (await this.getRequestRecord(id))?.revision ?? 0, { capability: publicCapability(capability) });
      return {
        status: 201,
        body: {
          token,
          capability: publicCapability(capability),
          link: `/r/${encodeURIComponent(id)}#token=${encodeURIComponent(token)}`
        }
      };
    });
  }

  async listCapabilities(id: string): Promise<Response> {
    if (!await this.getRequestRecord(id)) return notFound();
    const capabilities = await valuesByCreatedAt<HostedCapability>(this.store, `request:${id}:capability:`);
    return json({ capabilities: capabilities.map(publicCapability) });
  }

  async revokeCapability(id: string, capabilityId: string, options: MutationOptions): Promise<Response> {
    return this.withIdempotency("POST", `/v1/requests/${id}/capabilities/${capabilityId}/revoke`, {}, options.idempotencyKey, async () => {
      const key = `request:${id}:capability:${capabilityId}`;
      const capability = await this.store.get<HostedCapability>(key);
      if (!capability) return { status: 404, body: { error: "Capability not found" } };
      capability.revokedAt ??= this.now().toISOString();
      await this.store.put(key, capability);
      await this.appendEvent("capability.revoked", id, (await this.getRequestRecord(id))?.revision ?? 0, { capability: publicCapability(capability) });
      return { status: 200, body: { capability: publicCapability(capability) } };
    });
  }

  async createReviewSession(id: string, capabilityToken: string): Promise<Response> {
    if (!capabilityToken) return unauthorized();
    const access = await this.access(id, "view", { capabilityToken });
    if (!access.ok) return access.response;
    if (!access.context.capabilityId) return forbidden("valid capability");
    const sessionToken = randomToken("nib_session");
    const now = this.now();
    const session: HostedReviewSession = {
      id: crypto.randomUUID(),
      requestId: id,
      sessionHash: await sha256(sessionToken),
      capabilityId: access.context.capabilityId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + REVIEW_SESSION_MAX_AGE_SECONDS * 1000).toISOString(),
      revokedAt: null
    };
    await this.store.put(`request:${id}:session:${session.sessionHash}`, session);
    return new Response(null, {
      status: 204,
      headers: {
        "cache-control": "no-store",
        "set-cookie": `${REVIEW_SESSION_COOKIE}=${sessionToken}; Max-Age=${REVIEW_SESSION_MAX_AGE_SECONDS}; Path=/v1/requests/${encodeURIComponent(id)}; HttpOnly; Secure; SameSite=Strict`
      }
    });
  }

  async initiateArtifact(id: string, input: Record<string, unknown>, options: MutationOptions): Promise<Response> {
    return this.withIdempotency("POST", `/v1/requests/${id}/artifacts`, input, options.idempotencyKey, async () => {
      if (!await this.getRequestRecord(id)) return { status: 404, body: { error: "Request not found" } };
      const name = safeName(text(input.name) || "artifact");
      const bytes = number(input.bytes);
      if (bytes < 0) return { status: 400, body: { error: "Artifact bytes must be zero or greater" } };
      const artifactHash = normalizedSha256(input.sha256);
      if (input.sha256 && !artifactHash) return { status: 400, body: { error: "Artifact SHA-256 must be 64 lowercase hex characters" } };
      const artifactId = crypto.randomUUID();
      const objectKey = `artifacts/${id}/${artifactId}`;
      const now = this.now();
      const requestedPartSize = number(input.partSize);
      const partSize = requestedPartSize > 0
        ? Math.max(requestedPartSize, MIN_MULTIPART_PART_BYTES)
        : DEFAULT_MULTIPART_PART_BYTES;
      const uploadMode = bytes > SINGLE_UPLOAD_MAX_BYTES || (requestedPartSize > 0 && bytes > partSize) ? "multipart" : "single";
      const parts = uploadMode === "multipart" ? multipartParts(id, artifactId, bytes, partSize, input.parts) : [];
      const multipart = uploadMode === "multipart"
        ? await this.media.createMultipart(objectKey, {
          httpMetadata: { contentType: text(input.contentType) || "application/octet-stream" },
          customMetadata: cleanStringMetadata({ requestId: id, artifactId, sha256: artifactHash || undefined })
        })
        : { uploadId: null };
      const artifact: HostedArtifact = {
        id: artifactId,
        requestId: id,
        objectKey,
        name,
        contentType: text(input.contentType) || "application/octet-stream",
        bytes,
        sha256: artifactHash,
        uploadMode,
        uploadId: multipart.uploadId,
        partSize,
        parts,
        status: "pending",
        uploadUrl: `/v1/requests/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}/complete`,
        completeUrl: `/v1/requests/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}/complete`,
        abortUrl: `/v1/requests/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}/abort`,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        completedAt: null,
        abortedAt: null,
        metadata: object(input.metadata)
      };
      await this.store.put(`request:${id}:artifact:${artifactId}`, artifact);
      await this.appendEvent("artifact.initiated", id, (await this.getRequestRecord(id))?.revision ?? 0, { artifact: artifact as unknown as JsonObject });
      return { status: 201, body: { artifact } };
    });
  }

  async completeArtifact(id: string, artifactId: string, body: ArrayBuffer | Uint8Array, options: MutationOptions): Promise<Response> {
    return this.withIdempotency("POST", `/v1/requests/${id}/artifacts/${artifactId}/complete`, { bytes: body.byteLength }, options.idempotencyKey, async () => {
      const key = `request:${id}:artifact:${artifactId}`;
      const artifact = await this.store.get<HostedArtifact>(key);
      if (!artifact) return { status: 404, body: { error: "Artifact not found" } };
      if (artifact.status === "aborted") return { status: 409, body: { error: "Artifact upload is aborted" } };
      if (artifact.uploadMode === "multipart") return { status: 409, body: { error: "Multipart artifact requires part upload routes" } };
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
      if (artifact.bytes !== bytes.byteLength) return { status: 400, body: { error: "Artifact byte count does not match initiation" } };
      if (artifact.sha256 && await sha256Bytes(bytes) !== artifact.sha256) {
        return { status: 400, body: { error: "Artifact SHA-256 does not match initiation" } };
      }
      await this.media.put(artifact.objectKey, bytes, {
        httpMetadata: { contentType: artifact.contentType },
        customMetadata: { requestId: id, artifactId }
      });
      const now = this.now().toISOString();
      artifact.status = "completed";
      artifact.completedAt ??= now;
      await this.store.put(key, artifact);
      await this.appendEvent("artifact.completed", id, (await this.getRequestRecord(id))?.revision ?? 0, { artifact: artifact as unknown as JsonObject });
      return { status: 200, body: { artifact } };
    });
  }

  async completeArtifactPart(id: string, artifactId: string, partNumber: number, body: ArrayBuffer | Uint8Array, options: MutationOptions): Promise<Response> {
    return this.withIdempotency("PUT", `/v1/requests/${id}/artifacts/${artifactId}/parts/${partNumber}`, { bytes: body.byteLength, partNumber }, options.idempotencyKey, async () => {
      const key = `request:${id}:artifact:${artifactId}`;
      const artifact = await this.store.get<HostedArtifact>(key);
      if (!artifact) return { status: 404, body: { error: "Artifact not found" } };
      if (artifact.uploadMode !== "multipart") return { status: 409, body: { error: "Artifact does not use multipart upload" } };
      if (!artifact.uploadId) return { status: 409, body: { error: "Multipart upload is missing uploadId" } };
      const part = artifact.parts.find((entry) => entry.number === partNumber);
      if (!part) return { status: 404, body: { error: "Artifact part not found" } };
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
      if (part.bytes !== bytes.byteLength) return { status: 400, body: { error: "Artifact part byte count does not match initiation" } };
      if (part.sha256 && await sha256Bytes(bytes) !== part.sha256) {
        return { status: 400, body: { error: "Artifact part SHA-256 does not match expected full artifact segment" } };
      }
      const uploaded = await this.media.uploadMultipartPart(artifact.objectKey, artifact.uploadId, partNumber, bytes);
      part.status = "completed";
      part.sha256 ??= await sha256Bytes(bytes);
      part.etag = uploaded.etag;
      await this.store.put(key, artifact);
      await this.appendEvent("artifact.part.completed", id, (await this.getRequestRecord(id))?.revision ?? 0, { artifactId, part: part as unknown as JsonObject });
      return { status: 200, body: { artifact, part } };
    });
  }

  async finalizeArtifact(id: string, artifactId: string, options: MutationOptions): Promise<Response> {
    return this.withIdempotency("POST", `/v1/requests/${id}/artifacts/${artifactId}/finalize`, {}, options.idempotencyKey, async () => {
      const key = `request:${id}:artifact:${artifactId}`;
      const artifact = await this.store.get<HostedArtifact>(key);
      if (!artifact) return { status: 404, body: { error: "Artifact not found" } };
      if (artifact.status === "completed") return { status: 200, body: { artifact } };
      if (artifact.uploadMode !== "multipart") return { status: 409, body: { error: "Artifact does not use multipart upload" } };
      if (!artifact.uploadId) return { status: 409, body: { error: "Multipart upload is missing uploadId" } };
      if (artifact.parts.some((part) => part.status !== "completed")) {
        return { status: 409, body: { error: "Multipart artifact has incomplete parts" } };
      }
      const uploadedParts = artifact.parts.map((part) => ({ partNumber: part.number, etag: text(part.etag) }));
      if (uploadedParts.some((part) => !part.etag)) return { status: 409, body: { error: "Multipart artifact has incomplete parts" } };
      await this.media.completeMultipart(artifact.objectKey, artifact.uploadId, uploadedParts, {
        httpMetadata: { contentType: artifact.contentType },
        customMetadata: cleanStringMetadata({ requestId: id, artifactId, sha256: artifact.sha256 || undefined })
      });
      artifact.status = "completed";
      artifact.completedAt ??= this.now().toISOString();
      await this.store.put(key, artifact);
      await this.appendEvent("artifact.completed", id, (await this.getRequestRecord(id))?.revision ?? 0, { artifact: artifact as unknown as JsonObject });
      return { status: 200, body: { artifact } };
    });
  }

  async abortArtifact(id: string, artifactId: string, options: MutationOptions): Promise<Response> {
    return this.withIdempotency("POST", `/v1/requests/${id}/artifacts/${artifactId}/abort`, {}, options.idempotencyKey, async () => {
      const key = `request:${id}:artifact:${artifactId}`;
      const artifact = await this.store.get<HostedArtifact>(key);
      if (!artifact) return { status: 404, body: { error: "Artifact not found" } };
      if (artifact.uploadMode === "multipart" && artifact.uploadId && artifact.status !== "completed") {
        await this.media.abortMultipart(artifact.objectKey, artifact.uploadId);
      }
      await this.media.delete(artifact.objectKey);
      artifact.status = "aborted";
      artifact.abortedAt ??= this.now().toISOString();
      await this.store.put(key, artifact);
      await this.appendEvent("artifact.aborted", id, (await this.getRequestRecord(id))?.revision ?? 0, { artifact: artifact as unknown as JsonObject });
      return { status: 200, body: { artifact } };
    });
  }

  async listArtifacts(id: string, capabilityToken?: string, subject?: string): Promise<Response> {
    const access = await this.access(id, "view", { capabilityToken, subject });
    if (!access.ok) return access.response;
    return json({ artifacts: await valuesByCreatedAt<HostedArtifact>(this.store, `request:${id}:artifact:`) });
  }

  async artifactContent(id: string, artifactId: string, request: Request, options: { subject?: string; capabilityToken?: string }): Promise<Response> {
    const access = await this.access(id, "view", options);
    if (!access.ok) return access.response;
    const artifact = await this.store.get<HostedArtifact>(`request:${id}:artifact:${artifactId}`);
    if (!artifact || artifact.status !== "completed") return json({ error: "Artifact not found" }, 404);
    const bytes = await this.media.get(artifact.objectKey);
    if (!bytes) return json({ error: "Artifact not found" }, 404);
    const headers = artifactContentHeaders(artifact.contentType, bytes.byteLength);
    const range = parseRange(request.headers.get("range"), bytes.byteLength);
    if (range) {
      headers.set("content-range", `bytes ${range.start}-${range.end}/${bytes.byteLength}`);
      headers.set("content-length", String(range.end - range.start + 1));
      return new Response(arrayBuffer(bytes.slice(range.start, range.end + 1)), { status: 206, headers });
    }
    headers.set("content-length", String(bytes.byteLength));
    return new Response(arrayBuffer(bytes), { status: 200, headers });
  }

  async listEvents(options: { after?: string; lastEventId?: string; requestId?: string }): Promise<{ events: HostedEvent[] }> {
    const cursor = cursorNumber(options.after || options.lastEventId || "0");
    const stored = await this.store.list<HostedEvent>("event:");
    const events = [...stored.values()]
      .filter((event) => cursorNumber(event.cursor) > cursor)
      .filter((event) => !options.requestId || event.requestId === options.requestId)
      .sort((left, right) => cursorNumber(left.cursor) - cursorNumber(right.cursor));
    return { events };
  }

  private async revisions(id: string): Promise<HostedRevision[]> {
    const stored = await this.store.list<HostedRevision>(`request:${id}:revision:`);
    return [...stored.values()].sort((left, right) => left.number - right.number);
  }

  private async snapshotBody(request: HostedRequest): Promise<JsonObject> {
    const decisions = await valuesByCreatedAt<HostedDecision>(this.store, `request:${request.id}:decision:`);
    const decision = decisions.at(-1);
    return cleanUndefined({
      request: publicRequest(request),
      status: snapshotStatus(request, decision),
      decision
    });
  }

  private async createDefaultReviewLink(request: HostedRequest): Promise<string> {
    const token = randomToken("nib_review");
    const capability: HostedCapability = {
      id: crypto.randomUUID(),
      requestId: request.id,
      tokenHash: await sha256(token),
      scopes: ["view", "comment", "decide"],
      createdAt: this.now().toISOString(),
      expiresAt: new Date(this.now().getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      revokedAt: null,
      lastUsedAt: null,
      name: "Default review link"
    };
    await this.store.put(`request:${request.id}:capability:${capability.id}`, capability);
    return `/r/${encodeURIComponent(request.id)}#token=${encodeURIComponent(token)}`;
  }

  private async getRequestRecord(id: string): Promise<HostedRequest | undefined> {
    const request = await this.store.get<HostedRequest>(`request:${id}`);
    if (!request) return undefined;
    request.metering ??= {
      firstReviewableRevision: request.reviewable ? request.revision : null,
      currentReviewableRevision: request.reviewable ? request.revision : null
    };
    return request;
  }

  private async access(id: string, scope: CapabilityScope, options: { subject?: string; capabilityToken?: string }): Promise<
    { ok: true; context: AccessContext } | { ok: false; response: Response }
  > {
    if (options.subject) return { ok: true, context: { subject: options.subject, capabilityId: null, scopes: "*" } };
    if (!options.capabilityToken) return { ok: false, response: unauthorized() };
    const capability = options.capabilityToken.startsWith("session:")
      ? await this.capabilityForSession(id, options.capabilityToken.slice("session:".length))
      : await this.capabilityForToken(id, options.capabilityToken);
    if (!capability) return { ok: false, response: forbidden("valid capability") };
    if (!capabilityAllows(capability.scopes, scope)) return { ok: false, response: forbidden(scope) };
    capability.lastUsedAt = this.now().toISOString();
    await this.store.put(`request:${id}:capability:${capability.id}`, capability);
    return { ok: true, context: { subject: `capability:${capability.id}`, capabilityId: capability.id, scopes: capability.scopes } };
  }

  private async capabilityForToken(id: string, token: string): Promise<HostedCapability | null> {
    const tokenHash = await sha256(token);
    const capabilities = await this.store.list<HostedCapability>(`request:${id}:capability:`);
    const now = this.now().getTime();
    for (const capability of capabilities.values()) {
      if (capability.tokenHash !== tokenHash) continue;
      if (!capabilityActive(capability, now)) return null;
      return capability;
    }
    return null;
  }

  private async capabilityForSession(id: string, sessionToken: string): Promise<HostedCapability | null> {
    const sessionHash = await sha256(sessionToken);
    const session = await this.store.get<HostedReviewSession>(`request:${id}:session:${sessionHash}`);
    const now = this.now().getTime();
    if (!session || session.requestId !== id || session.revokedAt) return null;
    if (new Date(session.expiresAt).getTime() <= now) return null;
    const capability = await this.store.get<HostedCapability>(`request:${id}:capability:${session.capabilityId}`);
    if (!capability || !capabilityActive(capability, now)) return null;
    return capability;
  }

  private async appendEvent(type: string, requestId: string | null, requestRevision: number | null, data: JsonObject): Promise<HostedEvent> {
    const next = (await this.store.get<number>("event:cursor")) || 0;
    const cursor = String(next + 1);
    const event: HostedEvent = {
      id: `evt_${cursor.padStart(16, "0")}`,
      cursor,
      sequence: next + 1,
      type,
      requestId,
      requestRevision,
      createdAt: this.now().toISOString(),
      data
    };
    await Promise.all([
      this.store.put("event:cursor", next + 1),
      this.store.put(`event:${cursor.padStart(16, "0")}`, event)
    ]);
    return event;
  }

  private async deliverContinuation(request: HostedRequest, event: HostedEvent): Promise<void> {
    const privateWebhook = await this.store.get<{ url: string }>(`request:${request.id}:continuation:webhook`);
    const url = text(privateWebhook?.url);
    if (!url || !this.continuationHooks.dispatch) return;
    const deliveryKey = `delivery:${event.id}:${await sha256(url)}`;
    if (await this.store.get(deliveryKey)) return;
    const unsigned = { url, event, request: publicRequest(request) };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.continuationHooks.sign) {
      headers["x-nib-event-signature"] = await this.continuationHooks.sign(unsigned);
    }
    const result = await this.continuationHooks.dispatch({ ...unsigned, headers });
    await this.store.put(deliveryKey, {
      eventId: event.id,
      url,
      status: result.status,
      ok: result.ok,
      deliveredAt: this.now().toISOString()
    });
  }

  private async withIdempotency(
    method: string,
    path: string,
    input: Record<string, unknown>,
    idempotencyKey: string,
    handler: () => Promise<{ status: number; body: JsonValue }>
  ): Promise<Response> {
    if (!idempotencyKey.trim()) return json({ error: "Idempotency-Key is required" }, 400);
    const fingerprint = await sha256(`${method} ${path}\n${canonicalJson(input as JsonValue)}`);
    const key = `idempotency:${await sha256(idempotencyKey)}`;
    const previous = await this.store.get<IdempotencyRecord>(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return json({ error: "Idempotency key reused with a different mutation" }, 409);
      }
      return json(previous.body, previous.status, { "x-nib-idempotent-replay": "true" });
    }
    const result = await handler();
    await this.store.put<IdempotencyRecord>(key, {
      fingerprint,
      status: result.status,
      body: result.body,
      createdAt: this.now().toISOString()
    });
    return json(result.body, result.status);
  }
}

export class MemoryKeyValueStore implements KeyValueStore {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list<T>(prefix: string): Promise<Map<string, T>> {
    const matches = new Map<string, T>();
    for (const [key, value] of this.values) {
      if (key.startsWith(prefix)) matches.set(key, value as T);
    }
    return matches;
  }
}

export class MemoryMediaStore implements MediaStore {
  readonly values = new Map<string, Uint8Array>();
  readonly multipart = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();

  async put(key: string, value: ArrayBuffer | Uint8Array): Promise<void> {
    this.values.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.values.get(key);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async createMultipart(key: string): Promise<{ uploadId: string }> {
    const uploadId = `mem_${crypto.randomUUID()}`;
    this.multipart.set(`${key}:${uploadId}`, { key, parts: new Map() });
    return { uploadId };
  }

  async uploadMultipartPart(key: string, uploadId: string, partNumber: number, value: ArrayBuffer | Uint8Array): Promise<UploadedPart> {
    const upload = this.multipart.get(`${key}:${uploadId}`);
    if (!upload) throw new Error("Unknown multipart upload");
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    upload.parts.set(partNumber, bytes);
    return { partNumber, etag: `mem-etag-${partNumber}-${bytes.byteLength}` };
  }

  async completeMultipart(key: string, uploadId: string): Promise<void> {
    const upload = this.multipart.get(`${key}:${uploadId}`);
    if (!upload) throw new Error("Unknown multipart upload");
    const chunks = [...upload.parts.entries()]
      .sort((left, right) => left[0] - right[0])
      .map((entry) => entry[1]);
    this.values.set(key, concatenate(chunks));
    this.multipart.delete(`${key}:${uploadId}`);
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    this.multipart.delete(`${key}:${uploadId}`);
  }
}

export function createHostedRequestCoreForTest(): HostedRequestCore {
  return new HostedRequestCoreService(new MemoryKeyValueStore(), new MemoryMediaStore());
}

export function json(value: JsonValue, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", ...extra } });
}

function eventStream(events: HostedEvent[]): Response {
  const body = events.map((event) => [
    `id: ${event.cursor}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    ""
  ].join("\n")).join("\n");
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function publicRequest(request: HostedRequest): HostedRequest {
  return request;
}

function publicCapability(capability: HostedCapability): Omit<HostedCapability, "tokenHash"> {
  const { tokenHash: _tokenHash, ...safe } = capability;
  return safe;
}

function revisionPatch(input: Record<string, unknown>): JsonObject {
  const allowed = ["title", "description", "prompt", "body", "context", "choices", "allowText", "status", "priority", "expiresAt", "metadata", "artifacts", "decision", "routing", "policy", "subject"];
  const patch: JsonObject = {};
  for (const key of allowed) {
    if (Object.hasOwn(input, key)) patch[key] = toJson(input[key]);
  }
  return patch;
}

function terminalRevisionStatus(value: JsonValue | undefined): "cancelled" | "expired" | null {
  return value === "cancelled" || value === "expired" ? value : null;
}

function applyRevision(request: HostedRequest, patch: JsonObject): void {
  if (typeof patch.title === "string") request.title = patch.title;
  if (typeof patch.description === "string") request.description = patch.description;
  if (typeof patch.prompt === "string") request.prompt = patch.prompt;
  if (typeof patch.body === "string" || patch.body === null) request.body = patch.body;
  if (typeof patch.context === "string" || patch.context === null) request.context = patch.context;
  if (Array.isArray(patch.choices)) request.choices = patch.choices.map(text).filter(Boolean);
  if (typeof patch.allowText === "boolean") request.allowText = patch.allowText;
  if (typeof patch.status === "string") request.status = patch.status;
  if (patch.priority === "low" || patch.priority === "normal" || patch.priority === "high") request.priority = patch.priority;
  if (typeof patch.expiresAt === "string" || patch.expiresAt === null) request.expiresAt = patch.expiresAt;
  if (patch.metadata && typeof patch.metadata === "object" && !Array.isArray(patch.metadata)) {
    request.metadata = { ...request.metadata, ...patch.metadata as JsonObject };
  }
  if (Array.isArray(patch.artifacts)) request.artifacts = canonicalArtifacts(patch.artifacts);
  if (patch.decision && typeof patch.decision === "object" && !Array.isArray(patch.decision)) {
    request.decision = decisionRequirement(patch.decision, request.prompt, request.choices);
  }
  if (patch.routing && typeof patch.routing === "object" && !Array.isArray(patch.routing)) request.routing = object(patch.routing);
  if (patch.policy && typeof patch.policy === "object" && !Array.isArray(patch.policy)) request.policy = object(patch.policy);
  if (patch.subject && typeof patch.subject === "object" && !Array.isArray(patch.subject)) request.subject = object(patch.subject);
}

async function valuesByCreatedAt<T extends { createdAt: string }>(store: KeyValueStore, prefix: string): Promise<T[]> {
  const stored = await store.list<T>(prefix);
  return [...stored.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function normalizedCapabilityScopes(value: unknown): CapabilityScope[] {
  const allowed = new Set<CapabilityScope>(["view", "comment", "decide"]);
  const scopes = Array.isArray(value) ? value.map(text).filter((scope): scope is CapabilityScope => allowed.has(scope as CapabilityScope)) : [];
  return scopes.length ? [...new Set(scopes)] : ["view"];
}

function capabilityAllows(scopes: CapabilityScope[], required: CapabilityScope): boolean {
  if (required === "view") return scopes.some((scope) => scope === "view" || scope === "comment" || scope === "decide");
  return scopes.includes(required);
}

function capabilityTokenFor(request: Request): string {
  const sessionToken = cookieValue(request.headers.get("cookie") || "", REVIEW_SESSION_COOKIE);
  return rawCapabilityTokenFor(request) || (sessionToken ? `session:${sessionToken}` : "");
}

function rawCapabilityTokenFor(request: Request): string {
  const url = new URL(request.url);
  return url.searchParams.get("capability") ||
    request.headers.get("x-nib-capability") ||
    request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ||
    "";
}

function cookieValue(header: string, name: string): string {
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const key = pair.slice(0, separator).trim();
    if (key !== name) continue;
    return pair.slice(separator + 1).trim();
  }
  return "";
}

function capabilityActive(capability: HostedCapability, now: number): boolean {
  if (capability.revokedAt) return false;
  if (capability.expiresAt && new Date(capability.expiresAt).getTime() <= now) return false;
  return true;
}

function unauthorized(): Response {
  return json({ error: "Unauthorized" }, 401, { "www-authenticate": "Bearer realm=\"nib-global\"" });
}

function forbidden(scope: string): Response {
  return json({ error: "Forbidden", requiredScope: scope }, 403);
}

function notFound(): Response {
  return json({ error: "Request not found" }, 404);
}

function randomToken(prefix: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const encoded = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${prefix}_${encoded}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const objectValue = value as Record<string, unknown>;
  return `{${Object.keys(objectValue).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key])}`).join(",")}}`;
}

function toJson(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === "object") {
    const result: JsonObject = {};
    for (const [key, child] of Object.entries(value)) result[key] = toJson(child);
    return result;
  }
  return null;
}

function sourceValue(value: unknown): JsonObject {
  if (value === undefined) return { type: "hosted", system: "nib-global" };
  return object(value);
}

function decisionRequirement(value: unknown, prompt: string, choices: string[]): JsonObject {
  const supplied = object(value);
  const decisionType = text(supplied.type) || "approval";
  const decision: JsonObject = { ...supplied, type: decisionType };
  if (!decision.prompt) decision.prompt = prompt;
  if (!Array.isArray(decision.options) && choices.length) {
    decision.options = choices.map((choice) => ({ id: choice, label: choice }));
  }
  return decision;
}

function canonicalArtifacts(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object).filter((artifact) => text(artifact.id) && text(artifact.type)) : [];
}

function continuationValue(value: unknown): { ok: true; public: JsonObject; privateWebhookUrl?: string } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, public: {} };
  const continuation = object(value);
  if (text(continuation.type) !== "webhook") return { ok: true, public: continuation };
  const url = text(continuation.url);
  if (!url || !isHttpsUrl(url)) return { ok: false, error: "Webhook continuation URL must use HTTPS" };
  return { ok: true, public: { type: "webhook", configured: true }, privateWebhookUrl: url };
}

function snapshotStatus(request: HostedRequest, decision?: HostedDecision): string {
  if (decision) return decision.outcome;
  if (request.status === "cancelled" || request.status === "expired") return request.status;
  return "pending";
}

function cleanUndefined(value: Record<string, unknown>): JsonObject {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

function normalizedOutcome(value: string): "approved" | "rejected" | "changes_requested" | "" {
  const normalized = value.toLowerCase().trim();
  if (normalized === "approved" || normalized === "approve") return "approved";
  if (normalized === "rejected" || normalized === "reject") return "rejected";
  if (normalized === "changes_requested" || normalized === "change requested" || normalized === "changes" || normalized === "revise") {
    return "changes_requested";
  }
  return normalized ? "changes_requested" : "";
}

function decisionData(input: Record<string, unknown>, submittedOutcome: string, outcome: string): JsonObject {
  const data = object(input.data);
  if (submittedOutcome && submittedOutcome !== outcome) data.selectedOption = submittedOutcome;
  return data;
}

function reviewerIdentity(value: unknown, fallbackId: string): JsonObject {
  const reviewer = object(value);
  return {
    ...reviewer,
    id: text(reviewer.id) || fallbackId,
    type: text(reviewer.type) || "capability"
  };
}

function normalizedSha256(value: unknown): string | null {
  const hash = text(value).toLowerCase();
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

function cleanStringMetadata(value: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function multipartParts(requestId: string, artifactId: string, bytes: number, partSize: number, inputParts: unknown): HostedArtifactPart[] {
  const expectedHashes = new Map<number, string>();
  if (Array.isArray(inputParts)) {
    for (const entry of inputParts) {
      const item = object(entry);
      const partNumber = number(item.number);
      const hash = normalizedSha256(item.sha256);
      if (partNumber > 0 && hash) expectedHashes.set(partNumber, hash);
    }
  }
  const parts: HostedArtifactPart[] = [];
  for (let offset = 0; offset < bytes; offset += partSize) {
    const partNumber = parts.length + 1;
    parts.push({
      number: partNumber,
      bytes: Math.min(partSize, bytes - offset),
      url: `/v1/requests/${encodeURIComponent(requestId)}/artifacts/${encodeURIComponent(artifactId)}/parts/${partNumber}`,
      status: "pending",
      sha256: expectedHashes.get(partNumber) || null
    });
  }
  return parts;
}

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value: unknown): string | null {
  return text(value) || null;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? toJson(value) as JsonObject : {};
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeName(value: string): string {
  return value.split(/[\\/]/).pop()?.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180) || "artifact";
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function artifactContentHeaders(contentType: string, byteLength: number): Headers {
  return new Headers({
    "content-type": contentType,
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'",
    "etag": `"${byteLength}"`
  });
}

function parseRange(value: string | null, byteLength: number): { start: number; end: number } | null {
  const match = value?.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;
  const start = Number.parseInt(match[1], 10);
  const requestedEnd = match[2] ? Number.parseInt(match[2], 10) : byteLength - 1;
  if (!Number.isFinite(start) || !Number.isFinite(requestedEnd) || start < 0 || start >= byteLength || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, byteLength - 1) };
}

function cursorNumber(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
