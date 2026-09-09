import { describe, expect, it } from "vitest";
import { safeAuthReturnTo } from "../account-auth";

describe("acceptance sign-in return destination", () => {
  it("preserves review and invitation destinations through sign-in", () => {
    expect(safeAuthReturnTo("/acceptance/projects/p/reviews/r")).toBe("/acceptance/projects/p/reviews/r");
    expect(safeAuthReturnTo("/acceptance?invitation=secret-token")).toBe("/acceptance?invitation=secret-token");
    expect(safeAuthReturnTo("/r/account/request")).toBe("/r/account/request");
  });
  it.each([null, "https://evil.example/acceptance", "//evil.example/acceptance", "/\\evil.example/acceptance", "/api/account", "/acceptance/../../api/account", "/acceptance?x=</script>"])("rejects unsafe or unsupported destination %s", (value) => {
    expect(safeAuthReturnTo(value)).toBe("/account");
  });
});
