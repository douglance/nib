import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const callbackPath = "/callback";
const maxCodeLength = 256;
const safeCodePattern = /^[A-Za-z0-9_-]+$/;
const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

export async function loadManifest(manifestPath) {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

export async function createRegistrationServer(options) {
  const host = options.host ?? "127.0.0.1";
  assertLoopbackHost(host);
  const server = buildRegistrationServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Registration server did not bind to a TCP address");
  }

  const origin = `http://${formatHostForOrigin(address.address)}:${address.port}`;
  const session = createRegistrationSession({
    manifest: options.manifest,
    origin,
    githubNewAppUrl: options.githubNewAppUrl ?? "https://github.com/settings/apps/new",
    state: options.state,
  });
  server.session = session;

  return {
    server,
    reviewUrl: `${origin}/`,
    callbackUrl: session.callbackUrl,
    registrationUrl: session.registrationUrl,
    state: session.state,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    closed: new Promise((resolve) => server.once("close", resolve)),
  };
}

export function buildRegistrationServer(options) {
  const callback = { status: "idle", result: null };
  const server = http.createServer(async (request, response) => {
    try {
      const session = server.session;
      if (!session) {
        sendText(response, 503, "Registration session is not ready.");
        return;
      }
      if (!isExpectedHost(request.headers.host, session.originHost)) {
        sendText(response, 421, "Unexpected Host header.");
        return;
      }

      const url = new URL(request.url ?? "/", session.reviewUrl);
      if (request.method === "GET" && url.pathname === "/") {
        sendHtml(response, renderReviewPage(session, callback.status === "completed"));
      } else if (request.method === "GET" && url.pathname === "/manifest.json") {
        sendJson(response, 200, session.manifest);
      } else if (request.method === "GET" && url.pathname === callbackPath) {
        validateCallbackUrl(url, session);
        if (callback.status === "completed") {
          sendHtml(response, renderCompletionPage(callback.result));
          return;
        }
        if (callback.status === "claimed") {
          sendText(response, 409, "GitHub App registration callback is already in progress.");
          return;
        }
        callback.status = "claimed";
        let result;
        try {
          result = await handleCallback({
            callbackUrl: url,
            session,
            runtimeDir: options.runtimeDir,
            exchangeManifestCode: options.exchangeManifestCode ?? exchangeManifestCode,
            githubApiUrl: options.githubApiUrl ?? "https://api.github.com",
            githubApiVersion: options.githubApiVersion ?? "2022-11-28",
            userAgent: options.userAgent ?? "nib-github-app-manifest-registration",
            fetchImpl: options.fetchImpl ?? fetch,
          });
        } catch (error) {
          callback.status = "idle";
          throw error;
        }
        callback.status = "completed";
        callback.result = result;
        options.onComplete?.(result);
        sendHtml(response, renderCompletionPage(result));
      } else if (request.method === "GET" && url.pathname === "/status") {
        sendJson(response, 200, {
          ready: true,
          completed: callback.status === "completed",
          callbackUrl: session.callbackUrl,
        });
      } else {
        sendText(response, 404, "Not found.");
      }
    } catch (error) {
      const status = error instanceof CallbackError ? error.status : 500;
      sendText(response, status, error.safeMessage ?? "GitHub App registration failed.");
    }
  });
  return server;
}

export function createRegistrationSession({ manifest, origin, githubNewAppUrl, state = randomState() }) {
  const callbackUrl = `${origin}${callbackPath}`;
  const originHost = new URL(origin).host;
  const registrationManifest = {
    ...manifest,
    redirect_url: callbackUrl,
  };
  const registrationUrl = new URL(githubNewAppUrl);
  registrationUrl.searchParams.set("state", state);
  return {
    state,
    callbackUrl,
    reviewUrl: `${origin}/`,
    registrationUrl: registrationUrl.toString(),
    originHost,
    manifest: registrationManifest,
    manifestText: JSON.stringify(registrationManifest),
    manifestHash: sha256Hex(JSON.stringify(registrationManifest)),
  };
}

export async function handleCallback({
  callbackUrl,
  session,
  runtimeDir,
  exchangeManifestCode: exchange = exchangeManifestCode,
  githubApiUrl = "https://api.github.com",
  githubApiVersion = "2022-11-28",
  userAgent = "nib-github-app-manifest-registration",
  fetchImpl = fetch,
}) {
  const code = validateCallbackUrl(callbackUrl, session);

  const app = await exchange(code, { githubApiUrl, githubApiVersion, userAgent, fetchImpl });
  const credentialsPath = await writeRuntimeCredentials(runtimeDir, {
    app,
    manifestHash: session.manifestHash,
  });
  return {
    appId: String(app.id),
    appUrl: app.html_url || `https://github.com/apps/${app.slug}`,
    appSlug: app.slug,
    credentialsPath,
  };
}

export async function exchangeManifestCode(code, {
  githubApiUrl = "https://api.github.com",
  githubApiVersion = "2022-11-28",
  userAgent = "nib-github-app-manifest-registration",
  fetchImpl = fetch,
} = {}) {
  const url = new URL(`/app-manifests/${encodeURIComponent(code)}/conversions`, githubApiUrl);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": userAgent,
      "X-GitHub-Api-Version": githubApiVersion,
    },
  });
  if (response.status !== 201) {
    throw new CallbackError(response.status === 404 || response.status === 422 ? response.status : 502, "GitHub manifest conversion failed.");
  }
  const body = await response.json();
  if (!body?.id || !body?.pem || !body?.webhook_secret) {
    throw new CallbackError(502, "GitHub manifest conversion response was missing required credentials.");
  }
  return body;
}

export async function writeRuntimeCredentials(runtimeDir, { app, manifestHash }) {
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const idPart = String(app.id).replace(/[^0-9]/g, "") || "app";
  const filePath = path.join(runtimeDir, `nib-github-app-${idPart}-${Date.now()}-${randomBytes(4).toString("hex")}.json`);
  const file = await open(filePath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify({
      contract: "nib.github-app-registration/v1",
      createdAt: new Date().toISOString(),
      manifestHash,
      app: {
        id: app.id,
        slug: app.slug,
        htmlUrl: app.html_url,
      },
      env: {
        GITHUB_APP_ID: String(app.id),
        GITHUB_WEBHOOK_SECRET: app.webhook_secret,
        GITHUB_APP_PRIVATE_KEY: app.pem,
      },
    }, null, 2)}\n`);
    await file.chmod(0o600);
  } finally {
    await file.close();
  }
  return filePath;
}

export function renderReviewPage(session, completed) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Register Nib Acceptance GitHub App</title>
  <style>
    body { max-width: 880px; margin: 40px auto; padding: 0 20px; font: 15px/1.5 system-ui, sans-serif; color: #111827; }
    h1 { font-size: 24px; margin: 0 0 8px; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { overflow: auto; background: #f3f4f6; border: 1px solid #d1d5db; border-radius: 6px; padding: 12px; }
    button { border: 1px solid #111827; border-radius: 6px; background: #111827; color: white; font: inherit; padding: 8px 12px; cursor: pointer; }
    .meta { color: #4b5563; }
  </style>
</head>
<body>
  <h1>Register Nib Acceptance</h1>
  <p class="meta">Review the manifest below. Submitting this form opens GitHub's App creation flow; nothing is submitted automatically.</p>
  <p><strong>Callback URL:</strong> <code>${escapeHtml(session.callbackUrl)}</code></p>
  <p><strong>Manifest SHA-256:</strong> <code>${escapeHtml(session.manifestHash)}</code></p>
  <form action="${escapeHtml(session.registrationUrl)}" method="post">
    <input type="hidden" name="manifest" value="${escapeHtml(session.manifestText)}">
    <button type="submit"${completed ? " disabled" : ""}>Create GitHub App on GitHub</button>
  </form>
  <pre>${escapeHtml(JSON.stringify(session.manifest, null, 2))}</pre>
</body>
</html>`;
}

export function renderCompletionPage(result) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GitHub App Registered</title></head>
<body>
  <h1>GitHub App registered</h1>
  <p>App ID: <code>${escapeHtml(result.appId)}</code></p>
  <p>App URL: <a href="${escapeHtml(result.appUrl)}">${escapeHtml(result.appUrl)}</a></p>
  <p>Credential file: <code>${escapeHtml(result.credentialsPath)}</code></p>
</body>
</html>`;
}

function randomState() {
  return randomBytes(32).toString("base64url");
}

function isValidCode(code) {
  return typeof code === "string" && code.length > 0 && code.length <= maxCodeLength && safeCodePattern.test(code);
}

function validateCallbackUrl(callbackUrl, session) {
  const code = callbackUrl.searchParams.get("code");
  const state = callbackUrl.searchParams.get("state");
  if (!state || state !== session.state) {
    throw new CallbackError(400, "Invalid callback state.");
  }
  if (!isValidCode(code)) {
    throw new CallbackError(400, "Invalid or missing GitHub manifest code.");
  }
  return code;
}

function assertLoopbackHost(host) {
  if (!isLoopbackHost(host)) {
    throw new Error("--host must be a loopback address or localhost");
  }
}

function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  const normalized = host === "[::1]" ? "::1" : host;
  if (normalized === "localhost") return true;
  if (net.isIP(normalized) === 6) return normalized === "::1";
  if (net.isIP(normalized) !== 4) return false;
  return normalized.split(".")[0] === "127";
}

function formatHostForOrigin(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function isExpectedHost(actual, expected) {
  return typeof actual === "string" && actual.toLowerCase() === expected.toLowerCase();
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sendHtml(response, body) {
  response.writeHead(200, { ...responseHeaders, "Content-Type": "text/html; charset=utf-8" });
  response.end(body);
}

function sendJson(response, status, body) {
  response.writeHead(status, { ...responseHeaders, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendText(response, status, body) {
  response.writeHead(status, { ...responseHeaders, "Content-Type": "text/plain; charset=utf-8" });
  response.end(body);
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

class CallbackError extends Error {
  constructor(status, safeMessage) {
    super(safeMessage);
    this.status = status;
    this.safeMessage = safeMessage;
  }
}
