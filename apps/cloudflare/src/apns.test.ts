import { describe, expect, it, vi } from "vitest";
import { ApnsClient, apnsConfiguration, apnsPayload } from "./apns";

const device = {
  id: "device-1",
  token: "aabbccdd",
  apnsTopic: "com.douglance.nib",
};

describe("APNs configuration", () => {
  it("reports every missing credential", () => {
    expect(apnsConfiguration({})).toMatchObject({
      configured: false,
      environment: "sandbox",
      keyConfigured: false,
      keyReadable: false,
      missing: ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_PRIVATE_KEY"],
    });
  });

  it("rejects malformed private keys before delivery", () => {
    expect(apnsConfiguration({
      APNS_KEY_ID: "KEY",
      APNS_TEAM_ID: "TEAM",
      APNS_PRIVATE_KEY: "not-a-key",
    }).missing).toEqual(["APNS_PRIVATE_KEY is not a readable PKCS#8 key"]);
  });
});

describe("APNs payload", () => {
  it("includes the native category, request route, and device identity", () => {
    expect(apnsPayload(device, {
      title: "Review",
      body: "Choose a result",
      category: "NIB_APPROVE_HOLD",
      requestId: "request-1",
    })).toEqual({
      aps: {
        alert: { title: "Review", body: "Choose a result" },
        sound: "default",
        category: "NIB_APPROVE_HOLD",
      },
      nib: { requestId: "request-1", deviceId: "device-1" },
    });
  });
});

describe("APNs delivery", () => {
  it("signs a provider token and sends the device topic to sandbox APNs", async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const privateKey = pem(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
    const sendFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const client = new ApnsClient({
      APNS_KEY_ID: "KEY123",
      APNS_TEAM_ID: "TEAM123",
      APNS_PRIVATE_KEY: privateKey,
      APNS_ENVIRONMENT: "sandbox",
    }, sendFetch, () => new Date("2026-08-12T12:00:00.000Z"));

    await expect(client.send(device, {
      title: "Nib",
      body: "Ready",
      category: "NIB_OPEN",
    })).resolves.toEqual({ ok: true, status: 200, error: null });

    const [url, init] = sendFetch.mock.calls[0];
    expect(url).toBe("https://api.sandbox.push.apple.com/3/device/aabbccdd");
    expect(new Headers(init?.headers).get("apns-topic")).toBe("com.douglance.nib");
    expect(new Headers(init?.headers).get("authorization")).toMatch(/^bearer [^.]+\.[^.]+\.[^.]+$/);
  });

  it("returns Apple's reason for a rejected device token", async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const sendFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json(
      { reason: "BadDeviceToken" },
      { status: 400 },
    ));
    const client = new ApnsClient({
      APNS_KEY_ID: "KEY123",
      APNS_TEAM_ID: "TEAM123",
      APNS_PRIVATE_KEY: pem(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)),
    }, sendFetch);
    await expect(client.send(device, {
      title: "Nib",
      body: "Ready",
      category: "NIB_OPEN",
    })).resolves.toEqual({ ok: false, status: 400, error: "BadDeviceToken" });
  });
});

function pem(bytes: ArrayBuffer): string {
  const encoded = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
}
