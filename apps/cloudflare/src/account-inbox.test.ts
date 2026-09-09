import { describe, expect, it } from "vitest";
import { accountInboxName, canonicalAccountId } from "./account-inbox";

const accountId = "1ecb3e04-7ee7-4b7a-9da7-9f57e47f8a70";

describe("global account inbox identity", () => {
  it("maps every spelling of one account UUID to one inbox", () => {
    expect(canonicalAccountId(`  ${accountId.toUpperCase()}  `)).toBe(accountId);
    expect(accountInboxName(accountId)).toBe(`account:${accountId}`);
    expect(accountInboxName(accountId.toUpperCase())).toBe(`account:${accountId}`);
  });

  it("keeps different user accounts isolated", () => {
    expect(accountInboxName("2fcb3e04-7ee7-4b7a-9da7-9f57e47f8a70"))
      .not.toBe(accountInboxName(accountId));
  });

  it("rejects values that cannot identify a user account", () => {
    expect(canonicalAccountId("not-an-account")).toBeNull();
    expect(() => accountInboxName("not-an-account")).toThrow("Invalid Nib account ID");
  });
});
