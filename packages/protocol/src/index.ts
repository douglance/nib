// Mirrors the canonical nib-protocol 0.1.0 wire types defined in Rust.

export const NIB_FORMAT_VERSION = "1.0" as const;

export type JsonObject = Record<string, unknown>;

export interface ReviewerIdentity extends JsonObject {
  id: string;
  type: string;
  name?: string;
  email?: string;
}

export interface Source extends JsonObject {
  type: string;
  system?: string;
  reference?: string;
  actor?: ReviewerIdentity;
}

export interface Subject extends JsonObject {
  type: string;
  id?: string;
  title?: string;
  metadata?: JsonObject;
}

export type ArtifactSource =
  | ({
      type: "embedded";
      path: string;
      sha256: string;
      byteLength: number;
    } & JsonObject)
  | ({
      type: "external";
      url: string;
      sha256: string;
      byteLength: number;
    } & JsonObject);

export interface ArtifactRelationship extends JsonObject {
  type: string;
  artifactId: string;
}

export interface Artifact extends JsonObject {
  id: string;
  type: "image" | "video" | "html" | "url" | "markdown" | "text" | "json" | "file" | string;
  title?: string;
  description?: string;
  mimeType?: string;
  source: ArtifactSource;
  metadata?: JsonObject;
  relationships?: ArtifactRelationship[];
}

export interface DecisionOption extends JsonObject {
  id: string;
  label: string;
  description?: string;
}

export interface DecisionRequirement extends JsonObject {
  type: string;
  prompt?: string;
  options?: DecisionOption[];
}

export type ApprovalRequirement =
  | ({ type: "human"; count: number } & JsonObject)
  | ({ type: "agent"; agentType: string; verdict: string } & JsonObject)
  | ({ type: "user"; userId: string } & JsonObject)
  | ({ type: "team"; teamId: string } & JsonObject)
  | ({ type: "audience"; count: number } & JsonObject);

export type ApprovalPolicy =
  | ({ type: "all"; requirements: ApprovalRequirement[] } & JsonObject)
  | ({ type: "any"; requirements: ApprovalRequirement[] } & JsonObject)
  | ({ type: "quorum"; reviewers: number; threshold: number } & JsonObject);

export interface ReviewerTarget extends JsonObject {
  type: string;
  id: string;
  reason?: string;
}

export interface RoutingPolicy extends JsonObject {
  reviewers?: ReviewerTarget[];
  escalation?: {
    afterSeconds: number;
    to: ReviewerTarget;
  } & JsonObject;
}

export type Continuation =
  | ({ type: "webhook"; url: string } & JsonObject)
  | ({ type: "polling" } & JsonObject)
  | ({ type: "sdk_wait" } & JsonObject)
  | ({ type: "github_event"; repository: string } & JsonObject)
  | ({ type: "queue"; adapter: string; destination: string } & JsonObject)
  | ({ type: "cli_wait" } & JsonObject);

export interface NibRequest extends JsonObject {
  id: string;
  formatVersion: string;
  revision: number;
  title: string;
  description?: string;
  source: Source;
  subject?: Subject;
  artifacts: Artifact[];
  decision: DecisionRequirement;
  routing?: RoutingPolicy;
  policy?: ApprovalPolicy;
  metadata?: JsonObject;
  continuation?: Continuation;
  createdAt: string;
  expiresAt?: string;
}

export type DecisionOutcome = "approved" | "rejected" | "changes_requested";
export type RequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "changes_requested"
  | "expired"
  | "cancelled";

export type FeedbackContent =
  | { type: "comment"; text: string }
  | { type: "annotation"; artifactId: string; text: string; anchor?: unknown }
  | { type: "selection"; optionId: string; text?: string }
  | { type: "rating"; value: number; scale?: number }
  | { type: "structured_answer"; answer: unknown }
  | { type: "timestamp"; artifactId: string; seconds: number; text: string }
  | {
      type: "region";
      artifactId: string;
      bounds: { x: number; y: number; width: number; height: number };
      text: string;
    }
  | { type: "attachment"; artifactId: string };

export type Feedback = {
  id: string;
  requestId: string;
  requestRevision: number;
  author: ReviewerIdentity;
  createdAt: string;
} & FeedbackContent &
  JsonObject;

export interface Decision extends JsonObject {
  id: string;
  requestId: string;
  requestRevision: number;
  outcome: DecisionOutcome;
  reviewer: ReviewerIdentity;
  feedback?: Feedback[];
  createdAt: string;
  supersedesDecisionId?: string;
}

export interface NibEvent extends JsonObject {
  id: string;
  type: string;
  requestId: string;
  requestRevision: number;
  sequence: number;
  timestamp: string;
  data?: unknown;
  prevHash?: string;
  hash?: string;
}
