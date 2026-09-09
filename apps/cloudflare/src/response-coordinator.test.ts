import { describe, expect, it } from "vitest";
import {
  commitFirstResponse,
  responseChoiceValue,
  visualResponseError,
  type ResponseTransaction
} from "./response-coordinator";

interface TestResponse {
  id: string;
  idempotencyKey?: string;
}

interface TestRequest {
  responses: TestResponse[];
  status: string;
  answeredAt: string | null;
  actedAt: string | null;
  updatedAt: string;
}

describe("response coordination", () => {
  it("resolves notification choice indexes to canonical choice text", () => {
    expect(responseChoiceValue({ choiceIndex: 1 }, ["Approve", "Reject"])).toBe("Reject");
    expect(responseChoiceValue({ decision: " hold ", choiceIndex: 0 }, ["Approve"])).toBe("hold");
    expect(responseChoiceValue({ choiceIndex: 9 }, ["Approve"])).toBe("");
    expect(responseChoiceValue({ choiceIndex: 0 }, ["approve", "reject"])).toBe("approve");
  });

  it("shares one validation contract across every visual-review client", () => {
    expect(visualResponseError("approve", "")).toBeNull();
    expect(visualResponseError("reject", "Needs work")).toBeNull();
    expect(visualResponseError("comment", "Tighten the spacing")).toBeNull();
    expect(visualResponseError("", "A comment without an explicit decision")).toBeNull();
    expect(visualResponseError("comment", "")).toBe("A comment response requires nonempty text");
    expect(visualResponseError("ship", "")).toBe(
      "Visual review decision must be approve, reject, or comment"
    );
  });

  it("commits one simultaneous response and returns exact retries", async () => {
    const store = new SerializedStore({
      responses: [],
      status: "open",
      answeredAt: null,
      actedAt: null,
      updatedAt: "before"
    });
    const now = "2026-08-12T00:00:00.000Z";
    const submit = (id: string) => commitFirstResponse<TestResponse, TestRequest>({
      runTransaction: (callback) => store.transaction(callback),
      storageKey: "request:one",
      response: { id, idempotencyKey: `key-${id}` },
      idempotencyKey: `key-${id}`,
      acted: false,
      now
    });

    const simultaneous = await Promise.all([submit("phone"), submit("mac")]);
    expect(simultaneous.map((result) => result.outcome).sort()).toEqual(["accepted", "conflict"]);
    const accepted = simultaneous.find((result) => result.outcome === "accepted");
    expect(accepted?.outcome).toBe("accepted");
    if (!accepted || accepted.outcome !== "accepted") throw new Error("No response was accepted");
    const winner = accepted.item.responses[0];

    const retry = await commitFirstResponse<TestResponse, TestRequest>({
      runTransaction: (callback) => store.transaction(callback),
      storageKey: "request:one",
      response: { id: "replacement", idempotencyKey: winner.idempotencyKey },
      idempotencyKey: winner.idempotencyKey || "",
      acted: false,
      now: "later"
    });
    expect(retry.outcome).toBe("retry");
    if (retry.outcome !== "retry") throw new Error("Retry was not returned");
    expect(retry.item.responses).toEqual([winner]);
    expect(retry.item.updatedAt).toBe(now);
  });
});

class SerializedStore {
  private value: TestRequest;
  private tail: Promise<void> = Promise.resolve();

  constructor(value: TestRequest) {
    this.value = structuredClone(value);
  }

  async transaction<Value>(callback: (transaction: ResponseTransaction) => Promise<Value>): Promise<Value> {
    let release: () => void = () => {};
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const transaction: ResponseTransaction = {
        get: async <Stored>() => structuredClone(this.value) as Stored,
        put: async <Stored>(_key: string, value: Stored) => {
          this.value = structuredClone(value) as TestRequest;
        }
      };
      return await callback(transaction);
    } finally {
      release();
    }
  }
}
