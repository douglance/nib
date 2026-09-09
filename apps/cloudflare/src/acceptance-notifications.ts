import type { ApnsPayload } from "./apns";

export interface AcceptanceNotification {
  eventId: string;
  projectId: string;
  reviewId: string;
  title: string;
  change: string;
  state: "pending" | "approved" | "rejected" | "revision_requested" | "expired" | "superseded" | "invalidated";
  revision: number;
  sequence: number;
  reviewUrl: string;
  expiresAt: string;
}

export function acceptanceNotification(value: unknown, allowedOrigin: string): AcceptanceNotification {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Notification must be an object");
  const input = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const field of ["projectId", "reviewId"]) if (typeof input[field] !== "string" || !uuid.test(input[field] as string)) throw new Error(`Invalid ${field}`);
  for (const field of ["eventId", "title", "change", "reviewUrl", "expiresAt"]) if (typeof input[field] !== "string" || !(input[field] as string).trim()) throw new Error(`Invalid ${field}`);
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 1 || !Number.isSafeInteger(input.sequence) || Number(input.sequence) < 1) throw new Error("Invalid notification revision or sequence");
  if (!["pending", "approved", "rejected", "revision_requested", "expired", "superseded", "invalidated"].includes(String(input.state))) throw new Error("Invalid state");
  if (!Number.isFinite(Date.parse(input.expiresAt as string))) throw new Error("Invalid expiry");
  const url = new URL(input.reviewUrl as string);
  if (url.origin !== new URL(allowedOrigin).origin || url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    url.pathname !== `/acceptance/projects/${input.projectId}/reviews/${input.reviewId}`) throw new Error("Review URL does not identify this acceptance revision");
  return {
    eventId: String(input.eventId).slice(0, 200), projectId: String(input.projectId), reviewId: String(input.reviewId),
    title: String(input.title).slice(0, 200), change: String(input.change).slice(0, 1000),
    state: input.state as AcceptanceNotification["state"], revision: Number(input.revision), sequence: Number(input.sequence),
    reviewUrl: url.toString(), expiresAt: String(input.expiresAt),
  };
}

export function acceptanceNotificationPayload(input: AcceptanceNotification): ApnsPayload {
  if (input.state !== "pending") return {
    type: "request-resolved", requestId: input.reviewId, status: input.state,
    url: input.reviewUrl, tag: `request:${input.reviewId}`,
  };
  return {
    type: "acceptance-review", requestId: input.reviewId, projectId: input.projectId,
    title: input.title, body: input.change, request: "Open the exact preview and review the requested behavior.",
    url: input.reviewUrl, choices: [], allowText: false, tag: `request:${input.reviewId}`,
  };
}
