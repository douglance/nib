import { describe, expect, it } from "vitest";

import { canonicalJson, hashAcceptanceManifest, type AcceptanceManifest } from "./contracts";

// @ts-ignore Vitest provides Node built-ins; this package intentionally does not carry Node types.
const { readFileSync } = await import("node:fs");

const fixture = (name: string): string =>
  readFileSync(new URL(`../../../../../crates/nib-storage/tests/fixtures/${name}`, import.meta.url), "utf8").trim();

describe("acceptance canonical JSON contract", () => {
  it("matches the Rust acceptance manifest hash fixture exactly", async () => {
    const manifest = JSON.parse(fixture("acceptance_manifest.canonical.json")) as AcceptanceManifest;

    expect(canonicalJson(manifest)).toBe(fixture("acceptance_manifest.canonical.json"));
    await expect(hashAcceptanceManifest(manifest)).resolves.toBe(fixture("acceptance_manifest.sha256"));
  });

  it("matches the Rust unknown numeric and unicode fixture exactly", async () => {
    const value = JSON.parse(fixture("acceptance_canonical_probe.json"));
    const canonical = fixture("acceptance_canonical_probe.canonical.json");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    const sha256 = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    expect(canonicalJson(value)).toBe(canonical);
    expect(sha256).toBe(fixture("acceptance_canonical_probe.sha256"));
  });
});
