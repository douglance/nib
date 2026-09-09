export const ACCEPTANCE_CONTRACT = "nib.acceptance/v1";
export const DEFAULT_ACCEPTANCE_TTL_SECONDS = 604_800;

const SHA256_HEX = /^[0-9a-f]{64}$/i;
const MAX_SHORT_TEXT_LENGTH = 512;
const MAX_LONG_TEXT_LENGTH = 16_384;
const MAX_CRITERIA = 100;
const MAX_EVIDENCE = 100;
const MAX_ASSUMPTIONS = 100;
const MAX_COMPONENTS = 100;

export class AcceptanceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly publicMessage: string;

  constructor(status: number, code: string, message: string) {
    super(encodeAcceptanceErrorMessage(status, code, message));
    this.name = "AcceptanceError";
    this.status = status;
    this.code = code;
    this.publicMessage = message;
  }
}

export type AcceptanceState =
  | "pending"
  | "approved"
  | "rejected"
  | "revision_requested"
  | "expired"
  | "superseded"
  | "invalidated";

export interface AcceptanceManifest {
  contract: typeof ACCEPTANCE_CONTRACT;
  projectId: string;
  subject: string;
  gate: string;
  title: string;
  request: string;
  change: string;
  criteria: AcceptanceCriterion[];
  build: AcceptanceBuild;
  evidence: AcceptanceEvidence[];
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
  verification?: string;
}

export interface AcceptanceBuild {
  repository?: { id: string; owner: string; name: string };
  commit: string;
  provider: "cloudflare" | "external";
  previewUrl: string;
  deployment: {
    id: string;
    components: {
      name: string;
      versionId: string;
      kind?: string;
    }[];
    configSha256?: string;
    assetsSha256?: string;
  };
  assumptions: string[];
}

export interface AcceptanceEvidence {
  id: string;
  kind: "image" | "video" | "test" | "document";
  label: string;
  url?: string;
  sha256?: string;
  contentType?: string;
}

export interface AcceptancePolicy {
  quorum: number;
  ttlSeconds: number;
}

export interface PublishContext {
  actorId: string;
  eligibleReviewers: string[];
  policy?: Partial<AcceptancePolicy>;
}

export interface AcceptanceVote {
  actorId: string;
  decision: AcceptanceDecision;
  comment?: string;
  criteriaIds: string[];
  createdAt: string;
}

export interface AcceptanceComment {
  id: string;
  actorId: string;
  text: string;
  createdAt: string;
}

export interface AcceptanceReview {
  id: string;
  projectId: string;
  subject: string;
  gate: string;
  revision: number;
  manifest: AcceptanceManifest;
  manifestHash: string;
  state: AcceptanceState;
  policy: AcceptancePolicy;
  eligibleReviewers: string[];
  createdAt: string;
  expiresAt: string;
  publishedBy: string;
  votes: AcceptanceVote[];
  comments: AcceptanceComment[];
  receipt: string | null;
  supersededBy?: string;
  invalidatedAt?: string;
  invalidatedBy?: string;
  invalidationReason?: string;
  expiredAt?: string;
}

export type AcceptanceDecision = "approve" | "reject" | "request_revision";

export interface DecisionInput {
  decision: AcceptanceDecision;
  comment?: string;
  criteriaIds: string[];
}

export interface VerifyExpected {
  manifestHash: string;
  commit?: string;
  subject?: string;
  gate?: string;
}

export interface AcceptanceVerifyResult {
  satisfied: boolean;
  state: AcceptanceState;
  reason?: string;
  receipt: string | null;
  reviewId: string;
  revision: number;
  manifestHash: string;
}

export type AcceptanceEventReason =
  | "published"
  | "approved"
  | "rejected"
  | "revision_requested"
  | "commented"
  | "preview_opened"
  | "expired"
  | "superseded_by_new_revision"
  | string;

export interface AcceptanceEvent {
  id: string;
  type: "acceptance.changed";
  projectId: string;
  reviewId: string;
  subject: string;
  gate: string;
  revision: number;
  sequence: number;
  state: AcceptanceState;
  manifestHash: string;
  occurredAt: string;
  receipt: string | null;
  manifest: AcceptanceManifest;
  actorId?: string;
  reason?: AcceptanceEventReason;
  supersededBy?: string;
  invalidatedAt?: string;
  invalidatedBy?: string;
  invalidationReason?: string;
  expiredAt?: string;
}

export function jsonAcceptanceError(error: unknown): Response {
  const parsed = parseAcceptanceError(error);
  if (parsed) {
    return Response.json(
      { error: { code: parsed.code, message: parsed.message } },
      { status: parsed.status },
    );
  }
  return Response.json(
    { error: { code: "ACCEPTANCE_INTERNAL_ERROR", message: "Acceptance request failed" } },
    { status: 500 },
  );
}

export function parseAcceptanceError(error: unknown): { status: number; code: string; message: string } | undefined {
  if (error instanceof AcceptanceError) {
    return { status: error.status, code: error.code, message: error.publicMessage };
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  if (!message?.startsWith("NIB_ACCEPTANCE_ERROR:")) return undefined;
  try {
    const parsed: unknown = JSON.parse(message.slice("NIB_ACCEPTANCE_ERROR:".length));
    if (!isRecord(parsed)) return undefined;
    if (typeof parsed.status !== "number" || typeof parsed.code !== "string" || typeof parsed.message !== "string") {
      return undefined;
    }
    return { status: parsed.status, code: parsed.code, message: parsed.message };
  } catch {
    return undefined;
  }
}

function encodeAcceptanceErrorMessage(status: number, code: string, message: string): string {
  return `NIB_ACCEPTANCE_ERROR:${JSON.stringify({ status, code, message })}`;
}

export function normalizeAcceptancePolicy(policy?: Partial<AcceptancePolicy>): AcceptancePolicy {
  const ttlSeconds = policy?.ttlSeconds ?? DEFAULT_ACCEPTANCE_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new AcceptanceError(400, "INVALID_ACCEPTANCE_POLICY", "Acceptance TTL must be a positive integer");
  }
  if (ttlSeconds > DEFAULT_ACCEPTANCE_TTL_SECONDS) {
    throw new AcceptanceError(400, "INVALID_ACCEPTANCE_POLICY", "Acceptance TTL cannot exceed 7 days");
  }
  const quorum = policy?.quorum ?? 1;
  if (!Number.isInteger(quorum) || quorum < 1) {
    throw new AcceptanceError(400, "INVALID_ACCEPTANCE_POLICY", "Acceptance quorum must be at least 1");
  }
  return { quorum, ttlSeconds };
}

export async function hashAcceptanceManifest(manifest: AcceptanceManifest): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(manifest));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function validateAcceptanceManifest(manifest: unknown): AcceptanceManifest {
  if (!isRecord(manifest)) throw invalidManifest("manifest must be an object");
  if (manifest.contract !== ACCEPTANCE_CONTRACT) throw invalidManifest("manifest contract must be nib.acceptance/v1");
  const projectId = requiredString(manifest.projectId, "projectId");
  const subject = requiredString(manifest.subject, "subject");
  const gate = requiredString(manifest.gate, "gate");
  const title = requiredString(manifest.title, "title");
  const request = requiredString(manifest.request, "request");
  const change = requiredString(manifest.change, "change");
  if (!Array.isArray(manifest.criteria) || manifest.criteria.length === 0) {
    throw invalidManifest("manifest criteria must include at least one item");
  }
  if (manifest.criteria.length > MAX_CRITERIA) throw invalidManifest(`manifest criteria cannot exceed ${MAX_CRITERIA} items`);
  const criterionIds = new Set<string>();
  const criteria = manifest.criteria.map((criterion, index) => {
    if (!isRecord(criterion)) throw invalidManifest(`criteria[${index}] must be an object`);
    const id = requiredString(criterion.id, `criteria[${index}].id`);
    if (criterionIds.has(id)) throw invalidManifest("criterion ids must be unique");
    criterionIds.add(id);
    const text = requiredString(criterion.text, `criteria[${index}].text`);
    const verification = optionalString(criterion.verification, `criteria[${index}].verification`);
    return verification === undefined ? { id, text } : { id, text, verification };
  });
  const build = validateBuild(manifest.build);
  const evidence = validateEvidence(manifest.evidence);
  return { contract: ACCEPTANCE_CONTRACT, projectId, subject, gate, title, request, change, criteria, build, evidence };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function validateBuild(value: unknown): AcceptanceBuild {
  if (!isRecord(value)) throw invalidManifest("manifest build must be an object");
  const repository = value.repository === undefined ? undefined : validateRepository(value.repository);
  const commit = requiredString(value.commit, "build.commit");
  if (value.provider !== "cloudflare" && value.provider !== "external") {
    throw invalidManifest("build.provider must be cloudflare or external");
  }
  const previewUrl = requiredString(value.previewUrl, "build.previewUrl");
  try {
    new URL(previewUrl);
  } catch {
    throw invalidManifest("build.previewUrl must be a valid URL");
  }
  if (!isRecord(value.deployment)) throw invalidManifest("build.deployment must be an object");
  const deploymentRecord = value.deployment;
  const deploymentId = requiredString(deploymentRecord.id, "build.deployment.id");
  if (!Array.isArray(deploymentRecord.components) || deploymentRecord.components.length === 0) {
    throw invalidManifest("build.deployment.components must include at least one component");
  }
  if (deploymentRecord.components.length > MAX_COMPONENTS) {
    throw invalidManifest(`build.deployment.components cannot exceed ${MAX_COMPONENTS} items`);
  }
  const components = deploymentRecord.components.map((component, index) => {
    if (!isRecord(component)) throw invalidManifest(`build.deployment.components[${index}] must be an object`);
    const name = requiredString(component.name, `build.deployment.components[${index}].name`);
    const versionId = requiredString(component.versionId, `build.deployment.components[${index}].versionId`);
    const kind = optionalString(component.kind, `build.deployment.components[${index}].kind`);
    return kind === undefined ? { name, versionId } : { name, versionId, kind };
  });
  const configSha256 = optionalSha256(deploymentRecord.configSha256, "build.deployment.configSha256");
  const assetsSha256 = optionalSha256(deploymentRecord.assetsSha256, "build.deployment.assetsSha256");
  if (!Array.isArray(value.assumptions) || !value.assumptions.every((item) => typeof item === "string")) {
    throw invalidManifest("build.assumptions must be a string array");
  }
  if (value.assumptions.length > MAX_ASSUMPTIONS) {
    throw invalidManifest(`build.assumptions cannot exceed ${MAX_ASSUMPTIONS} items`);
  }
  const deployment: AcceptanceBuild["deployment"] = { id: deploymentId, components };
  if (configSha256 !== undefined) deployment.configSha256 = configSha256;
  if (assetsSha256 !== undefined) deployment.assetsSha256 = assetsSha256;
  return {
    ...(repository === undefined ? {} : { repository }),
    commit,
    provider: value.provider,
    previewUrl,
    deployment,
    assumptions: value.assumptions.map((item, index) => boundedString(item, `build.assumptions[${index}]`)),
  };
}

function validateRepository(value: unknown): { id: string; owner: string; name: string } {
  if (!isRecord(value)) throw invalidManifest("build.repository must be an object");
  return {
    id: requiredString(value.id, "build.repository.id"),
    owner: requiredString(value.owner, "build.repository.owner"),
    name: requiredString(value.name, "build.repository.name"),
  };
}

function validateEvidence(value: unknown): AcceptanceEvidence[] {
  if (!Array.isArray(value)) throw invalidManifest("manifest evidence must be an array");
  if (value.length > MAX_EVIDENCE) throw invalidManifest(`manifest evidence cannot exceed ${MAX_EVIDENCE} items`);
  return value.map((item, index) => {
    if (!isRecord(item)) throw invalidManifest(`evidence[${index}] must be an object`);
    const id = requiredString(item.id, `evidence[${index}].id`);
    if (item.kind !== "image" && item.kind !== "video" && item.kind !== "test" && item.kind !== "document") {
      throw invalidManifest(`evidence[${index}].kind must be image, video, test, or document`);
    }
    const label = requiredString(item.label, `evidence[${index}].label`);
    const url = optionalString(item.url, `evidence[${index}].url`);
    if (url !== undefined) {
      try {
        new URL(url);
      } catch {
        throw invalidManifest(`evidence[${index}].url must be a valid URL`);
      }
    }
    const sha256 = optionalSha256(item.sha256, `evidence[${index}].sha256`);
    const contentType = optionalString(item.contentType, `evidence[${index}].contentType`);
    return {
      id,
      kind: item.kind,
      label,
      ...(url === undefined ? {} : { url }),
      ...(sha256 === undefined ? {} : { sha256 }),
      ...(contentType === undefined ? {} : { contentType }),
    };
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidManifest(`${field} must be a non-empty string`);
  }
  return boundedString(value, field);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw invalidManifest(`${field} must be a non-empty string`);
  return boundedString(value, field);
}

function optionalSha256(value: unknown, field: string): string | undefined {
  const text = optionalString(value, field);
  if (text !== undefined && !SHA256_HEX.test(text)) throw invalidManifest(`${field} must be a sha256 hex digest`);
  return text;
}

function boundedString(value: string, field: string): string {
  const limit = field === "request" || field === "change" || field.includes(".text") ? MAX_LONG_TEXT_LENGTH : MAX_SHORT_TEXT_LENGTH;
  if (value.length > limit) throw invalidManifest(`${field} cannot exceed ${limit} characters`);
  return value;
}

function invalidManifest(message: string): AcceptanceError {
  return new AcceptanceError(400, "INVALID_ACCEPTANCE_MANIFEST", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
