import { describe, expect, it } from "vitest";
import { tenantFromAccessPayload } from "./access";

describe("Cloudflare Access tenant identity", () => {
  it("uses the verified user email", () => {
    expect(tenantFromAccessPayload({ email: " User@Example.COM " })).toBe("user@example.com");
  });

  it("uses the service-token client ID when no email exists", () => {
    expect(tenantFromAccessPayload({ common_name: "ABC.access" })).toBe("service-token:abc.access");
  });

  it("rejects a verified token without a stable tenant claim", () => {
    expect(tenantFromAccessPayload({ sub: "opaque-user" })).toBeUndefined();
  });
});
