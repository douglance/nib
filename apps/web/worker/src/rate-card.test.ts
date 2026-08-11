import { describe, expect, it } from "vitest";
import { MODEL_BY_QUALITY, PLAN_LIMITS, usageCents } from "./rate-card";
import { validateGenerationRequest } from "./validation";

describe("the public generation contract", () => {
  it("keeps plan limits distinct without changing model access", () => {
    expect(PLAN_LIMITS.default.active).toBe(2);
    expect(PLAN_LIMITS.high.active).toBe(8);
    expect(MODEL_BY_QUALITY).toEqual({
      fast: "google/nano-banana-2-lite",
      standard: "google/nano-banana-2",
      pro: "google/nano-banana-pro",
    });
  });

  it("meters cents as one Stripe meter unit per cent", () => {
    expect(usageCents("fast", "1K")).toBe(12);
    expect(usageCents("standard", "2K")).toBe(32);
    expect(usageCents("pro", "4K")).toBe(75);
  });

  it("rejects capture and review-free contract violations before inference", () => {
    expect(
      validateGenerationRequest({
        prompt: "A focused UI",
        references: [],
        quality: "fast",
        aspect: "16:9",
        resolution: "2K",
        format: "png",
        background: false,
      }),
    ).toBe("fast quality only supports 1K");
  });
});
