import { createHmac, timingSafeEqual } from "node:crypto";
import type { Decision, DecisionOutcome, Feedback, NibRequest, ReviewerIdentity } from "@nib/protocol";

export type HeadersLike = Headers | Record<string, string | string[] | undefined>;
export type TransportResult = { providerMessageId?: string; metadata?: Record<string, unknown> };
export type Transport<Message> = (message: Message) => Promise<TransportResult> | TransportResult;

export interface ReviewNotification {
  request: NibRequest;
  reviewUrl: string;
}

export interface DeliveryDestination {
  type: string;
  id: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface DeliveryInput {
  destination: DeliveryDestination;
  notification: ReviewNotification;
}

export interface DeliveryReceipt {
  provider: string;
  destination: DeliveryDestination;
  providerMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface CallbackInput {
  request: NibRequest;
  body: unknown;
  rawBody?: string;
  headers?: HeadersLike;
  receivedAt?: Date;
}

export type CallbackNormalization =
  | { kind: "decision"; decision: Decision; feedback?: Feedback[] }
  | { kind: "feedback"; feedback: Feedback[] }
  | { kind: "ignored"; reason: string };

export interface CallbackVerifier {
  verify(input: { rawBody: string; headers: HeadersLike }): Promise<boolean> | boolean;
}

export interface DeliveryAdapter<Message> {
  provider: string;
  render(notification: ReviewNotification, destination: DeliveryDestination): Message;
  send(input: DeliveryInput): Promise<DeliveryReceipt>;
  normalizeCallback(input: CallbackInput): Promise<CallbackNormalization>;
}

export interface SignatureVerificationInput {
  verifier?: CallbackVerifier;
  rawBody?: string;
  headers?: HeadersLike;
}

export async function verifyCallbackSignature(input: SignatureVerificationInput): Promise<void> {
  if (!input.verifier) {
    return;
  }
  if (!input.rawBody || !input.headers) {
    throw new Error("Callback signature verification requires rawBody and headers.");
  }
  if (!(await input.verifier.verify({ rawBody: input.rawBody, headers: input.headers }))) {
    throw new Error("Invalid callback signature.");
  }
}

export function createHmacVerifier(options: { secret: string; header: string; prefix?: string }): CallbackVerifier {
  return {
    verify({ rawBody, headers }) {
      const actual = getHeader(headers, options.header);
      if (!actual) {
        return false;
      }
      const expected = createHmac("sha256", options.secret).update(rawBody).digest("hex");
      return safeEqual(actual, options.prefix ? `${options.prefix}${expected}` : expected);
    },
  };
}

export function createSlackSignatureVerifier(signingSecret: string): CallbackVerifier {
  return {
    verify({ rawBody, headers }) {
      const timestamp = getHeader(headers, "x-slack-request-timestamp");
      const actual = getHeader(headers, "x-slack-signature");
      if (!timestamp || !actual) {
        return false;
      }
      const expected = createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
      return safeEqual(actual, `v0=${expected}`);
    },
  };
}

export function renderReviewText(notification: ReviewNotification): string {
  const lines = [`Nib Request: ${notification.request.title}`];
  if (notification.request.description) {
    lines.push(notification.request.description);
  }
  lines.push(`Open review: ${notification.reviewUrl}`);
  lines.push(`Decision requested: ${notification.request.decision.type}`);
  return lines.join("\n");
}

export interface SlackMessage {
  channel: string;
  text: string;
  blocks: Array<Record<string, unknown>>;
}

export function createSlackAdapter(options: {
  transport: Transport<SlackMessage>;
  signingSecret?: string;
  verifier?: CallbackVerifier;
  clock?: () => Date;
}): DeliveryAdapter<SlackMessage> {
  const verifier = options.verifier ?? (options.signingSecret ? createSlackSignatureVerifier(options.signingSecret) : undefined);
  const clock = options.clock ?? (() => new Date());

  return {
    provider: "slack",
    render(notification, destination) {
      const text = renderReviewText(notification);
      return {
        channel: destination.id,
        text,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `*${notification.request.title}*` } },
          ...(notification.request.description
            ? [{ type: "section", text: { type: "mrkdwn", text: notification.request.description } }]
            : []),
          {
            type: "actions",
            elements: [
              { type: "button", text: { type: "plain_text", text: "Open review" }, url: notification.reviewUrl },
              ...decisionButtons(notification.request),
            ],
          },
        ],
      };
    },
    async send(input) {
      const result = await options.transport(this.render(input.notification, input.destination));
      return receipt("slack", input.destination, result);
    },
    async normalizeCallback(input) {
      await verifyCallbackSignature({ verifier, rawBody: input.rawBody, headers: input.headers });
      const body = objectOf(input.body);
      const action = firstArrayItem(body.actions);
      const outcome = normalizeOutcome(stringValue(action?.value ?? action?.action_id));
      if (!outcome) {
        return { kind: "ignored", reason: "Slack callback did not include a Nib decision action." };
      }
      const user = objectOf(body.user);
      const reviewer = reviewerIdentity({
        id: stringValue(user.id) ?? "slack-user",
        type: "slack_user",
        name: stringValue(user.name ?? user.username),
      });
      const decision = buildDecision(input.request, outcome, reviewer, clock(), {
        provider: "slack",
        providerMessageId: stringValue(objectOf(body.message).ts),
      });
      return { kind: "decision", decision, feedback: decision.feedback };
    },
  };
}

export interface TeamsMessage {
  conversationId: string;
  text: string;
  attachments: Array<Record<string, unknown>>;
}

export function createTeamsAdapter(options: {
  transport: Transport<TeamsMessage>;
  verifier?: CallbackVerifier;
  clock?: () => Date;
}): DeliveryAdapter<TeamsMessage> {
  const clock = options.clock ?? (() => new Date());
  return {
    provider: "teams",
    render(notification, destination) {
      return {
        conversationId: destination.id,
        text: renderReviewText(notification),
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: {
              type: "AdaptiveCard",
              version: "1.5",
              body: [
                { type: "TextBlock", text: notification.request.title, weight: "Bolder", wrap: true },
                ...(notification.request.description
                  ? [{ type: "TextBlock", text: notification.request.description, wrap: true }]
                  : []),
              ],
              actions: [
                { type: "Action.OpenUrl", title: "Open review", url: notification.reviewUrl },
                ...["approved", "changes_requested", "rejected"].map((outcome) => ({
                  type: "Action.Submit",
                  title: labelForOutcome(outcome as DecisionOutcome),
                  data: { outcome },
                })),
              ],
            },
          },
        ],
      };
    },
    async send(input) {
      const result = await options.transport(this.render(input.notification, input.destination));
      return receipt("teams", input.destination, result);
    },
    async normalizeCallback(input) {
      await verifyCallbackSignature({ verifier: options.verifier, rawBody: input.rawBody, headers: input.headers });
      const body = objectOf(input.body);
      const value = objectOf(body.value ?? body.data);
      const outcome = normalizeOutcome(stringValue(value.outcome ?? value.decision));
      if (!outcome) {
        return { kind: "ignored", reason: "Teams callback did not include a Nib decision outcome." };
      }
      const from = objectOf(body.from);
      const reviewer = reviewerIdentity({
        id: stringValue(from.aadObjectId ?? from.id) ?? "teams-user",
        type: "teams_user",
        name: stringValue(from.name),
      });
      const comment = stringValue(value.comment ?? value.feedback);
      const decision = buildDecision(input.request, outcome, reviewer, clock(), {
        provider: "teams",
        providerMessageId: stringValue(body.replyToId),
        comment,
      });
      return { kind: "decision", decision, feedback: decision.feedback };
    },
  };
}

export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

export function createEmailAdapter(options: {
  transport: Transport<EmailMessage>;
  from: string;
  verifier?: CallbackVerifier;
  clock?: () => Date;
}): DeliveryAdapter<EmailMessage> {
  const clock = options.clock ?? (() => new Date());
  return {
    provider: "email",
    render(notification, destination) {
      const text = renderReviewText(notification);
      return {
        to: destination.id,
        from: options.from,
        subject: `Nib Request: ${notification.request.title}`,
        text,
        html: [
          `<p><strong>${escapeHtml(notification.request.title)}</strong></p>`,
          notification.request.description ? `<p>${escapeHtml(notification.request.description)}</p>` : "",
          `<p><a href="${escapeHtml(notification.reviewUrl)}">Open review</a></p>`,
        ]
          .filter(Boolean)
          .join(""),
        headers: {
          "X-Nib-Request-Id": notification.request.id,
          "X-Nib-Request-Revision": String(notification.request.revision),
        },
      };
    },
    async send(input) {
      const result = await options.transport(this.render(input.notification, input.destination));
      return receipt("email", input.destination, result);
    },
    async normalizeCallback(input) {
      await verifyCallbackSignature({ verifier: options.verifier, rawBody: input.rawBody, headers: input.headers });
      const body = objectOf(input.body);
      const outcome = normalizeOutcome(stringValue(body.outcome ?? body.decision));
      if (!outcome) {
        const feedback = commentFeedback(input.request, emailReviewer(body), stringValue(body.comment ?? body.text), clock());
        return feedback ? { kind: "feedback", feedback: [feedback] } : { kind: "ignored", reason: "Email callback had no decision or comment." };
      }
      const decision = buildDecision(input.request, outcome, emailReviewer(body), clock(), {
        provider: "email",
        providerMessageId: stringValue(body.messageId),
        comment: stringValue(body.comment ?? body.text),
      });
      return { kind: "decision", decision, feedback: decision.feedback };
    },
  };
}

export interface SmsMessage {
  to: string;
  text: string;
}

export function createSmsAdapter(options: {
  transport: Transport<SmsMessage>;
  verifier?: CallbackVerifier;
  clock?: () => Date;
}): DeliveryAdapter<SmsMessage> {
  const clock = options.clock ?? (() => new Date());
  return {
    provider: "sms",
    render(notification, destination) {
      return {
        to: destination.id,
        text: `Nib Request: ${notification.request.title}. Review: ${notification.reviewUrl}`,
      };
    },
    async send(input) {
      const result = await options.transport(this.render(input.notification, input.destination));
      return receipt("sms", input.destination, result);
    },
    async normalizeCallback(input) {
      await verifyCallbackSignature({ verifier: options.verifier, rawBody: input.rawBody, headers: input.headers });
      const body = objectOf(input.body);
      const text = stringValue(body.text ?? body.Body ?? body.message) ?? "";
      const parsed = parseSmsDecision(text);
      const reviewer = reviewerIdentity({
        id: stringValue(body.from ?? body.From) ?? "sms-user",
        type: "sms_user",
      });
      if (!parsed.outcome) {
        const feedback = commentFeedback(input.request, reviewer, text.trim(), clock());
        return feedback ? { kind: "feedback", feedback: [feedback] } : { kind: "ignored", reason: "SMS reply was empty." };
      }
      const decision = buildDecision(input.request, parsed.outcome, reviewer, clock(), {
        provider: "sms",
        providerMessageId: stringValue(body.messageId ?? body.MessageSid),
        comment: parsed.comment,
      });
      return { kind: "decision", decision, feedback: decision.feedback };
    },
  };
}

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

export function createPushAdapter(options: {
  transport: Transport<PushMessage>;
  verifier?: CallbackVerifier;
  clock?: () => Date;
}): DeliveryAdapter<PushMessage> {
  const clock = options.clock ?? (() => new Date());
  return {
    provider: "push",
    render(notification, destination) {
      return {
        token: destination.id,
        title: notification.request.title,
        body: notification.request.description ?? `Open review: ${notification.reviewUrl}`,
        data: {
          requestId: notification.request.id,
          requestRevision: String(notification.request.revision),
          reviewUrl: notification.reviewUrl,
        },
      };
    },
    async send(input) {
      const result = await options.transport(this.render(input.notification, input.destination));
      return receipt("push", input.destination, result);
    },
    async normalizeCallback(input) {
      await verifyCallbackSignature({ verifier: options.verifier, rawBody: input.rawBody, headers: input.headers });
      const body = objectOf(input.body);
      const outcome = normalizeOutcome(stringValue(body.outcome ?? body.action));
      if (!outcome) {
        return { kind: "ignored", reason: "Push callback did not include a Nib decision outcome." };
      }
      const reviewer = reviewerIdentity({
        id: stringValue(body.reviewerId ?? body.userId) ?? "push-user",
        type: "push_user",
        name: stringValue(body.reviewerName ?? body.userName),
      });
      const decision = buildDecision(input.request, outcome, reviewer, clock(), {
        provider: "push",
        providerMessageId: stringValue(body.messageId),
        comment: stringValue(body.comment),
      });
      return { kind: "decision", decision, feedback: decision.feedback };
    },
  };
}

function receipt(provider: string, destination: DeliveryDestination, result: TransportResult): DeliveryReceipt {
  return {
    provider,
    destination,
    providerMessageId: result.providerMessageId,
    metadata: result.metadata,
  };
}

function decisionButtons(request: NibRequest): Array<Record<string, unknown>> {
  const configured = (request.decision.options ?? [])
    .map((option) => normalizeOutcome(option.id))
    .filter((outcome): outcome is DecisionOutcome => Boolean(outcome));
  const outcomes: DecisionOutcome[] =
    configured.length > 0 ? Array.from(new Set(configured)) : ["approved", "changes_requested", "rejected"];
  return outcomes.map((outcome) => ({
    type: "button",
    action_id: "nib_decision",
    value: outcome,
    text: { type: "plain_text", text: labelForOutcome(outcome) },
  }));
}

function labelForOutcome(outcome: DecisionOutcome): string {
  if (outcome === "approved") {
    return "Approve";
  }
  if (outcome === "changes_requested") {
    return "Request changes";
  }
  return "Reject";
}

function buildDecision(
  request: NibRequest,
  outcome: DecisionOutcome,
  reviewer: ReviewerIdentity,
  createdAt: Date,
  options: { provider: string; providerMessageId?: string; comment?: string },
): Decision {
  const feedback = commentFeedback(request, reviewer, options.comment, createdAt);
  return {
    id: createDecisionId(request, reviewer, createdAt),
    requestId: request.id,
    requestRevision: request.revision,
    outcome,
    reviewer,
    feedback: feedback ? [feedback] : undefined,
    createdAt: createdAt.toISOString(),
    provider: options.provider,
    providerMessageId: options.providerMessageId,
  };
}

function commentFeedback(
  request: NibRequest,
  author: ReviewerIdentity,
  text: string | undefined,
  createdAt: Date,
): Feedback | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  return {
    id: `fb_${request.id}_${sanitizeId(author.id)}_${createdAt.getTime()}`,
    requestId: request.id,
    requestRevision: request.revision,
    author,
    createdAt: createdAt.toISOString(),
    type: "comment",
    text: trimmed,
  };
}

function createDecisionId(request: NibRequest, reviewer: ReviewerIdentity, createdAt: Date): string {
  return `dec_${request.id}_${sanitizeId(reviewer.id)}_${createdAt.getTime()}`;
}

function emailReviewer(body: Record<string, unknown>): ReviewerIdentity {
  return reviewerIdentity({
    id: stringValue(body.from ?? body.email) ?? "email-user",
    type: "email_user",
    email: stringValue(body.from ?? body.email),
    name: stringValue(body.name),
  });
}

function reviewerIdentity(input: ReviewerIdentity): ReviewerIdentity {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as unknown as ReviewerIdentity;
}

function parseSmsDecision(text: string): { outcome?: DecisionOutcome; comment?: string } {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const patterns: Array<[DecisionOutcome, RegExp]> = [
    ["changes_requested", /^(changes?|change requested|request changes|revise|needs changes)\b[:\s-]*/],
    ["approved", /^(approve|approved|yes|ok)\b[:\s-]*/],
    ["rejected", /^(reject|rejected|no)\b[:\s-]*/],
  ];
  for (const [outcome, pattern] of patterns) {
    const match = lower.match(pattern);
    if (match) {
      return { outcome, comment: trimmed.slice(match[0].length).trim() || undefined };
    }
  }
  return {};
}

function normalizeOutcome(value: string | undefined): DecisionOutcome | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase().replace(/[-\s]+/g, "_");
  if (normalized === "approve" || normalized === "approved" || normalized === "yes") {
    return "approved";
  }
  if (normalized === "reject" || normalized === "rejected" || normalized === "no") {
    return "rejected";
  }
  if (
    normalized === "change" ||
    normalized === "changes" ||
    normalized === "changes_requested" ||
    normalized === "request_changes" ||
    normalized === "needs_changes"
  ) {
    return "changes_requested";
  }
  return undefined;
}

function firstArrayItem(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) ? objectOrUndefined(value[0]) : undefined;
}

function objectOf(value: unknown): Record<string, unknown> {
  return objectOrUndefined(value) ?? {};
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getHeader(headers: HeadersLike, name: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "reviewer";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
