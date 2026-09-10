import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountOrigin,
  cookieToken,
  generateSignInCode,
  handleAccountAuth,
  normalizeEmail,
  normalizeSignInCode,
  pkceChallenge,
  safeAuthReturnTo,
  sessionToken,
  signInCodeHash,
} from "./account-auth";
import type { Env } from "./types";

const magicEmail = vi.hoisted(() => ({ links: [] as string[] }));

vi.mock("./magic-email", () => ({
  sendMagicLinkEmail: vi.fn(async (_binding: unknown, _email: string, link: string) => {
    magicEmail.links.push(link);
  }),
}));

describe("Nib account authentication contract", () => {
  beforeEach(() => {
    magicEmail.links = [];
  });

  it("normalizes email without changing plus aliases", () => {
    expect(normalizeEmail(" Doug+Nib@Example.COM ")).toBe("doug+nib@example.com");
    expect(normalizeEmail("not-an-email")).toBeUndefined();
  });

  it("uses the fixed product origin", () => {
    expect(accountOrigin()).toBe("https://nibtool.com");
  });

  it("uses the configured public origin for preview auth links", async () => {
    const response = await handleAccountAuth(new Request("https://preview.example.test/api/auth/challenges", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
      body: JSON.stringify({
        email: "pilot@example.com",
        pkceChallenge: "a".repeat(43),
        platform: "web",
        deviceName: "Preview",
      }),
    }), authEnv("https://preview.example.test"));

    expect(response?.status).toBe(202);
    expect(magicEmail.links).toHaveLength(1);
    expect(magicEmail.links[0]).toMatch(/^https:\/\/preview\.example\.test\/auth\/verify\?/);
    expect(magicEmail.links[0]).not.toContain("nibtool.com");
  });

  it("accepts same-preview auth return targets and rejects cross-origin targets", () => {
    const env = { PUBLIC_ORIGIN: "https://preview.example.test" };
    expect(safeAuthReturnTo("https://preview.example.test/acceptance/projects/p/reviews/r?token=x", env)).toBe(
      "/acceptance/projects/p/reviews/r?token=x",
    );
    expect(safeAuthReturnTo("https://nibtool.com/acceptance/projects/p/reviews/r", env)).toBe("/account");
    expect(safeAuthReturnTo("//preview.example.test/acceptance", env)).toBe("/account");
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

function authEnv(publicOrigin: string): Env {
  return {
    PUBLIC_ORIGIN: publicOrigin,
    AUTH_RATE_LIMIT_SECRET: "preview-rate-limit-secret",
    EMAIL: {},
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              first: async () => sql.includes("COUNT(*)") ? { count: 0 } : null,
              run: async () => ({ meta: { changes: 1 } }),
            };
          },
        };
      },
    },
  } as unknown as Env;
}
