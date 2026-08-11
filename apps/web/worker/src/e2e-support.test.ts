import { describe, expect, it } from "vitest";
import { captureE2eMagicLink, e2eSupportResponse } from "./e2e-support";
import type { Env } from "./types";

function testEnv(environment = "e2e"): { env: Env; links: Map<string, string> } {
  const links = new Map<string, string>();
  const env = {
    ENVIRONMENT: environment,
    E2E_TEST_SECRET: "local-secret",
    E2E_MAGIC_LINKS: {
      async put(key: string, value: string) {
        links.set(key, value);
      },
      async get(key: string) {
        return links.get(key) ?? null;
      },
    },
  } as unknown as Env;
  return { env, links };
}

describe("E2E magic-link support", () => {
  it("does not capture anything when the test bindings are absent", async () => {
    await expect(
      captureE2eMagicLink({ ENVIRONMENT: "e2e" } as Env, "person@example.com", "https://example.com/verify"),
    ).resolves.toBe(false);
  });

  it("stays hidden in production even if test bindings are misconfigured", async () => {
    const { env } = testEnv("production");
    await expect(
      captureE2eMagicLink(env, "person@example.com", "https://example.com/verify"),
    ).resolves.toBe(false);
    const response = await e2eSupportResponse(
      new Request("https://app.nibtool.com/__e2e__/magic-link?email=person@example.com", {
        headers: { "x-nib-e2e-secret": "local-secret" },
      }),
      env,
    );
    expect(response?.status).toBe(404);
  });

  it("normalizes email keys and only reveals links with the configured secret", async () => {
    const { env, links } = testEnv();
    await expect(
      captureE2eMagicLink(env, " Person@Example.COM ", "http://localhost/verify"),
    ).resolves.toBe(true);
    expect(links.get("magic-link:person@example.com")).toBe("http://localhost/verify");

    const hidden = await e2eSupportResponse(
      new Request("http://localhost/__e2e__/magic-link?email=person@example.com"),
      env,
    );
    expect(hidden?.status).toBe(404);

    const visible = await e2eSupportResponse(
      new Request("http://localhost/__e2e__/magic-link?email=PERSON@example.com", {
        headers: { "x-nib-e2e-secret": "local-secret" },
      }),
      env,
    );
    expect(visible?.status).toBe(200);
    await expect(visible?.json()).resolves.toEqual({ url: "http://localhost/verify" });
    expect(visible?.headers.get("cache-control")).toBe("no-store");
  });
});
