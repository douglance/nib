import { describe, expect, it } from "vitest";
import { isTrustedAccountMutation, tenantFromAccessPayload } from "./access";

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

describe("account mutation origin checks", () => {
  const env = { PUBLIC_ORIGIN: "https://app.nibtool.com" };

  it("allows same-origin browser mutations", () => {
    const request = new Request("https://app.nibtool.com/api/account/tokens", {
      method: "POST",
      headers: { origin: "https://app.nibtool.com" },
    });
    expect(isTrustedAccountMutation(request, env)).toBe(true);
  });

  it("rejects cross-origin and originless cookie-backed mutations", () => {
    expect(isTrustedAccountMutation(new Request("https://app.nibtool.com/api/account/tokens", {
      method: "POST",
      headers: { origin: "https://attacker.example" },
    }), env)).toBe(false);
    expect(isTrustedAccountMutation(new Request("https://app.nibtool.com/api/account/tokens", {
      method: "POST",
    }), env)).toBe(false);
  });

  it("allows non-browser clients with an authorization credential", () => {
    const request = new Request("https://app.nibtool.com/api/account/tokens", {
      method: "POST",
      headers: { authorization: "Bearer device-token" },
    });
    expect(isTrustedAccountMutation(request, env)).toBe(true);
  });
});
