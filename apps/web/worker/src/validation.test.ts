import { describe, expect, it } from "vitest";
import { validateGenerationRequest } from "./validation";
import type { GenerationRequest } from "./types";

const valid: GenerationRequest = {
  prompt: "A focused settings screen",
  references: [],
  quality: "standard",
  aspect: "16:9",
  resolution: "2K",
  format: "png",
  background: false,
};

describe("generation boundary validation", () => {
  it("accepts the default contract", () => {
    expect(validateGenerationRequest(valid)).toBeUndefined();
  });

  it("rejects malformed reference data", () => {
    expect(
      validateGenerationRequest({
        ...valid,
        references: [{ name: "bad.png", mime_type: "image/png", data: "not base64" }],
      }),
    ).toBe("reference data must be base64");
  });

  it("rejects fast output above 1K", () => {
    expect(validateGenerationRequest({ ...valid, quality: "fast", resolution: "2K" })).toBe("fast quality only supports 1K");
  });
});
