import { describe, expect, it } from "vitest";
import {
  hasRequiredExpertScope,
  normalizeExpertTokenRequest,
  parseExpertToken,
  requiredExpertScope,
} from "./expert-token";

describe("Nib expert tokens", () => {
  it("parses only the versioned Nib personal-access-token format", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(parseExpertToken(`nib_pat_${id}_secret-value`)).toEqual({
      id,
      token: `nib_pat_${id}_secret-value`,
    });
    expect(parseExpertToken("nib_pat_short_secret-value")).toBeUndefined();
    expect(parseExpertToken("legacy-token")).toBeUndefined();
  });

  it("allowlists expert scopes and applies a ninety-day default expiry", () => {
    expect(
      normalizeExpertTokenRequest({
        name: "  CI release  ",
        scopes: ["reviews:write", "reviews:read", "reviews:read"],
      }),
    ).toEqual({
      name: "CI release",
      scopes: ["reviews:read", "reviews:write"],
      expiresInDays: 90,
    });

    expect(() =>
      normalizeExpertTokenRequest({
        name: "billing bot",
        scopes: ["billing:write"],
      }),
    ).toThrow("Unsupported token scope");
  });

  it("maps hosted API operations to the least required scope", () => {
    expect(requiredExpertScope(new Request("https://app.nibtool.com/api/requests", { method: "GET" })))
      .toBe("reviews:read");
    expect(requiredExpertScope(new Request("https://app.nibtool.com/api/feedback", { method: "POST" })))
      .toBe("reviews:write");
    expect(requiredExpertScope(new Request("https://app.nibtool.com/v1/generate", { method: "POST" })))
      .toBe("generate:write");
    expect(requiredExpertScope(new Request("https://app.nibtool.com/artifacts/result.png", { method: "GET" })))
      .toBe("generate:read");
  });

  it("does not let a read-only token perform a write", () => {
    expect(hasRequiredExpertScope(["reviews:read"], "reviews:read")).toBe(true);
    expect(hasRequiredExpertScope(["reviews:read"], "reviews:write")).toBe(false);
  });
});
