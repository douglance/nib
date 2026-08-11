import { describe, expect, it } from "vitest";
import { authRateLimitOptions, magicLinkRateLimitOptions } from "./auth";

describe("authentication rate limits", () => {
  it("keeps the production magic-link limit narrow", () => {
    const options = authRateLimitOptions("production");
    expect(options.max).toBe(100);
    expect(options.customRules["/sign-in/magic-link"]).toEqual({
      window: 60,
      max: 5,
    });
    expect(magicLinkRateLimitOptions("production")).toEqual({ window: 60, max: 5 });
  });

  it("allows the isolated browser matrix to exercise repeated sign-in flows", () => {
    const options = authRateLimitOptions("e2e");
    expect(options.max).toBe(10_000);
    expect(options.customRules["/sign-in/magic-link"].max).toBe(1_000);
    expect(magicLinkRateLimitOptions("e2e").max).toBe(1_000);
  });
});
