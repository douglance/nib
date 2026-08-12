export interface ApnsEnv {
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_ENVIRONMENT?: string;
}

export interface ApnsDevice {
  id: string;
  token: string;
  apnsTopic: string | null;
}

export interface ApnsMessage {
  title: string;
  body: string;
  category: string;
  requestId?: string;
}

export interface ApnsResult {
  ok: boolean;
  status: number;
  error: string | null;
}

export interface ApnsConfiguration {
  configured: boolean;
  environment: "sandbox" | "production";
  keyConfigured: boolean;
  keyReadable: boolean;
  missing: string[];
}

export function apnsConfiguration(env: ApnsEnv): ApnsConfiguration {
  const environment = env.APNS_ENVIRONMENT === "production" ? "production" : "sandbox";
  const keyConfigured = Boolean(env.APNS_PRIVATE_KEY);
  const keyReadable = Boolean(env.APNS_PRIVATE_KEY && privateKeyBytes(env.APNS_PRIVATE_KEY));
  const missing: string[] = [];
  if (!env.APNS_KEY_ID) missing.push("APNS_KEY_ID");
  if (!env.APNS_TEAM_ID) missing.push("APNS_TEAM_ID");
  if (!env.APNS_PRIVATE_KEY) missing.push("APNS_PRIVATE_KEY");
  else if (!keyReadable) missing.push("APNS_PRIVATE_KEY is not a readable PKCS#8 key");
  return {
    configured: missing.length === 0,
    environment,
    keyConfigured,
    keyReadable,
    missing,
  };
}

export function apnsPayload(device: ApnsDevice, message: ApnsMessage): Record<string, unknown> {
  return {
    aps: {
      alert: { title: message.title, body: message.body },
      sound: "default",
      category: message.category,
    },
    nib: {
      ...(message.requestId ? { requestId: message.requestId } : {}),
      deviceId: device.id,
    },
  };
}

export class ApnsClient {
  private providerToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly env: ApnsEnv,
    private readonly sendFetch: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => Date = () => new Date(),
  ) {}

  configuration(): ApnsConfiguration {
    return apnsConfiguration(this.env);
  }

  async send(device: ApnsDevice, message: ApnsMessage): Promise<ApnsResult> {
    const configuration = this.configuration();
    if (!configuration.configured) {
      return { ok: false, status: 0, error: `APNs is not configured: ${configuration.missing.join(", ")}` };
    }
    if (!device.apnsTopic) return { ok: false, status: 0, error: "Device has no APNs topic" };
    if (!/^[0-9a-f]+$/i.test(device.token)) return { ok: false, status: 0, error: "Device has an invalid APNs token" };

    try {
      const host = configuration.environment === "production"
        ? "api.push.apple.com"
        : "api.sandbox.push.apple.com";
      const response = await this.sendFetch(`https://${host}/3/device/${device.token}`, {
        method: "POST",
        headers: {
          authorization: `bearer ${await this.token()}`,
          "apns-topic": device.apnsTopic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "content-type": "application/json",
        },
        body: JSON.stringify(apnsPayload(device, message)),
      });
      if (response.ok) return { ok: true, status: response.status, error: null };
      const body: { reason?: string } = await response.json<{ reason?: string }>().catch(() => ({}));
      return { ok: false, status: response.status, error: body.reason || `APNs returned ${response.status}` };
    } catch (error) {
      return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async token(): Promise<string> {
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    if (this.providerToken && this.providerToken.expiresAt > nowSeconds) return this.providerToken.value;
    const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: this.env.APNS_KEY_ID })));
    const claims = base64Url(new TextEncoder().encode(JSON.stringify({ iss: this.env.APNS_TEAM_ID, iat: nowSeconds })));
    const signingInput = `${header}.${claims}`;
    const keyBytes = privateKeyBytes(this.env.APNS_PRIVATE_KEY || "");
    if (!keyBytes) throw new Error("APNs private key is unreadable");
    const key = await crypto.subtle.importKey(
      "pkcs8",
      keyBytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput),
    );
    const value = `${signingInput}.${base64Url(new Uint8Array(signature))}`;
    this.providerToken = { value, expiresAt: nowSeconds + 50 * 60 };
    return value;
  }
}

function privateKeyBytes(pem: string): ArrayBuffer | null {
  const encoded = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  if (!encoded) return null;
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  } catch {
    return null;
  }
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
