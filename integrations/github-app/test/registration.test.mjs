import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import { createRegistrationServer, createRegistrationSession, exchangeManifestCode, handleCallback } from "../src/registration.mjs";

const manifest = {
  name: "Nib Acceptance",
  url: "https://nibtool.com",
  hook_attributes: {
    url: "https://nibtool.com/api/acceptance/v1/github/webhook",
    active: true,
  },
  public: true,
  request_oauth_on_install: false,
  default_permissions: {
    checks: "write",
    metadata: "read",
    pull_requests: "read",
  },
  default_events: ["pull_request"],
};

test("session adds a loopback redirect URL and unguessable state without changing permissions", () => {
  const session = createRegistrationSession({
    manifest,
    origin: "http://127.0.0.1:49152",
    githubNewAppUrl: "https://github.com/settings/apps/new",
    state: "known-state",
  });
  assert.equal(session.callbackUrl, "http://127.0.0.1:49152/callback");
  assert.equal(session.registrationUrl, "https://github.com/settings/apps/new?state=known-state");
  assert.equal(session.manifest.redirect_url, "http://127.0.0.1:49152/callback");
  assert.deepEqual(session.manifest.default_permissions, manifest.default_permissions);
  assert.deepEqual(session.manifest.default_events, ["pull_request"]);
});

test("review page renders a manual GitHub manifest form", async () => {
  const registration = await createRegistrationServer({
    manifest,
    runtimeDir: await mkdtemp(path.join(tmpdir(), "nib-github-app-")),
    state: "review-state",
    exchangeManifestCode: neverExchange,
  });
  try {
    const response = await fetch(registration.reviewUrl);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(body, /method="post"/);
    assert.match(body, /https:\/\/github.com\/settings\/apps\/new\?state=review-state/);
    assert.match(body, /Create GitHub App on GitHub/);
    assert.match(body, /redirect_url/);
  } finally {
    await registration.close();
  }
});

test("server only binds to loopback hosts and rejects rebinding Host headers", async () => {
  await assert.rejects(
    createRegistrationServer({
      manifest,
      runtimeDir: await mkdtemp(path.join(tmpdir(), "nib-github-app-")),
      host: "0.0.0.0",
      exchangeManifestCode: neverExchange,
    }),
    /--host must be a loopback/,
  );
  await assert.rejects(
    createRegistrationServer({
      manifest,
      runtimeDir: await mkdtemp(path.join(tmpdir(), "nib-github-app-")),
      host: "127.999.999.999",
      exchangeManifestCode: neverExchange,
    }),
    /--host must be a loopback/,
  );

  const registration = await createRegistrationServer({
    manifest,
    runtimeDir: await mkdtemp(path.join(tmpdir(), "nib-github-app-")),
    state: "host-state",
    exchangeManifestCode: neverExchange,
  });
  try {
    const response = await httpGetWithHost(registration.reviewUrl, "attacker.test");
    assert.equal(response.status, 421);
    assert.equal(response.headers["referrer-policy"], "no-referrer");
    assert.match(response.body, /Unexpected Host header/);
  } finally {
    await registration.close();
  }
});

test("invalid callbacks are rejected before conversion", async () => {
  let exchanges = 0;
  const registration = await createRegistrationServer({
    manifest,
    runtimeDir: await mkdtemp(path.join(tmpdir(), "nib-github-app-")),
    state: "expected-state",
    exchangeManifestCode: async () => {
      exchanges += 1;
      return fakeApp();
    },
  });
  try {
    const badState = await fetch(`${registration.callbackUrl}?code=abc123&state=wrong-state`);
    assert.equal(badState.status, 400);
    assert.match(await badState.text(), /Invalid callback state/);
    const badCode = await fetch(`${registration.callbackUrl}?code=abc.123&state=expected-state`);
    assert.equal(badCode.status, 400);
    assert.match(await badCode.text(), /Invalid or missing GitHub manifest code/);
    assert.equal(exchanges, 0);
  } finally {
    await registration.close();
  }
});

test("callback conversion is claimed once and later callback replay is idempotent", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nib-github-app-"));
  const calls = [];
  let releaseExchange;
  const exchangeReady = new Promise((resolve) => {
    releaseExchange = resolve;
  });
  const registration = await createRegistrationServer({
    manifest,
    runtimeDir,
    state: "expected-state",
    exchangeManifestCode: async (code) => {
      calls.push(code);
      await exchangeReady;
      return fakeApp();
    },
  });
  try {
    const first = fetch(`${registration.callbackUrl}?code=abc123&state=expected-state`);
    await waitFor(() => calls.length === 1);

    const concurrent = await fetch(`${registration.callbackUrl}?code=abc123&state=expected-state`);
    assert.equal(concurrent.status, 409);
    assert.match(await concurrent.text(), /already in progress/);
    assert.equal(calls.length, 1);

    releaseExchange();
    const firstResponse = await first;
    assert.equal(firstResponse.status, 200);
    assert.match(await firstResponse.text(), /App ID: <code>12345<\/code>/);

    const replay = await fetch(`${registration.callbackUrl}?code=abc123&state=expected-state`);
    assert.equal(replay.status, 200);
    assert.match(await replay.text(), /App ID: <code>12345<\/code>/);
    assert.equal(calls.length, 1);
    assert.equal((await readdir(runtimeDir)).length, 1);

    const invalidReplay = await fetch(`${registration.callbackUrl}?code=abc123&state=wrong-state`);
    assert.equal(invalidReplay.status, 400);
    assert.equal(calls.length, 1);
  } finally {
    await registration.close();
  }
});

test("valid callback exchanges once and writes private runtime credentials without browser leakage", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nib-github-app-"));
  const calls = [];
  const registration = await createRegistrationServer({
    manifest,
    runtimeDir,
    state: "expected-state",
    exchangeManifestCode: async (code) => {
      calls.push(code);
      return fakeApp();
    },
  });
  try {
    const response = await fetch(`${registration.callbackUrl}?code=abc_123-Z&state=expected-state`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ["abc_123-Z"]);
    assert.match(body, /App ID: <code>12345<\/code>/);
    assert.match(body, /https:\/\/github.com\/apps\/nib-acceptance/);
    assert.doesNotMatch(body, /BEGIN RSA PRIVATE KEY/);
    assert.doesNotMatch(body, /webhook-secret/);

    const credentialsPath = body.match(/Credential file: <code>([^<]+)<\/code>/)[1];
    assert.equal(path.dirname(credentialsPath), runtimeDir);
    const mode = (await stat(credentialsPath)).mode & 0o777;
    assert.equal(mode, 0o600);
    const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
    assert.equal(credentials.env.GITHUB_APP_ID, "12345");
    assert.equal(credentials.env.GITHUB_WEBHOOK_SECRET, "webhook-secret");
    assert.match(credentials.env.GITHUB_APP_PRIVATE_KEY, /BEGIN RSA PRIVATE KEY/);
  } finally {
    await registration.close();
  }
});

test("default callback exchange path does not self-reference its parameter", async () => {
  const callbackUrl = new URL("http://127.0.0.1:49152/callback?code=abc123&state=expected-state");
  const session = createRegistrationSession({
    manifest,
    origin: "http://127.0.0.1:49152",
    githubNewAppUrl: "https://github.com/settings/apps/new",
    state: "expected-state",
  });
  const result = await handleCallback({
    callbackUrl,
    session,
    runtimeDir: await mkdtemp(path.join(tmpdir(), "nib-github-app-")),
    githubApiUrl: "https://api.github.test",
    fetchImpl: async () => new Response(JSON.stringify(fakeApp()), { status: 201, headers: { "Content-Type": "application/json" } }),
  });
  assert.equal(result.appId, "12345");
});

test("manifest exchange uses GitHub's conversion endpoint without logging secret response bodies", async () => {
  const requests = [];
  const app = fakeApp();
  const result = await exchangeManifestCode("code-123", {
    githubApiUrl: "https://api.github.test",
    githubApiVersion: "2022-11-28",
    userAgent: "nib-test",
    fetchImpl: async (url, init) => {
      requests.push({ url: url.toString(), init });
      return new Response(JSON.stringify(app), { status: 201, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(result.id, 12345);
  assert.deepEqual(requests, [{
    url: "https://api.github.test/app-manifests/code-123/conversions",
    init: {
      method: "POST",
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": "nib-test",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  }]);
});

async function neverExchange() {
  throw new Error("exchange should not run");
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for predicate");
}

async function httpGetWithHost(url, host) {
  const parsed = new URL(url);
  return await new Promise((resolve, reject) => {
    const request = http.request({
      method: "GET",
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      headers: { Host: host },
    }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({ status: response.statusCode, headers: response.headers, body });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function fakeApp() {
  return {
    id: 12345,
    slug: "nib-acceptance",
    html_url: "https://github.com/apps/nib-acceptance",
    webhook_secret: "webhook-secret",
    pem: "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----\n",
  };
}
