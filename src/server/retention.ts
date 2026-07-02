import fs from "node:fs/promises";
import path from "node:path";
import type { FeedbackStatus, RequestAttachment, RequestStatus } from "../shared/types";
import { ATTACHMENT_DIR } from "./config";
import { mutateStore, type StoreShape } from "./store";

const DAY_MS = 24 * 60 * 60 * 1000;
const removableRequestStatuses = new Set<RequestStatus>(["answered", "acted", "resolved", "expired"]);
const openStaleRequestStatuses = new Set<RequestStatus>(["open", "viewed", "stale"]);
const removableFeedbackStatuses = new Set<FeedbackStatus>(["answered", "resolved"]);

export interface RetentionSweepSummary {
  removedRequests: number;
  removedAttachments: number;
  removedFeedback: number;
  prunedCacheEntries: number;
}

export function retentionDays(): number {
  const parsed = Number(process.env.PRTL_RETENTION_DAYS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
}

export function openStaleDays(): number {
  const parsed = Number(process.env.PRTL_OPEN_STALE_DAYS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 21;
}

export async function runRetentionSweep(now = Date.now()): Promise<RetentionSweepSummary> {
  const cutoff = now - retentionDays() * DAY_MS;
  const openStaleCutoff = now - openStaleDays() * DAY_MS;
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
      }
    }
    for (const [id, feedback] of Object.entries(store.feedback)) {
      if (removableFeedbackStatuses.has(feedback.status) && recordTime(feedback) < cutoff) {
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
