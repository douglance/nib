import { describe, expect, it } from "vitest";
import {
  accountOrigin,
  cookieToken,
  generateSignInCode,
  normalizeEmail,
  normalizeSignInCode,
  pkceChallenge,
  sessionToken,
  signInCodeHash,
} from "./account-auth";

describe("Nib account authentication contract", () => {
  it("normalizes email without changing plus aliases", () => {
    expect(normalizeEmail(" Doug+Nib@Example.COM ")).toBe("doug+nib@example.com");
    expect(normalizeEmail("not-an-email")).toBeUndefined();
  });

  it("uses the fixed product origin", () => {
    expect(accountOrigin()).toBe("https://nibtool.com");
  });

  it("derives the RFC 7636 challenge", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("accepts bearer and secure-cookie sessions", () => {
    expect(sessionToken(new Request("https://nibtool.com", {
      headers: { authorization: "Bearer nib_session_test" },
    }))).toBe("nib_session_test");
    expect(cookieToken("other=x; nib_session=nib_cookie_test; last=y")).toBe("nib_cookie_test");
  });

  it("normalizes a six-digit email code", () => {
    expect(normalizeSignInCode(" 123 456 ")).toBe("123456");
    expect(normalizeSignInCode("123-456")).toBe("123456");
    expect(normalizeSignInCode("12345")).toBeUndefined();
    expect(normalizeSignInCode("12345x")).toBeUndefined();
  });

  it("generates a six-digit email code", () => {
    expect(generateSignInCode()).toMatch(/^\d{6}$/);
  });

  it("scopes email code hashes to the challenge", async () => {
    const first = await signInCodeHash("challenge-a", "123456");
    expect(first).toBe(await signInCodeHash("challenge-a", "123456"));
    expect(first).not.toBe(await signInCodeHash("challenge-b", "123456"));
  });
});
