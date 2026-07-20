import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { RequestAttachment, RequestRecord, RequestStatus } from "../shared/types";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "nib-retention-"));
process.env.NIB_DATA_DIR = dataDir;
const attachmentDir = path.join(dataDir, "attachments");
const storePath = path.join(dataDir, "store.json");
const { runRetentionSweep } = await import("./retention");

test("removes answered requests older than retention along with their attachment files", async () => {
  const attachment = makeAttachment("old-request", "old-attachment.png");
  await seedStore({
    requests: { "old-request": makeRequest({ id: "old-request", status: "answered", updatedAt: daysAgo(30), attachments: [attachment] }) },
    attachments: { [attachment.id]: attachment }
  });
  await writeAttachmentFile("old-attachment.png");

  await runRetentionSweep();

  const store = await readStoreFile();
  assert.equal(store.requests["old-request"], undefined);
  assert.equal(store.attachments[attachment.id], undefined);
  assert.equal(await fileExists("old-attachment.png"), false);
});

test("removes abandoned open requests older than the open-stale threshold", async () => {
  const attachment = makeAttachment("stale-open", "stale-open.png");
  await seedStore({
    requests: { "stale-open": makeRequest({ id: "stale-open", status: "open", updatedAt: daysAgo(30), attachments: [attachment] }) },
    attachments: { [attachment.id]: attachment }
  });
  await writeAttachmentFile("stale-open.png");

  await runRetentionSweep();

  const store = await readStoreFile();
  assert.equal(store.requests["stale-open"], undefined);
  assert.equal(store.attachments[attachment.id], undefined);
  assert.equal(await fileExists("stale-open.png"), false);
});

test("keeps a fresh open request that is only minutes old", async () => {
  await seedStore({
    requests: { "fresh-open": makeRequest({ id: "fresh-open", status: "open", updatedAt: minutesAgo(40) }) }
  });

  await runRetentionSweep();

  const store = await readStoreFile();
  assert.ok(store.requests["fresh-open"]);
});

test("still removes answered requests older than the answered retention", async () => {
  await seedStore({
    requests: { "answered-ten": makeRequest({ id: "answered-ten", status: "answered", updatedAt: daysAgo(10) }) }
  });

  await runRetentionSweep();

  const store = await readStoreFile();
  assert.equal(store.requests["answered-ten"], undefined);
});

test("defaults the pending threshold to 7 days and honors NIB_OPEN_STALE_DAYS", async () => {
  await seedStore({
    requests: {
      "six-days": makeRequest({ id: "six-days", status: "open", updatedAt: daysAgo(6) }),
      "eight-days": makeRequest({ id: "eight-days", status: "open", updatedAt: daysAgo(8) })
    }
  });

  await runRetentionSweep();

  let store = await readStoreFile();
  assert.ok(store.requests["six-days"], "six-day pending request survives the seven-day default");
  assert.equal(store.requests["eight-days"], undefined, "eight-day pending request is swept by the seven-day default");

  process.env.NIB_OPEN_STALE_DAYS = "45";
  try {
    await seedStore({
      requests: { "thirty-days": makeRequest({ id: "thirty-days", status: "open", updatedAt: daysAgo(30) }) }
    });

    await runRetentionSweep();

    store = await readStoreFile();
    assert.ok(store.requests["thirty-days"], "override lengthens the threshold so a 30-day open request survives");
  } finally {
    delete process.env.NIB_OPEN_STALE_DAYS;
  }
});

test("removes completed visual-review bytes after 24 hours while keeping request metadata", async () => {
  const preview = makeAttachment("completed-review", "completed.png");
  const canonical = makeAttachment("completed-review", "completed.nib", "application/x-nib", "file");
  await seedStore({
    requests: {
      "completed-review": makeRequest({
        id: "completed-review",
        kind: "visual-review",
        status: "answered",
        updatedAt: daysAgo(2),
        answeredAt: daysAgo(2),
        attachments: [preview, canonical]
      })
    },
    attachments: { [preview.id]: preview, [canonical.id]: canonical }
  });
  await writeAttachmentFile("completed.png");
  await writeAttachmentFile("completed.nib");

  await runRetentionSweep();

  const store = await readStoreFile();
  assert.ok(store.requests["completed-review"]);
  assert.deepEqual(store.requests["completed-review"].attachments, []);
  assert.equal(store.attachments[preview.id], undefined);
  assert.equal(store.attachments[canonical.id], undefined);
  assert.equal(await fileExists("completed.png"), false);
  assert.equal(await fileExists("completed.nib"), false);
});

test("keeps recently answered requests and their attachment files", async () => {
  const attachment = makeAttachment("fresh-request", "fresh-attachment.png");
  await seedStore({
    requests: { "fresh-request": makeRequest({ id: "fresh-request", status: "answered", updatedAt: daysAgo(1), attachments: [attachment] }) },
    attachments: { [attachment.id]: attachment }
  });
  await writeAttachmentFile("fresh-attachment.png");

  await runRetentionSweep();

  const store = await readStoreFile();
  assert.ok(store.requests["fresh-request"]);
  assert.ok(store.attachments[attachment.id]);
  assert.equal(await fileExists("fresh-attachment.png"), true);
});

test("deletes orphaned files in the attachments directory", async () => {
  const attachment = makeAttachment("live-request", "referenced.png");
  await seedStore({
    requests: { "live-request": makeRequest({ id: "live-request", status: "open", updatedAt: daysAgo(1), attachments: [attachment] }) },
    attachments: { [attachment.id]: attachment }
  });
  await writeAttachmentFile("referenced.png");
  await writeAttachmentFile("orphan.png");

  await runRetentionSweep();

  assert.equal(await fileExists("orphan.png"), false);
  assert.equal(await fileExists("referenced.png"), true);
});

test("prunes attachment cache entries that reference dead request ids", async () => {
  const attachment = makeAttachment("dead-request", "dead.png");
  await seedStore({
    requests: {},
    attachments: { [attachment.id]: attachment }
  });

  await runRetentionSweep();

  const store = await readStoreFile();
  assert.equal(store.attachments[attachment.id], undefined);
});

test("applies the same age rules to legacy feedback records", async () => {
  await seedStore({
    feedback: {
      "old-feedback": makeFeedback("old-feedback", "answered", daysAgo(30)),
      "abandoned-open-feedback": makeFeedback("abandoned-open-feedback", "viewed", daysAgo(49)),
      "fresh-open-feedback": makeFeedback("fresh-open-feedback", "open", daysAgo(1)),
      "fresh-feedback": makeFeedback("fresh-feedback", "answered", daysAgo(1))
    }
  });

  await runRetentionSweep();

  const store = await readStoreFile();
  assert.equal(store.feedback["old-feedback"], undefined);
  assert.equal(
    store.feedback["abandoned-open-feedback"],
    undefined,
    "49-day abandoned open feedback is swept by the 21-day open-stale threshold"
  );
  assert.ok(store.feedback["fresh-open-feedback"], "a day-old open feedback survives");
  assert.ok(store.feedback["fresh-feedback"]);
});

test("respects NIB_RETENTION_DAYS override", async () => {
  process.env.NIB_RETENTION_DAYS = "60";
  try {
    await seedStore({
      requests: { "month-old": makeRequest({ id: "month-old", status: "answered", updatedAt: daysAgo(30) }) }
    });

    await runRetentionSweep();

    const store = await readStoreFile();
    assert.ok(store.requests["month-old"]);
  } finally {
    delete process.env.NIB_RETENTION_DAYS;
  }
});

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function makeRequest(overrides: Partial<RequestRecord> & { id: string; status: RequestStatus; updatedAt: string }): RequestRecord {
  return {
    kind: "question",
    title: "Test request",
    prompt: "Test request",
    body: null,
    context: null,
    choices: [],
    allowText: true,
    target: {},
    priority: "normal",
    source: null,
    createdAt: overrides.updatedAt,
    viewedAt: null,
    answeredAt: null,
    actedAt: null,
    resolvedAt: null,
    expiresAt: null,
    notifiedAt: null,
    notificationClickedAt: null,
    staleReason: null,
    attachments: [],
    responses: [],
    metadata: {},
    ...overrides
  };
}

function makeAttachment(
  requestId: string,
  fileName: string,
  contentType = "image/png",
  type: RequestAttachment["type"] = "image"
): RequestAttachment {
  return {
    id: `attachment-${fileName}`,
    requestId,
    name: fileName,
    type,
    contentType,
    bytes: 4,
    url: `/attachments/attachment-${fileName}`,
    createdAt: daysAgo(30),
    metadata: { fileName }
  };
}

function makeFeedback(id: string, status: string, updatedAt: string): Record<string, unknown> {
  return { id, status, createdAt: updatedAt, updatedAt, responses: [], artifacts: [] };
}

async function seedStore(store: Record<string, unknown>): Promise<void> {
  await fs.rm(attachmentDir, { recursive: true, force: true });
  await fs.mkdir(attachmentDir, { recursive: true });
  await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

async function readStoreFile(): Promise<{
  requests: Record<string, RequestRecord>;
  feedback: Record<string, unknown>;
  attachments: Record<string, RequestAttachment>;
}> {
  return JSON.parse(await fs.readFile(storePath, "utf8"));
}

async function writeAttachmentFile(fileName: string): Promise<void> {
  await fs.writeFile(path.join(attachmentDir, fileName), "data");
}

async function fileExists(fileName: string): Promise<boolean> {
  return fs.access(path.join(attachmentDir, fileName)).then(() => true, () => false);
}
