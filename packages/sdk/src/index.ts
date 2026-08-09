import {
  NIB_FORMAT_VERSION,
  type Artifact,
  type Continuation,
  type Decision,
  type DecisionRequirement,
  type JsonObject,
  type NibEvent,
  type NibRequest,
  type RequestStatus,
  type Source,
  type Subject,
} from "@nib/protocol";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface NibClientOptions {
  baseUrl?: string;
  token?: string;
  fetch?: FetchLike;
  source?: Source;
  clock?: () => Date;
  pollIntervalMs?: number;
}

export interface CreateRequestInput {
  id?: string;
  idempotencyKey?: string;
  title: string;
  description?: string;
  source?: Source;
  subject?: Subject;
  artifacts?: Artifact[];
  decision: DecisionRequirement;
  routing?: NibRequest["routing"];
  policy?: NibRequest["policy"];
  metadata?: NibRequest["metadata"];
  continuation?: Continuation;
  expiresAt?: string;
}

export interface RequestSnapshot {
  request: NibRequest;
  status: RequestStatus;
  decision?: Decision;
  events?: NibEvent[];
}

export interface EventStreamOptions {
  signal?: AbortSignal;
  afterSequence?: number;
  pollIntervalMs?: number;
  once?: boolean;
}

export interface WaitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  terminalStatuses?: RequestStatus[];
}

export interface RequestHandle {
  id: string;
  request: NibRequest;
  reviewLink?: string;
  get(): Promise<RequestSnapshot>;
  events(options?: EventStreamOptions): AsyncIterable<NibEvent>;
  wait(options?: WaitOptions): Promise<RequestSnapshot>;
}

export interface NibClient {
  request(input: CreateRequestInput): Promise<RequestHandle>;
  get(id: string): Promise<RequestSnapshot>;
  events(id: string, options?: EventStreamOptions): AsyncIterable<NibEvent>;
  wait(id: string, options?: WaitOptions): Promise<RequestSnapshot>;
  initiateArtifactUpload(requestId: string, input: ArtifactUploadInput): Promise<ArtifactUploadInitiation>;
  finalizeArtifactUpload(requestId: string, upload: ArtifactUploadInitiation): Promise<Artifact>;
  uploadArtifact(requestId: string, input: ArtifactUploadInput & { bytes: Uint8Array<ArrayBuffer> }): Promise<Artifact>;
}

export interface ArtifactUploadInput {
  id?: string;
  idempotencyKey?: string;
  title?: string;
  description?: string;
  type: Artifact["type"];
  mimeType?: string;
  byteLength: number;
  sha256: string;
  metadata?: JsonObject;
}

export interface ArtifactUploadInitiation {
  artifactId: string;
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
  finalizeUrl?: string;
}

export interface WebhookContinuationPayload {
  requestId: string;
  status?: RequestStatus;
  decision?: Decision;
  event?: NibEvent;
}

const defaultTerminalStatuses: RequestStatus[] = [
  "approved",
  "rejected",
  "changes_requested",
  "expired",
  "cancelled",
];

export function createNibClient(options: NibClientOptions = {}): NibClient {
  const baseUrl = trimTrailingSlash(options.baseUrl ?? readEnv("NIB_API_URL") ?? "https://nibtool.com");
  const token = options.token ?? readEnv("NIB_TOKEN");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const clock = options.clock ?? (() => new Date());
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;

  if (!fetchImpl) {
    throw new Error("A fetch implementation is required.");
  }

  async function request(input: CreateRequestInput): Promise<RequestHandle> {
    const body = buildRequest(input, options.source, clock);
    const operationIdempotencyKey = input.idempotencyKey ?? createId("idem");
    const snapshot = normalizeSnapshot(
      await requestJson<HostedSnapshotResponse>(
        fetchImpl,
        baseUrl,
        token,
        "/v1/requests",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
        operationIdempotencyKey,
      ),
      { includeReviewLink: true },
    );
    const created = snapshot.request ?? body;
    return createRequestHandle(created, {
      get: () => get(created.id),
      events: (eventOptions?: EventStreamOptions) => events(created.id, eventOptions),
      wait: (waitOptions?: WaitOptions) => wait(created.id, waitOptions),
    }, snapshot.reviewLink);
  }

  async function get(id: string): Promise<RequestSnapshot> {
    const response = await requestJson<HostedSnapshotResponse>(
      fetchImpl,
      baseUrl,
      token,
      `/v1/requests/${encodeURIComponent(id)}`,
    );
    return normalizeSnapshot(response);
  }

  async function* events(id: string, eventOptions: EventStreamOptions = {}): AsyncIterable<NibEvent> {
    let afterSequence = eventOptions.afterSequence ?? 0;
    const interval = eventOptions.pollIntervalMs ?? pollIntervalMs;

    while (!eventOptions.signal?.aborted) {
      const search = new URLSearchParams({ after: String(afterSequence) });
      const response = await requestJson<{ events?: NibEvent[] } | NibEvent[]>(
        fetchImpl,
        baseUrl,
        token,
        `/v1/requests/${encodeURIComponent(id)}/events?${search.toString()}`,
      );
      const nextEvents = Array.isArray(response) ? response : response.events ?? [];

      for (const event of nextEvents) {
        afterSequence = Math.max(afterSequence, event.sequence);
        yield event;
      }

      if (eventOptions.once) {
        return;
      }

      await delay(interval, eventOptions.signal);
    }
  }

  async function wait(id: string, waitOptions: WaitOptions = {}): Promise<RequestSnapshot> {
    const terminalStatuses = new Set(waitOptions.terminalStatuses ?? defaultTerminalStatuses);
    const startedAt = Date.now();
    const interval = waitOptions.pollIntervalMs ?? pollIntervalMs;

    while (!waitOptions.signal?.aborted) {
      const snapshot = await get(id);
      if (terminalStatuses.has(snapshot.status)) {
        return snapshot;
      }
      if (waitOptions.timeoutMs !== undefined && Date.now() - startedAt >= waitOptions.timeoutMs) {
        throw new Error(`Timed out waiting for Nib request ${id}.`);
      }
      await delay(interval, waitOptions.signal);
    }

    throw new Error(`Stopped waiting for Nib request ${id} because the signal was aborted.`);
  }

  async function initiateArtifactUpload(requestId: string, input: ArtifactUploadInput): Promise<ArtifactUploadInitiation> {
    return requestJson<ArtifactUploadInitiation>(
      fetchImpl,
      baseUrl,
      token,
      `/v1/requests/${encodeURIComponent(requestId)}/artifacts`,
      {
        method: "POST",
        body: JSON.stringify({
          id: input.id,
          title: input.title,
          description: input.description,
          type: input.type,
          mimeType: input.mimeType,
          byteLength: input.byteLength,
          sha256: input.sha256,
          metadata: input.metadata,
        }),
      },
      input.idempotencyKey,
    );
  }

  async function finalizeArtifactUpload(requestId: string, upload: ArtifactUploadInitiation): Promise<Artifact> {
    const finalizeUrl = upload.finalizeUrl ?? `${baseUrl}/v1/requests/${encodeURIComponent(requestId)}/artifacts/${encodeURIComponent(upload.artifactId)}/finalize`;
    const response = await requestAbsoluteJson<{ artifact: Artifact } | Artifact>(fetchImpl, token, finalizeUrl, {
      method: "POST",
      body: JSON.stringify({ artifactId: upload.artifactId }),
    });
    return isObject(response) && "artifact" in response ? (response.artifact as Artifact) : response;
  }

  async function uploadArtifact(requestId: string, input: ArtifactUploadInput & { bytes: Uint8Array<ArrayBuffer> }): Promise<Artifact> {
    const upload = await initiateArtifactUpload(requestId, input);
    await uploadBytes(fetchImpl, upload.uploadUrl, input.bytes, upload.uploadHeaders);
    return finalizeArtifactUpload(requestId, upload);
  }

  return { request, get, events, wait, initiateArtifactUpload, finalizeArtifactUpload, uploadArtifact };
}

export const nib = createNibClient();

export function buildRequest(input: CreateRequestInput, defaultSource?: Source, clock: () => Date = () => new Date()): NibRequest {
  return {
    id: input.id ?? createId("req"),
    formatVersion: NIB_FORMAT_VERSION,
    revision: 1,
    title: input.title,
    description: input.description,
    source: input.source ?? defaultSource ?? { type: "sdk", system: "@nib/sdk" },
    subject: input.subject,
    artifacts: input.artifacts ?? [],
    decision: input.decision,
    routing: input.routing,
    policy: input.policy,
    metadata: input.metadata,
    continuation: input.continuation,
    createdAt: clock().toISOString(),
    expiresAt: input.expiresAt,
  };
}

export function webhookContinuation(url: string): Continuation {
  return { type: "webhook", url };
}

export function parseWebhookContinuation(payload: unknown): WebhookContinuationPayload {
  if (!isObject(payload) || typeof payload.requestId !== "string") {
    throw new Error("Invalid Nib webhook continuation payload.");
  }
  return payload as unknown as WebhookContinuationPayload;
}

function createRequestHandle(
  request: NibRequest,
  client: Pick<RequestHandle, "get" | "events" | "wait">,
  reviewLink?: string,
): RequestHandle {
  return {
    id: request.id,
    request,
    reviewLink,
    get: client.get,
    events: client.events,
    wait: client.wait,
  };
}

async function requestJson<T>(
  fetchImpl: FetchLike,
  baseUrl: string,
  token: string | undefined,
  path: string,
  init: RequestInit = {},
  idempotencyKey?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  if (idempotencyKey) {
    headers.set("idempotency-key", idempotencyKey);
  }

  const requestInit = { ...init, headers };
  let response = await fetchImpl(`${baseUrl}${path}`, requestInit);
  if (shouldRetry(response)) {
    response = await fetchImpl(`${baseUrl}${path}`, requestInit);
  }
  if (!response.ok) {
    throw new Error(`Nib API request failed with ${response.status}.`);
  }
  return (await response.json()) as T;
}

async function requestAbsoluteJson<T>(
  fetchImpl: FetchLike,
  token: string | undefined,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  const response = await fetchImpl(url, { ...init, headers });
  if (!response.ok) {
    throw new Error(`Nib API request failed with ${response.status}.`);
  }
  return (await response.json()) as T;
}

async function uploadBytes(
  fetchImpl: FetchLike,
  uploadUrl: string,
  bytes: Uint8Array<ArrayBuffer>,
  uploadHeaders: Record<string, string> | undefined,
): Promise<void> {
  const response = await fetchImpl(uploadUrl, {
    method: "PUT",
    headers: uploadHeaders,
    body: new Blob([bytes]),
  });
  if (!response.ok) {
    throw new Error(`Nib artifact upload failed with ${response.status}.`);
  }
}

type HostedSnapshotResponse = {
  request?: NibRequest;
  status?: RequestStatus;
  decision?: Decision;
  events?: NibEvent[];
  reviewLink?: string;
};

type NormalizedCreateSnapshot = RequestSnapshot & { reviewLink?: string };

function normalizeSnapshot(
  response: HostedSnapshotResponse,
  options: { includeReviewLink?: boolean } = {},
): NormalizedCreateSnapshot {
  if (!response.request) {
    throw new Error("Nib API response did not include a request.");
  }
  const snapshot: NormalizedCreateSnapshot = {
    request: response.request,
    status: response.status ?? inferStatus(response.decision, response.request),
    decision: response.decision,
    events: response.events,
  };
  if (options.includeReviewLink && typeof response.reviewLink === "string") {
    snapshot.reviewLink = response.reviewLink;
  }
  return snapshot;
}

function inferStatus(decision?: Decision, request?: NibRequest): RequestStatus {
  const metadataStatus = request?.metadata?.status;
  if (isRequestStatus(metadataStatus)) {
    return metadataStatus;
  }
  if (!decision) {
    return "pending";
  }
  return decision.outcome === "approved" ? "approved" : decision.outcome;
}

function shouldRetry(response: Response): boolean {
  return response.status === 429 || response.status >= 500;
}

function isRequestStatus(value: unknown): value is RequestStatus {
  return (
    value === "pending" ||
    value === "approved" ||
    value === "rejected" ||
    value === "changes_requested" ||
    value === "expired" ||
    value === "cancelled"
  );
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Operation aborted."));
      },
      { once: true },
    );
  });
}

function createId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}_${random.replace(/-/g, "")}`;
}

function readEnv(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env[name] : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
