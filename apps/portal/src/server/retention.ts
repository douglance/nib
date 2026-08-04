import fs from "node:fs/promises";
import path from "node:path";
import type { FeedbackStatus, RequestAttachment, RequestRecord, RequestStatus } from "../shared/types";
import { ATTACHMENT_DIR } from "./config";
import { mutateStore, type StoreShape } from "./store";

const DAY_MS = 24 * 60 * 60 * 1000;
const removableRequestStatuses = new Set<RequestStatus>(["answered", "acted", "resolved", "expired"]);
const openStaleRequestStatuses = new Set<RequestStatus>(["open", "viewed", "stale"]);
const removableFeedbackStatuses = new Set<FeedbackStatus>(["answered", "resolved"]);
const openStaleFeedbackStatuses = new Set<FeedbackStatus>(["open", "viewed", "stale"]);

export interface RetentionSweepSummary {
  removedRequests: number;
  removedAttachments: number;
  removedFeedback: number;
  prunedCacheEntries: number;
}

export function retentionDays(): number {
  const parsed = Number(process.env.NIB_RETENTION_DAYS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
}

export function openStaleDays(): number {
  const parsed = Number(process.env.NIB_OPEN_STALE_DAYS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
}

export function completedAttachmentHours(): number {
  const parsed = Number(process.env.NIB_COMPLETED_ATTACHMENT_HOURS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
}

export async function runRetentionSweep(now = Date.now()): Promise<RetentionSweepSummary> {
  const cutoff = now - retentionDays() * DAY_MS;
  const openStaleCutoff = now - openStaleDays() * DAY_MS;
  const completedAttachmentCutoff = now - completedAttachmentHours() * 60 * 60 * 1000;
  let removedRequests = 0;
  let removedFeedback = 0;
  let prunedCacheEntries = 0;
  const store = await mutateStore((store) => {
    for (const [id, request] of Object.entries(store.requests)) {
      const answeredExpired = removableRequestStatuses.has(request.status) && recordTime(request) < cutoff;
      const abandonedOpen = openStaleRequestStatuses.has(request.status) && recordTime(request) < openStaleCutoff;
      if (answeredExpired || abandonedOpen) {
        delete store.requests[id];
        removedRequests += 1;
      } else if (
        request.kind === "visual-review" &&
        removableRequestStatuses.has(request.status) &&
        completedTime(request) < completedAttachmentCutoff
      ) {
        const expired = request.attachments.filter(isReviewByteAttachment);
        request.attachments = request.attachments.filter((attachment) => !isReviewByteAttachment(attachment));
        for (const attachment of expired) delete store.attachments[attachment.id];
      }
    }
    for (const [id, feedback] of Object.entries(store.feedback)) {
      const answeredExpired = removableFeedbackStatuses.has(feedback.status) && recordTime(feedback) < cutoff;
      const abandonedOpen = openStaleFeedbackStatuses.has(feedback.status) && recordTime(feedback) < openStaleCutoff;
      if (answeredExpired || abandonedOpen) {
        delete store.feedback[id];
        removedFeedback += 1;
      }
    }
    for (const [id, attachment] of Object.entries(store.attachments)) {
      if (!store.requests[attachment.requestId] && !store.feedback[attachment.requestId]) {
        delete store.attachments[id];
        prunedCacheEntries += 1;
      }
    }
  });
  const removedAttachments = await removeUnreferencedAttachmentFiles(store);
  console.log(
    `retention sweep: removed ${removedRequests} requests, ${removedAttachments} attachments, ${removedFeedback} feedback, ${prunedCacheEntries} cache entries`
  );
  return { removedRequests, removedAttachments, removedFeedback, prunedCacheEntries };
}

function completedTime(record: RequestRecord): number {
  const value = record.answeredAt || record.actedAt || record.resolvedAt || record.updatedAt;
  const time = new Date(value || "").getTime();
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

function isReviewByteAttachment(attachment: RequestAttachment): boolean {
  return attachment.contentType.startsWith("image/")
    || attachment.contentType.startsWith("video/")
    || attachment.contentType.startsWith("audio/")
    || attachment.contentType === "application/x-nib";
}

function recordTime(record: { updatedAt?: string | null; createdAt?: string | null }): number {
  const time = new Date(record.updatedAt || record.createdAt || "").getTime();
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

async function removeUnreferencedAttachmentFiles(store: StoreShape): Promise<number> {
  const referenced = new Set<string>();
  const collect = (attachment: RequestAttachment) => {
    const fileName = attachment.metadata?.fileName;
    if (typeof fileName === "string" && fileName) referenced.add(path.basename(fileName));
  };
  for (const attachment of Object.values(store.attachments)) collect(attachment);
  for (const request of Object.values(store.requests)) {
    for (const attachment of request.attachments ?? []) collect(attachment);
  }
  let entries: string[];
  try {
    entries = await fs.readdir(ATTACHMENT_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (referenced.has(entry)) continue;
    try {
      await fs.rm(path.join(ATTACHMENT_DIR, entry), { force: true });
      removed += 1;
    } catch {
      // Undeletable files stay for the next sweep.
    }
  }
  return removed;
}
