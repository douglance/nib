export interface ApnsEnv {
  NIB_APNS_TEAM_ID?: string;
  NIB_APNS_KEY_ID?: string;
  NIB_APNS_PRIVATE_KEY?: string;
}

export interface ApnsDevice {
  id: string;
  token: string;
  apnsTopic: string;
  apnsEnvironment: "sandbox" | "production";
}

export interface ApnsReadiness {
  apnsConfigured: boolean;
  apnsEnvironment: null;
  apnsTopic: string | null;
  apnsKeyConfigured: boolean;
  apnsKeyReadable: boolean;
  apnsMissing: string[];
  apnsIssues: string[];
}

export interface ApnsResult {
  deviceId: string;
  sent: boolean;
  error: string | null;
  status: number | null;
  reason: string | null;
  invalidToken: boolean;
  attempts: number;
}

export interface ApnsPayload {
  title?: string;
  body?: string;
  request?: string;
  requestId?: string;
  tag?: string;
  type?: string;
  choices?: unknown[];
  allowText?: boolean;
  richAttachment?: unknown;
  [key: string]: unknown;
}

export function apnsReadiness(env: ApnsEnv): ApnsReadiness {
  const required: Array<[string, string | undefined]> = [
    ["NIB_APNS_TEAM_ID", env.NIB_APNS_TEAM_ID],
    ["NIB_APNS_KEY_ID", env.NIB_APNS_KEY_ID],
    ["NIB_APNS_PRIVATE_KEY", env.NIB_APNS_PRIVATE_KEY]
  ];
  const apnsMissing = required.filter(([, value]) => !value?.trim()).map(([name]) => name);
  const apnsIssues = [...apnsMissing];
  if (env.NIB_APNS_PRIVATE_KEY && !env.NIB_APNS_PRIVATE_KEY.includes("BEGIN PRIVATE KEY")) {
    apnsIssues.push("NIB_APNS_PRIVATE_KEY must contain a PKCS#8 .p8 private key");
  }
  return {
    apnsConfigured: apnsIssues.length === 0,
    apnsEnvironment: null,
    apnsTopic: null,
    apnsKeyConfigured: Boolean(env.NIB_APNS_PRIVATE_KEY?.trim()),
    apnsKeyReadable: Boolean(env.NIB_APNS_PRIVATE_KEY?.includes("BEGIN PRIVATE KEY")),
    apnsMissing,
    apnsIssues
  };
}

export async function sendApnsFanout(
  env: ApnsEnv,
  devices: ApnsDevice[],
  payload: ApnsPayload,
  fetcher: typeof fetch = fetch
): Promise<ApnsResult[]> {
  if (!devices.length) return [];
  const readiness = apnsReadiness(env);
  if (!readiness.apnsConfigured) {
    const error = readiness.apnsIssues.join(", ") || "APNs is not configured";
    return devices.map((device) => ({
      deviceId: device.id,
      sent: false,
      error,
      status: null,
      reason: null,
      invalidToken: false,
      attempts: 0
    }));
  }
  const jwt = await apnsJwt(env as Required<Pick<ApnsEnv, "NIB_APNS_TEAM_ID" | "NIB_APNS_KEY_ID" | "NIB_APNS_PRIVATE_KEY">>);
  return Promise.all(devices.map(async (device) => {
    try {
      const attempts = await sendApnsToDevice(env, jwt, device, payload, fetcher);
      return {
        deviceId: device.id,
        sent: true,
        error: null,
        status: 200,
        reason: null,
        invalidToken: false,
        attempts
      };
    } catch (error) {
      const failure = error instanceof ApnsDeliveryError ? error : null;
      return {
        deviceId: device.id,
        sent: false,
        error: error instanceof Error ? error.message : "APNs delivery failed",
        status: failure?.status ?? null,
        reason: failure?.reason ?? null,
        invalidToken: failure?.invalidToken ?? false,
        attempts: failure?.attempts ?? 1
      };
    }
  }));
}

async function sendApnsToDevice(
  env: ApnsEnv,
  jwt: string,
  device: ApnsDevice,
  payload: ApnsPayload,
  fetcher: typeof fetch
): Promise<number> {
  const resolution = payload.type === "request-resolved";
  const aps: Record<string, unknown> = resolution
    ? { "content-available": 1, badge: 0 }
    : {
      alert: {
        title: truncateUtf8(String(payload.title || "Nib"), 160),
        body: truncateUtf8(String(payload.body || payload.request || "Open Nib"), 1_200)
      },
      sound: "default",
      badge: 1,
      category: apnsCategory(payload),
      "thread-id": truncateUtf8(String(payload.tag || payload.requestId || "nib"), 128)
    };
  if (!resolution && payload.richAttachment) aps["mutable-content"] = 1;
  const environment = device.apnsEnvironment;
  const host = environment === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
  const topic = device.apnsTopic.trim();
  if (!topic) throw new Error("APNs topic is missing for this device");
  const url = `https://${host}/3/device/${encodeURIComponent(device.token)}`;
  const request = {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": topic,
      "apns-push-type": resolution ? "background" : "alert",
      "apns-priority": resolution ? "5" : "10",
      "apns-collapse-id": await apnsCollapseId(payload),
      "content-type": "application/json"
    },
    body: apnsRequestBody(aps, payload, device.id)
  } satisfies RequestInit;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetcher(url, request);
    if (response.ok) return attempt;
    const detail = (await response.text()).slice(0, 500);
    const reason = apnsReason(detail);
    if (!isTransientApnsStatus(response.status) || attempt === 3) {
      throw new ApnsDeliveryError(response.status, reason, detail, attempt);
    }
    await delay(attempt * 100);
  }
  throw new Error("APNs delivery failed");
}

class ApnsDeliveryError extends Error {
  readonly invalidToken: boolean;

  constructor(
    readonly status: number,
    readonly reason: string | null,
    detail: string,
    readonly attempts: number
  ) {
    super(`APNs ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "ApnsDeliveryError";
    this.invalidToken = status === 410 || reason === "Unregistered" || reason === "BadDeviceToken";
  }
}

function apnsReason(detail: string): string | null {
  try {
    const parsed = JSON.parse(detail) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : null;
  } catch {
    return null;
  }
}

function isTransientApnsStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function apnsRequestBody(
  aps: Record<string, unknown>,
  payload: ApnsPayload,
  deviceId: string
): string {
  const compactAps = compactApsPayload(aps);
  const nib: Record<string, unknown> = {
    type: compactString(payload.type, 80),
    requestId: compactString(payload.requestId, 512),
    title: compactString(payload.title, 160),
    body: compactString(payload.body, 1_200),
    request: compactString(payload.request, 1_200),
    choices: Array.isArray(payload.choices)
      ? payload.choices.slice(0, 3).map((choice) => truncateUtf8(String(choice), 80))
      : undefined,
    allowText: typeof payload.allowText === "boolean" ? payload.allowText : undefined,
    projectId: compactString(payload.projectId, 256),
    projectName: compactString(payload.projectName, 160),
    url: compactString(payload.url, 1_024),
    responseUrl: compactString(payload.responseUrl, 1_024),
    tag: compactString(payload.tag, 256),
    priority: compactString(payload.priority, 80),
    createdAt: compactString(payload.createdAt, 80),
    status: compactString(payload.status, 80),
    responseId: compactString(payload.responseId, 512),
    richAttachment: payload.richAttachment,
    deviceId
  };
  for (const key of Object.keys(nib)) {
    if (nib[key] === undefined) delete nib[key];
  }

  let encoded = JSON.stringify({ aps: compactAps, nib });
  for (const key of ["richAttachment", "request", "responseUrl", "projectName", "url", "createdAt", "body", "title"]) {
    if (utf8Length(encoded) <= 4_096) return encoded;
    delete nib[key];
    encoded = JSON.stringify({ aps: compactAps, nib });
  }
  if (utf8Length(encoded) > 4_096) {
    throw new Error("APNs payload exceeds 4096 bytes after compaction");
  }
  return encoded;
}

function compactApsPayload(aps: Record<string, unknown>): Record<string, unknown> {
  const compact = { ...aps };
  const alert = aps.alert;
  if (alert && typeof alert === "object" && !Array.isArray(alert)) {
    const values = alert as Record<string, unknown>;
    compact.alert = {
      ...values,
      title: compactString(values.title, 160),
      body: compactString(values.body, 1_200)
    };
  }
  if (compact["thread-id"] !== undefined) {
    compact["thread-id"] = compactString(compact["thread-id"], 128);
  }
  return compact;
}

function compactString(value: unknown, maximumBytes: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return truncateUtf8(String(value), maximumBytes);
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (utf8Length(value) <= maximumBytes) return value;
  const ellipsis = "...";
  let result = "";
  for (const character of value) {
    if (utf8Length(result + character + ellipsis) > maximumBytes) break;
    result += character;
  }
  return result + ellipsis;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export async function apnsJwt(env: Required<Pick<ApnsEnv, "NIB_APNS_TEAM_ID" | "NIB_APNS_KEY_ID" | "NIB_APNS_PRIVATE_KEY">>): Promise<string> {
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: env.NIB_APNS_KEY_ID })));
  const claims = base64Url(new TextEncoder().encode(JSON.stringify({ iss: env.NIB_APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) })));
  const input = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBytes(env.NIB_APNS_PRIVATE_KEY),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(input)
  ));
  return `${input}.${base64Url(joseSignature(signature))}`;
}


export function apnsCategory(payload: ApnsPayload): string {
  if (payload.type === "visual-review") return "NIB_APPROVE_REJECT";
  if (Array.isArray(payload.choices) && payload.choices.length) return apnsChoiceCategory(payload.choices);
  if (payload.allowText) return "NIB_TEXT";
  return "NIB_OPEN";
}

export async function apnsCollapseId(payload: ApnsPayload): Promise<string> {
  const value = String(payload.tag || payload.requestId || "nib");
  if (new TextEncoder().encode(value).byteLength <= 64) return value;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function apnsChoiceCategory(choices: unknown[]): string {
  const normalized = choices.map((choice) => String(choice).trim().toLowerCase().replace(/[^\p{Letter}\p{Number}\s]/gu, "").replace(/\s+/g, " "));
  const [first = "", second = "", third = ""] = normalized;
  if (first === "approve" && second === "hold") return "NIB_APPROVE_HOLD";
  if (first === "approve" && second === "reject") return "NIB_APPROVE_REJECT";
  if (first === "allow" && second === "deny") return "NIB_ALLOW_DENY";
  if (first === "yes" && second === "no") return "NIB_YES_NO";
  if (first === "ship" && second === "hold" && third === "revise") return "NIB_SHIP_HOLD_REVISE";
  if (first === "ship" && second === "hold") return "NIB_SHIP_HOLD";
  if ((first === "use" || first === "use it") && second === "revise") return "NIB_USE_REVISE";
  return "NIB_CHOICE";
}

function pemBytes(pem: string): ArrayBuffer {
  const encoded = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function joseSignature(signature: Uint8Array): Uint8Array {
  if (signature.byteLength === 64) return signature;
  let offset = 0;
  if (signature[offset++] !== 0x30) throw new Error("Invalid ECDSA signature");
  offset = skipLength(signature, offset);
  if (signature[offset++] !== 0x02) throw new Error("Invalid ECDSA signature");
  const rLength = readLength(signature, offset); offset = rLength.offset;
  const r = signature.slice(offset, offset + rLength.length); offset += rLength.length;
  if (signature[offset++] !== 0x02) throw new Error("Invalid ECDSA signature");
  const sLength = readLength(signature, offset); offset = sLength.offset;
  const s = signature.slice(offset, offset + sLength.length);
  const result = new Uint8Array(64);
  result.set(trimInteger(r).slice(-32), 32 - Math.min(32, trimInteger(r).length));
  result.set(trimInteger(s).slice(-32), 64 - Math.min(32, trimInteger(s).length));
  return result;
}

function skipLength(bytes: Uint8Array, offset: number): number {
  return readLength(bytes, offset).offset;
}

function readLength(bytes: Uint8Array, offset: number): { length: number; offset: number } {
  const first = bytes[offset++];
  if (first < 0x80) return { length: first, offset };
  const count = first & 0x7f;
  let length = 0;
  for (let index = 0; index < count; index += 1) length = (length << 8) | bytes[offset++];
  return { length, offset };
}

function trimInteger(value: Uint8Array): Uint8Array {
  let offset = 0;
  while (offset < value.length - 1 && value[offset] === 0) offset += 1;
  return value.slice(offset);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
