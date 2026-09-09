import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));

import { consumeMetering } from "./billing";
import { runMaintenance } from "./generation";

const accountId = "11111111-1111-4111-8111-111111111111";
const databases = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  sqlite.prepare("INSERT INTO accounts(account_id, email, stripe_customer_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)")
    .run(accountId, "metering@example.test", "cus_db");
  sqlite.prepare(
    `INSERT INTO jobs(id, account_id, status, model, quality, resolution, format, aspect, usage_cents, created_at, updated_at)
     VALUES (?, ?, 'succeeded', 'model', 'fast', '1K', 'png', '1:1', 12, 1, 1)`,
  ).run("job-123", accountId);
  sqlite.prepare(
    `INSERT INTO usage_ledger(identifier, account_id, job_id, usage_cents, state, created_at)
     VALUES ('nib_job-123', ?, 'job-123', 12, 'queued', 1234)`,
  ).run(accountId);
  const sentUpdatesToFail = [];
  const queueSend = vi.fn();
  function prepare(sql, values = []) {
    return {
      bind: (...args) => prepare(sql, args),
      first: async () => sqlite.prepare(sql).get(...values) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
      run: async () => {
        if (sql.includes("UPDATE usage_ledger SET state = 'sent'") && sentUpdatesToFail.length) {
          throw sentUpdatesToFail.shift();
        }
        return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } };
      },
    };
  }
  const env = {
    PUBLIC_ORIGIN: "https://nib.example.com",
    DEFAULT_PRICE_ID: "price_default",
    HIGH_PRICE_ID: "price_high",
    USAGE_PRICE_ID: "price_usage",
    STRIPE_USAGE_EVENT_NAME: "visualize_usage_cents",
    STRIPE_SECRET_KEY: "test-only-api-key",
    DB: { prepare },
    ARTIFACTS: { delete: vi.fn() },
    METERING_QUEUE: { send: queueSend },
  };
  const message = {
    body: { identifier: "nib_job-123", tenantId: "wrong-account", stripeCustomerId: "cus_wrong", value: 999 },
    ack: vi.fn(),
    retry: vi.fn(),
  };
  return {
    sqlite,
    env,
    queueSend,
    message,
    sentUpdatesToFail,
    batch: { messages: [message] },
    ledger: () => sqlite.prepare("SELECT * FROM usage_ledger WHERE identifier = 'nib_job-123'").get(),
  };
}

describe("Stripe usage metering retries", () => {
  it("freezes the Stripe payload from the ledger and replays it with one idempotency key after a lost local update", async () => {
    const f = fixture();
    f.sentUpdatesToFail.push(new Error("local D1 update failed after Stripe accepted the meter event"));
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await consumeMetering(f.batch, f.env);

    expect(f.message.retry).toHaveBeenCalledOnce();
    expect(f.message.ack).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    const first = requestSnapshot(fetchMock.mock.calls[0]);
    expect(first.headers.get("Idempotency-Key")).toBe("nib-meter-nib_job-123");
    expect(first.body).toEqual({
      event_name: "visualize_usage_cents",
      identifier: "nib_job-123",
      timestamp: "1234",
      "payload[stripe_customer_id]": "cus_db",
      "payload[value]": "12",
    });
    expect(f.ledger()).toMatchObject({
      state: "queued",
      first_attempt_at: expect.any(Number),
      stripe_event_name: "visualize_usage_cents",
      stripe_customer_id: "cus_db",
      stripe_value: 12,
      stripe_event_timestamp: 1234,
      reconciliation_required: 0,
    });

    await consumeMetering(f.batch, f.env);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestSnapshot(fetchMock.mock.calls[1])).toEqual(first);
    expect(f.ledger()).toMatchObject({ state: "sent", sent_at: expect.any(Number), reconciliation_required: 0 });
    expect(f.message.ack).toHaveBeenCalledOnce();
  });

  it("acknowledges already-sent ledger rows without calling Stripe", async () => {
    const f = fixture();
    f.sqlite.prepare("UPDATE usage_ledger SET state = 'sent', sent_at = 2000 WHERE identifier = 'nib_job-123'").run();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await consumeMetering(f.batch, f.env);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(f.message.ack).toHaveBeenCalledOnce();
    expect(f.message.retry).not.toHaveBeenCalled();
  });

  it("holds first attempts older than the Stripe idempotency safety window for reconciliation", async () => {
    const f = fixture();
    const oldAttempt = Math.floor(Date.now() / 1000) - 23 * 60 * 60 - 1;
    f.sqlite.prepare(
      `UPDATE usage_ledger
       SET first_attempt_at = ?, stripe_event_name = 'visualize_usage_cents', stripe_customer_id = 'cus_db',
           stripe_value = 12, stripe_event_timestamp = 1234
       WHERE identifier = 'nib_job-123'`,
    ).run(oldAttempt);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await consumeMetering(f.batch, f.env);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(f.ledger()).toMatchObject({ state: "queued", reconciliation_required: 1 });
    expect(f.message.ack).toHaveBeenCalledOnce();
    expect(f.message.retry).not.toHaveBeenCalled();
  });

  it("marks Stripe duplicate-identifier rejections for manual reconciliation instead of retrying forever", async () => {
    const f = fixture();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("An event already exists with identifier nib_job-123", { status: 400 })));

    await consumeMetering(f.batch, f.env);

    expect(f.ledger()).toMatchObject({ state: "queued", reconciliation_required: 1 });
    expect(f.message.ack).toHaveBeenCalledOnce();
    expect(f.message.retry).not.toHaveBeenCalled();
  });

  it("does not requeue ledger rows held for reconciliation during maintenance", async () => {
    const f = fixture();
    f.sqlite.prepare(
      "UPDATE usage_ledger SET created_at = unixepoch() - 600, reconciliation_required = 1 WHERE identifier = 'nib_job-123'",
    ).run();

    await runMaintenance(f.env);

    expect(f.queueSend).not.toHaveBeenCalled();
  });
});

function requestSnapshot(call) {
  const [, options] = call;
  return {
    headers: new Headers(options.headers),
    body: Object.fromEntries(options.body),
  };
}
