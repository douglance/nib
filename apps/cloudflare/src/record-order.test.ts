import { describe, expect, it } from "vitest";
import { compareRecordsByRecency, isTopLevelRequestStorageKey } from "./record-order";

describe("record recency ordering", () => {
  it("falls back to createdAt for legacy records without updatedAt", () => {
    const records = [
      { id: "older", createdAt: "2026-08-10T00:00:00.000Z" },
      { id: "newer", updatedAt: "2026-08-11T00:00:00.000Z" },
    ];

    expect(records.sort(compareRecordsByRecency).map((record) => record.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("orders undated legacy records deterministically without throwing", () => {
    const records = [{ id: "a" }, { id: "b" }, {}];

    expect(() => records.sort(compareRecordsByRecency)).not.toThrow();
    expect(records.map((record) => record.id ?? "")).toEqual(["b", "a", ""]);
  });
});

describe("request storage keys", () => {
  it("accepts only top-level request records", () => {
    expect(isTopLevelRequestStorageKey("request:req-123")).toBe(true);
    expect(isTopLevelRequestStorageKey("request:req-123:decision:dec-1")).toBe(false);
    expect(isTopLevelRequestStorageKey("request:req-123:capability:cap-1")).toBe(false);
    expect(isTopLevelRequestStorageKey("device:req-123")).toBe(false);
  });
});
