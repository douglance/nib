import { describe, expect, it } from "vitest";
import { authPageResponse } from "./app-ui";

describe("Nib account pages", () => {
  it("renders magic link and passkey sign-in", async () => {
    const html = await (authPageResponse("/signin") as Response).text();
    expect(html).toContain("Email me a sign-in link");
    expect(html).toContain("Use a passkey");
  });

  it("renders device approval as an authenticated decision", async () => {
    const html = await (authPageResponse("/device") as Response).text();
    expect(html).toContain("Approve this device");
    expect(html).toContain("Only approve a code you started");
  });

  it("renders scoped expert-token controls with one-time secret guidance", async () => {
    const html = await (authPageResponse("/account") as Response).text();
    expect(html).toContain("Expert tokens");
    expect(html).toContain("data-token-form");
    expect(html).toContain("data-token-list");
    expect(html).toContain("Copy this token now");
    expect(html).toContain("reviews:read");
  });

  it("renders account security and paid-plan controls", async () => {
    const html = await (authPageResponse("/account") as Response).text();
    expect(html).toContain("Add a passkey");
    expect(html).toContain('name="plan" value="default"');
    expect(html).toContain('name="plan" value="high"');
    expect(html).toContain("Choose Default");
    expect(html).toContain("Choose High");
    expect(html).not.toContain("Choose Starter");
    expect(html).not.toContain("Choose Pro");
    expect(html).toContain("Manage billing");
  });
});
