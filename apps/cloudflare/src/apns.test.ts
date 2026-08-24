import { describe, expect, it } from "vitest";
import { apnsCategory, apnsCollapseId, apnsReadiness, apnsRequestBody, sendApnsFanout } from "./apns";

describe("Cloud APNs fanout", () => {
  it("reports exact missing configuration", () => {
    expect(apnsReadiness({})).toMatchObject({
      apnsConfigured: false,
      apnsEnvironment: null,
      apnsTopic: null,
      apnsMissing: ["NIB_APNS_TEAM_ID", "NIB_APNS_KEY_ID", "NIB_APNS_PRIVATE_KEY"]
    });
  });

  it("maps request choices to native action categories", () => {
    expect(apnsCategory({ choices: ["Ship", "Hold", "Revise"] })).toBe("NIB_SHIP_HOLD_REVISE");
    expect(apnsCategory({ choices: ["Approve", "Reject"] })).toBe("NIB_APPROVE_REJECT");
    expect(apnsCategory({ allowText: true })).toBe("NIB_TEXT");
    expect(apnsCategory({ type: "visual-review", allowText: true })).toBe("NIB_APPROVE_REJECT");
  });

  it("fans an alert to every registered topic and a resolution as background", async () => {
    const privateKey = await testPrivateKey();
    const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        init: init || {},
        body: JSON.parse(String(init?.body)) as Record<string, unknown>
      });
      return new Response(null, { status: 200 });
    };
    const env = {
      NIB_APNS_TEAM_ID: "TEAM123",
      NIB_APNS_KEY_ID: "KEY123",
      NIB_APNS_PRIVATE_KEY: privateKey
    };
    const devices = [
      { id: "iphone", token: "token-ios", apnsTopic: "com.douglance.nib", apnsEnvironment: "sandbox" as const },
      { id: "mac", token: "token-mac", apnsTopic: "com.douglance.nib.macos", apnsEnvironment: "production" as const },
      { id: "vision", token: "token-vision", apnsTopic: "com.douglance.nib", apnsEnvironment: "sandbox" as const },
      { id: "watch", token: "token-watch", apnsTopic: "com.douglance.nib.watchkitapp", apnsEnvironment: "sandbox" as const }
    ];

    const alertResults = await sendApnsFanout(env, devices, {
      type: "choice",
      requestId: "request-1",
      title: "Choose",
      body: "Ship this?",
      choices: ["Ship", "Hold"],
      tag: "request:request-1"
    }, fetcher as typeof fetch);
    expect(alertResults).toHaveLength(4);
    expect(alertResults.every((result) => result.sent)).toBe(true);
    expect(calls.map((call) => new Headers(call.init.headers).get("apns-topic"))).toEqual([
      "com.douglance.nib",
      "com.douglance.nib.macos",
      "com.douglance.nib",
      "com.douglance.nib.watchkitapp"
    ]);
    expect(calls.map((call) => new URL(call.url).host)).toEqual([
      "api.sandbox.push.apple.com",
      "api.push.apple.com",
      "api.sandbox.push.apple.com",
      "api.sandbox.push.apple.com"
    ]);
    expect(calls.every((call) => new Headers(call.init.headers).get("apns-push-type") === "alert")).toBe(true);

    calls.length = 0;
    await sendApnsFanout(env, devices, {
      type: "request-resolved",
      requestId: "request-1",
      tag: "request:request-1",
      status: "answered"
    }, fetcher as typeof fetch);
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => new Headers(call.init.headers).get("apns-push-type") === "background")).toBe(true);
    expect(calls.every((call) => (call.body.aps as Record<string, unknown>)["content-available"] === 1)).toBe(true);
    expect(calls.every((call) => (call.body.nib as Record<string, unknown>).type === "request-resolved")).toBe(true);
  });

  it("keeps collapse identifiers within the APNs 64-byte limit", async () => {
    const collapseId = await apnsCollapseId({ tag: `request:${"x".repeat(100)}` });
    expect(new TextEncoder().encode(collapseId).byteLength).toBe(64);
  });

  it("compacts oversized notification content within the APNs payload limit", () => {
    const huge = "🖼️".repeat(4_000);
    const encoded = apnsRequestBody({
      alert: { title: huge, body: huge },
      category: "NIB_APPROVE_REJECT"
    }, {
      type: "visual-review",
      requestId: "request-oversized",
      title: huge,
      body: huge,
      request: huge,
      choices: [huge, huge, huge, huge],
      responseUrl: `https://example.com/${huge}`,
      richAttachment: { url: `https://example.com/${huge}` }
    }, "iphone");

    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(4_096);
    expect((JSON.parse(encoded).nib as Record<string, unknown>).requestId).toBe("request-oversized");
  });

  it("retries transient APNs failures and records attempt count", async () => {
    const privateKey = await testPrivateKey();
    let calls = 0;
    const results = await sendApnsFanout({
      NIB_APNS_TEAM_ID: "TEAM123",
      NIB_APNS_KEY_ID: "KEY123",
      NIB_APNS_PRIVATE_KEY: privateKey
    }, [{
      id: "iphone",
      token: "token-ios",
      apnsTopic: "com.douglance.nib",
      apnsEnvironment: "sandbox"
    }], { requestId: "request-1" }, (async () => {
      calls += 1;
      return calls < 3
        ? new Response('{"reason":"TooManyRequests"}', { status: 429 })
        : new Response(null, { status: 200 });
    }) as typeof fetch);

    expect(results[0]).toMatchObject({ sent: true, attempts: 3, invalidToken: false });
    expect(calls).toBe(3);
  });

  it("marks unregistered tokens for permanent removal without retrying", async () => {
    const privateKey = await testPrivateKey();
    let calls = 0;
    const results = await sendApnsFanout({
      NIB_APNS_TEAM_ID: "TEAM123",
      NIB_APNS_KEY_ID: "KEY123",
      NIB_APNS_PRIVATE_KEY: privateKey
    }, [{
      id: "old-phone",
      token: "stale-token",
      apnsTopic: "com.douglance.nib",
      apnsEnvironment: "production"
    }], { requestId: "request-1" }, (async () => {
      calls += 1;
      return new Response('{"reason":"Unregistered"}', { status: 410 });
    }) as typeof fetch);

    expect(results[0]).toMatchObject({
      sent: false,
      status: 410,
      reason: "Unregistered",
      invalidToken: true,
      attempts: 1
    });
    expect(calls).toBe(1);
  });
});

async function testPrivateKey(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).match(/.{1,64}/g)?.join("\n") || "";
  return `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
}
