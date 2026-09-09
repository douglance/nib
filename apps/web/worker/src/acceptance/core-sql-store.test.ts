import { describe, expect, it, vi } from "vitest";
import type { AcceptanceEvent } from "./contracts";
import type { AcceptanceSqlResult, AcceptanceSqlStorage } from "./coordinator";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

import { AcceptanceCore, flushAcceptanceOutbox, initializeAcceptanceSqlStorage, SqlAcceptanceStore } from "./coordinator";
import { ManualClock, manifest, PredictableIds } from "./core-test-helpers";

describe("acceptance SQLite store", () => {
  it("retains reviews, current index, idempotency, and outbox rows across restarts", async () => {
    const databasePath = `/tmp/nib-acceptance-core-${crypto.randomUUID()}.sqlite`;
    const firstDatabase = await openNodeSqlite(databasePath);
    const firstStorage = new NodeSqlAcceptanceStorage(firstDatabase);
    initializeAcceptanceSqlStorage(firstStorage);
    const firstStore = new SqlAcceptanceStore(firstStorage);
    const firstCore = new AcceptanceCore(firstStore, {
      clock: new ManualClock(),
      ids: new PredictableIds(),
      signReceipt: async (review) => `receipt:${review.id}`,
    });

    const published = await firstCore.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1"],
    }, "publish-persistent");
    await firstCore.comment(published.id, "Stored in SQLite", "reviewer-1", "comment-persistent");
    const outboxBeforeRestart = await firstStore.listOutbox(10);
    expect(outboxBeforeRestart).toHaveLength(2);
    expect(firstStorage.statements).not.toContain("BEGIN IMMEDIATE");
    expect(firstStorage.statements).not.toContain("COMMIT");
    expect(firstStorage.statements).not.toContain("ROLLBACK");
    firstDatabase.close();

    const secondDatabase = await openNodeSqlite(databasePath);
    const secondStorage = new NodeSqlAcceptanceStorage(secondDatabase);
    initializeAcceptanceSqlStorage(secondStorage);
    const secondStore = new SqlAcceptanceStore(secondStorage);
    const secondCore = new AcceptanceCore(secondStore, {
      clock: new ManualClock(),
      ids: new PredictableIds(),
      signReceipt: async (review) => `receipt:${review.id}`,
    });

    expect((await secondStore.getReview(published.id))?.comments).toHaveLength(1);
    expect(await secondStore.getCurrentId("homepage", "visual-acceptance")).toBe(published.id);
    expect(await secondStore.listOutbox(10)).toHaveLength(2);
    const idempotentReplay = await secondCore.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1"],
    }, "publish-persistent");
    expect(idempotentReplay.id).toBe(published.id);
    secondDatabase.close();
  });



  it("reschedules the earliest active review expiry after outbox events drain", async () => {
    const database = await openNodeSqlite(`/tmp/nib-acceptance-core-${crypto.randomUUID()}.sqlite`);
    const storage = new NodeSqlAcceptanceStorage(database);
    initializeAcceptanceSqlStorage(storage);
    const store = new SqlAcceptanceStore(storage);
    const clock = new ManualClock();
    const core = new AcceptanceCore(store, {
      clock,
      ids: new PredictableIds(),
      signReceipt: async (review) => `receipt:${review.id}`,
    });

    const review = await core.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1"],
      policy: { ttlSeconds: 60 },
    }, "publish-sql-alarm");
    expect(storage.alarms.at(-1)).toBeGreaterThanOrEqual(Date.now());

    const sent: AcceptanceEvent[] = [];
    await flushAcceptanceOutbox(store, {
      send: async (event: AcceptanceEvent) => { sent.push(event); },
    } as unknown as Queue<AcceptanceEvent>);
    await store.scheduleNextAlarm();

    expect(sent.map((event) => event.state)).toEqual(["pending"]);
    expect(await store.listOutbox(10)).toEqual([]);
    expect(storage.alarms.at(-1)).toBe(Date.parse(review.expiresAt));
    database.close();
  });

  it("leaves failed outbox sends durable and schedules retry", async () => {
    const database = await openNodeSqlite(`/tmp/nib-acceptance-core-${crypto.randomUUID()}.sqlite`);
    const storage = new NodeSqlAcceptanceStorage(database);
    initializeAcceptanceSqlStorage(storage);
    const store = new SqlAcceptanceStore(storage);
    const core = new AcceptanceCore(store, {
      clock: new ManualClock(),
      ids: new PredictableIds(),
      signReceipt: async (review) => `receipt:${review.id}`,
    });
    await core.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1"],
    }, "publish-sql-failed-outbox");
    const alarmCount = storage.alarms.length;

    await expect(flushAcceptanceOutbox(store, {
      send: async () => { throw new Error("queue down"); },
    } as unknown as Queue<AcceptanceEvent>)).rejects.toThrow("queue down");

    expect(await store.listOutbox(10)).toHaveLength(1);
    expect(storage.alarms.length).toBeGreaterThan(alarmCount);
    database.close();
  });

  it("serializes concurrent same-key mutations through the real SQLite idempotency table", async () => {
    const database = await openNodeSqlite(`/tmp/nib-acceptance-core-${crypto.randomUUID()}.sqlite`);
    const storage = new NodeSqlAcceptanceStorage(database);
    initializeAcceptanceSqlStorage(storage);
    const store = new SqlAcceptanceStore(storage);
    const core = new AcceptanceCore(store, {
      clock: new ManualClock(),
      ids: new PredictableIds(),
      signReceipt: async (review) => `receipt:${review.id}`,
    });
    const review = await core.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1", "reviewer-2"],
    }, "publish-concurrent");

    const results = await Promise.allSettled([
      core.comment(review.id, "first", "reviewer-1", "shared-comment-key"),
      core.comment(review.id, "second", "reviewer-2", "shared-comment-key"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await core.getReview(review.id))?.comments).toHaveLength(1);
    database.close();
  });

  it("retains distinct concurrent votes and comments through the SQLite store", async () => {
    const database = await openNodeSqlite(`/tmp/nib-acceptance-core-${crypto.randomUUID()}.sqlite`);
    const storage = new NodeSqlAcceptanceStorage(database);
    initializeAcceptanceSqlStorage(storage);
    const store = new SqlAcceptanceStore(storage);
    const core = new AcceptanceCore(store, {
      clock: new ManualClock(),
      ids: new PredictableIds(),
      signReceipt: async (review) => `receipt:${review.id}`,
    });
    const review = await core.publish(manifest(), {
      actorId: "publisher",
      eligibleReviewers: ["reviewer-1", "reviewer-2"],
      policy: { quorum: 2 },
    }, "publish-sql-distinct-concurrent");

    await Promise.all([
      core.comment(review.id, "first comment", "reviewer-1", "sql-comment-1"),
      core.comment(review.id, "second comment", "reviewer-2", "sql-comment-2"),
      core.decide(review.id, {
        decision: "approve",
        criteriaIds: ["criterion-a", "criterion-b"],
      }, {
        actorId: "reviewer-1",
        eligibleReviewers: ["reviewer-1", "reviewer-2"],
      }, "sql-approve-1"),
      core.decide(review.id, {
        decision: "approve",
        criteriaIds: ["criterion-a", "criterion-b"],
      }, {
        actorId: "reviewer-2",
        eligibleReviewers: ["reviewer-1", "reviewer-2"],
      }, "sql-approve-2"),
    ]);

    const stored = await core.getReview(review.id);
    expect(stored?.state).toBe("approved");
    expect(stored?.comments.map((comment) => comment.text).sort()).toEqual(["first comment", "second comment"]);
    expect(stored?.votes.map((vote) => vote.actorId).sort()).toEqual(["reviewer-1", "reviewer-2"]);
    expect(storage.alarms.length).toBeGreaterThan(0);
    database.close();
  });
});

async function openNodeSqlite(path: string): Promise<{ close(): void; exec(sql: string): void; prepare(sql: string): NodeSqliteStatement }> {
  // @ts-ignore node:sqlite is available in the Node test runtime, not the Worker type profile.
  const sqlite = await import("node:sqlite") as { DatabaseSync: new (path: string) => unknown };
  return new sqlite.DatabaseSync(path) as { close(): void; exec(sql: string): void; prepare(sql: string): NodeSqliteStatement };
}

interface NodeSqliteStatement {
  all(...bindings: unknown[]): unknown[];
  get(...bindings: unknown[]): unknown;
  run(...bindings: unknown[]): unknown;
}

class NodeSqlAcceptanceStorage implements AcceptanceSqlStorage {
  readonly alarms: number[] = [];
  readonly statements: string[] = [];
  readonly sql = {
    exec: <T>(statement: string, ...bindings: unknown[]): AcceptanceSqlResult<T> => {
      const trimmed = statement.trim();
      this.statements.push(trimmed);
      const returnsRows = /^SELECT\b/i.test(trimmed);
      if (bindings.length === 0 && !returnsRows) {
        this.database.exec(statement);
        return emptyRows();
      }
      const prepared = this.database.prepare(statement);
      if (!returnsRows) {
        prepared.run(...bindings);
        return emptyRows();
      }
      return {
        toArray: () => prepared.all(...bindings) as T[],
        one: () => {
          const row = prepared.get(...bindings);
          if (row === undefined) throw new Error("SQLite query returned no rows");
          return row as T;
        },
      };
    },
  };

  constructor(private readonly database: { exec(sql: string): void; prepare(sql: string): NodeSqliteStatement }) {}

  transactionSync<T>(callback: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarms.push(scheduledTime);
  }
}

function emptyRows<T>(): AcceptanceSqlResult<T> {
  return {
    toArray: () => [],
    one: () => {
      throw new Error("SQLite statement returned no rows");
    },
  };
}
