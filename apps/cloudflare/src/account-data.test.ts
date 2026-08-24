import { describe, expect, it } from "vitest";
import { purgeReviewAccount } from "./account-data";

class FakeStorage {
  values = new Map<string, unknown>();

  async deleteAll(): Promise<void> {
    this.values.clear();
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

class FakeR2Bucket {
  values = new Set<string>();

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const prefix = options?.prefix ?? "";
    const objects = [...this.values]
      .filter((key) => key.startsWith(prefix))
      .slice(0, options?.limit ?? 1_000)
      .map((key) => ({ key }));
    return { objects, truncated: false } as R2Objects;
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }
}

describe("account review data deletion", () => {
  it("purges the account's attachments and nib files without touching another account", async () => {
    const storage = new FakeStorage();
    storage.values.set("request:one", { id: "one" });
    storage.values.set("device:one", { id: "device" });
    const media = new FakeR2Bucket();
    media.values.add("accounts/account-a/attachments/request.png");
    media.values.add("tenants/account-a/nib-files/file/content");
    media.values.add("tenants/account-a/nib-files/file/preview");
    media.values.add("accounts/account-b/attachments/keep.png");

    const result = await purgeReviewAccount(
      "account-a",
      storage as unknown as DurableObjectStorage,
      media as unknown as R2Bucket,
      "2026-08-13T18:00:00.000Z",
    );

    expect(result).toEqual({ deletedObjects: 3 });
    expect([...media.values]).toEqual(["accounts/account-b/attachments/keep.png"]);
    expect(storage.values).toEqual(new Map([
      ["account:deleted", { deletedAt: "2026-08-13T18:00:00.000Z" }],
    ]));
  });
});
