import http from "node:http";
import https from "node:https";

export interface ProbeResult {
  statusCode: number | null;
  contentType: string | null;
  ok: boolean;
}

export function requestBuffer(url: URL, timeoutMs = 3000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      url,
      {
        method: "GET",
        timeout: timeoutMs,
        headers: {
          "User-Agent": "nib/0.1"
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`Request timed out for ${url.href}`)));
    req.end();
  });
}

export function probeHttp(url: URL, timeoutMs = 1500): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      url,
      {
        method: "GET",
        timeout: timeoutMs,
        headers: {
          Accept: "text/html,*/*;q=0.8",
          "User-Agent": "nib/0.1"
        }
      },
      (res) => {
        res.resume();
        resolve({
          statusCode: res.statusCode ?? null,
          contentType: normalizeHeader(res.headers["content-type"]),
          ok: Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 500)
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ statusCode: null, contentType: null, ok: false });
    });
    req.on("error", () => resolve({ statusCode: null, contentType: null, ok: false }));
    req.end();
  });
}

function normalizeHeader(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}
