import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { LiveCloudflareApi, verifyCloudflareManifest } from "../cloudflare/src/cloudflare-preview.mjs";

export async function run(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? sleepMs;
  const timeoutSignal = options.timeoutSignal ?? requestTimeoutSignal;
  const getInput = (name, required = false) => input(env, name, required);
  const mode = getInput("mode", true);
  const projectId = getInput("project-id", true);
  const apiOrigin = getInput("api-origin") || "https://nibtool.com";

  if (mode === "link") {
    const oidcToken = await githubOidcToken(env, fetchImpl, "nib.acceptance/v1");
    const setupToken = getInput("setup-token", true);
    const installationId = getInput("installation-id", true);
    const repositoryId = getInput("repository-id") || env.GITHUB_REPOSITORY_ID;
    const repository = getInput("repository") || env.GITHUB_REPOSITORY;
    if (!repositoryId) throw new Error("Link mode requires repository-id input or GITHUB_REPOSITORY_ID.");
    if (!repository) throw new Error("Link mode requires repository input or GITHUB_REPOSITORY.");
    const [owner, name] = splitRepository(repository);
    const allowedWorkflows = listInput(getInput("allowed-workflows")) || [requiredString(env.GITHUB_WORKFLOW_REF, "Link mode requires allowed-workflows input or GITHUB_WORKFLOW_REF.")];
    const gates = listInput(getInput("gates"));
    const response = await postJson(env, fetchImpl, mode, `${apiOrigin}/api/acceptance/v1/projects/${encodeURIComponent(projectId)}/integrations/github`, {
      installationId,
      repositoryId,
      owner,
      name,
      allowedWorkflows,
      gates,
      ownershipOidcToken: oidcToken,
    }, setupToken, oidcIdempotencySuffix(oidcToken), "PUT");
    writeOutput(env, "repository-id", response.installation?.repository?.id || repositoryId);
    writeOutput(env, "repository", `${response.installation?.repository?.owner || owner}/${response.installation?.repository?.name || name}`);
    writeOutput(env, "state", response.installation?.enabled === false ? "disabled" : "linked");
    return;
  }

  const exchangeWorkflowToken = async (requestSignal) => {
    const freshOidcToken = await githubOidcToken(env, fetchImpl, "nib.acceptance/v1", requestSignal);
    const exchanged = await postJson(env, fetchImpl, mode, `${apiOrigin}/api/acceptance/v1/github/token`, {
      oidcToken: freshOidcToken,
      projectId,
      mode,
    }, undefined, oidcIdempotencySuffix(freshOidcToken), undefined, requestSignal);
    return requiredString(exchanged.access_token, "OIDC exchange did not return access_token.");
  };

  if (mode === "publish") {
    const accessToken = await exchangeWorkflowToken();
    const manifestPath = getInput("manifest-path", true);
    const manifest = await readJson(manifestPath);
    const expectedManifestHash = manifestSha256(manifest);
    await verifyCloudflareManifestIfRequired(env, fetchImpl, getInput, manifest, options.cloudflareApi);
    const response = await postJson(env, fetchImpl, mode, `${apiOrigin}/api/acceptance/v1/projects/${encodeURIComponent(projectId)}/reviews`, {
      manifest,
    }, accessToken, `manifest:${expectedManifestHash}`);
    if (response.manifestHash !== expectedManifestHash) {
      throw new Error("Published manifest hash did not match the local manifest.");
    }
    writeOutput(env, "review-id", response.id);
    writeOutput(env, "review-url", response.reviewUrl || `${apiOrigin}/acceptance/projects/${projectId}/reviews/${response.id}`);
    writeOutput(env, "manifest-hash", response.manifestHash);
    writeOutput(env, "state", response.state);
    writeOutput(env, "satisfied", response.state === "approved" ? "true" : "false");
    writeOutput(env, "receipt", receiptOutput(response.receipt));
  } else if (mode === "verify") {
    const reviewId = getInput("review-id", true);
    const manifestHash = getInput("manifest-hash", true);
    const commit = getInput("commit") || env.GITHUB_SHA;
    if (!commit) throw new Error("Verify mode requires commit input or GITHUB_SHA.");
    const manifestPath = getInput("manifest-path", true);
    const manifest = await readJson(manifestPath);
    if (manifestSha256(manifest) !== manifestHash) {
      throw new Error("Expected manifest-hash does not match manifest-path.");
    }
    if (manifest?.build?.commit !== commit) {
      throw new Error("Expected commit does not match manifest build commit.");
    }
    const waitTimeoutMs = waitTimeoutSeconds(getInput("wait-timeout-seconds")) * 1000;
    const waitDeadline = waitTimeoutMs > 0 ? now() + waitTimeoutMs : null;
    let lastResponse = null;
    for (;;) {
      const remainingMs = waitDeadline === null ? null : waitDeadline - now();
      if (remainingMs !== null && remainingMs <= 0 && lastResponse?.state === "pending") {
        writeVerifyOutputs(env, apiOrigin, projectId, reviewId, manifestHash, lastResponse);
        throw new Error(`Acceptance gate is still pending after ${waitTimeoutMs / 1000} seconds.`);
      }
      const requestSignal = remainingMs === null ? undefined : timeoutSignal(Math.max(1, remainingMs));
      const accessToken = await exchangeWorkflowToken(requestSignal);
      const deploymentVerification = await verifyCloudflareManifestIfRequired(env, fetchImpl, getInput, manifest, options.cloudflareApi, requestSignal);
      const response = await postJson(
        env,
        fetchImpl,
        mode,
        `${apiOrigin}/api/acceptance/v1/projects/${encodeURIComponent(projectId)}/reviews/${encodeURIComponent(reviewId)}/verify`,
        { manifestHash, commit, ...(deploymentVerification ? { deploymentVerification } : {}) },
        accessToken,
        deploymentVerification?.verifiedAt,
        undefined,
        requestSignal,
      );
      lastResponse = response;
      if (response.manifestHash && response.manifestHash !== manifestHash) {
        throw new Error("Verify response manifest hash did not match the expected manifest-hash.");
      }
      if (response.satisfied && typeof response.receipt !== "string") {
        throw new Error("Satisfied acceptance verification did not include a receipt.");
      }
      if (response.satisfied || response.state !== "pending" || waitDeadline === null) {
        writeVerifyOutputs(env, apiOrigin, projectId, reviewId, manifestHash, response);
        if (!response.satisfied) {
          throw new Error(response.reason || `Acceptance gate is ${response.state || "not satisfied"}.`);
        }
        return;
      }
      const sleepForMs = Math.min(15_000, Math.max(0, waitDeadline - now()));
      if (sleepForMs <= 0) continue;
      await sleep(sleepForMs);
    }
  } else {
    throw new Error("mode must be link, publish, or verify.");
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function githubOidcToken(env, fetchImpl, audience, signal) {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error("GitHub OIDC is unavailable. Set workflow permissions: id-token: write.");
  }
  const url = new URL(requestUrl);
  url.searchParams.set("audience", audience);
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${requestToken}` },
    signal,
  });
  if (!response.ok) throw new Error(`GitHub OIDC request failed (${response.status}).`);
  const body = await response.json();
  return requiredString(body.value, "GitHub OIDC response did not include value.");
}

async function postJson(env, fetchImpl, mode, url, body, token, idempotencySuffix, method = "POST", signal) {
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    "idempotency-key": env.GITHUB_RUN_ID
      ? `${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}:${mode}:${url}${idempotencySuffix ? `:${idempotencySuffix}` : ""}`
      : `${Date.now()}:${mode}:${url}${idempotencySuffix ? `:${idempotencySuffix}` : ""}`,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetchImpl(url, {
    method,
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = json?.error?.message || json?.error || text || `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return json;
}

function writeVerifyOutputs(env, apiOrigin, projectId, reviewId, manifestHash, response) {
  writeOutput(env, "review-id", response.reviewId || reviewId);
  writeOutput(env, "review-url", `${apiOrigin}/acceptance/projects/${projectId}/reviews/${response.reviewId || reviewId}`);
  writeOutput(env, "manifest-hash", response.manifestHash || manifestHash);
  writeOutput(env, "state", response.state);
  writeOutput(env, "satisfied", response.satisfied ? "true" : "false");
  writeOutput(env, "receipt", receiptOutput(response.receipt));
}

function input(env, name, required = false) {
  const value = env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`]?.trim();
  if (!value && required) throw new Error(`Input ${name} is required.`);
  return value || "";
}

function writeOutput(env, name, value) {
  const output = env.GITHUB_OUTPUT;
  const normalized = value === undefined || value === null ? "" : String(value);
  if (!output) {
    console.log(`${name}=${name === "receipt" && normalized ? "[redacted]" : normalized}`);
    return;
  }
  appendFileSync(output, `${name}<<nib\n${normalized}\nnib\n`);
}

function requiredString(value, message) {
  if (typeof value !== "string" || !value) throw new Error(message);
  return value;
}

function splitRepository(repository) {
  const [owner, name] = repository.split("/");
  if (!owner || !name) throw new Error("GitHub repository must be formatted as owner/name.");
  return [owner, name];
}

function listInput(value) {
  const items = value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  return items.length ? Array.from(new Set(items)) : null;
}

async function verifyCloudflareManifestIfRequired(env, fetchImpl, getInput, manifest, injectedApi, signal) {
  if (manifest?.build?.provider !== "cloudflare") return null;
  const statePath = getInput("cloudflare-state-path", true);
  const state = await readJson(statePath);
  const providerFetch = signal ? fetchWithSignal(fetchImpl, signal) : fetchImpl;
  const api = injectedApi ?? new LiveCloudflareApi({
    accountId: getInput("cloudflare-account-id") || env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: getInput("cloudflare-api-token") || env.CLOUDFLARE_API_TOKEN,
    fetchImpl: providerFetch,
  });
  const verification = await verifyCloudflareManifest(api, manifest, state);
  if (!verification.satisfied) {
    throw new Error(`Cloudflare manifest verification failed: ${verification.reason || "not satisfied"}`);
  }
  return {
    manifestHash: manifestSha256(manifest),
    commit: manifest.build.commit,
    verifiedAt: new Date().toISOString(),
  };
}

function receiptOutput(receipt) {
  if (receipt === undefined || receipt === null) return "";
  if (typeof receipt !== "string") throw new Error("Acceptance receipt must be a compact JWS string.");
  return receipt;
}

function oidcIdempotencySuffix(oidcToken) {
  return `oidc:${createHash("sha256").update(oidcToken).digest("hex").slice(0, 16)}`;
}

function waitTimeoutSeconds(value) {
  if (!value) return 0;
  if (!/^\d+$/.test(value)) throw new Error("Input wait-timeout-seconds must be a non-negative integer.");
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) {
    throw new Error("Input wait-timeout-seconds must be a non-negative safe integer.");
  }
  return seconds;
}

function requestTimeoutSignal(ms) {
  const timeoutMs = Math.ceil(ms);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Request timeout must be a positive safe integer.");
  }
  if (typeof globalThis.AbortSignal?.timeout === "function") return globalThis.AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchWithSignal(fetchImpl, signal) {
  return (input, init = {}) => fetchImpl(input, { ...init, signal: combineSignals(signal, init.signal) });
}

function combineSignals(primary, secondary) {
  if (!secondary) return primary;
  if (typeof globalThis.AbortSignal?.any === "function") return globalThis.AbortSignal.any([primary, secondary]);
  if (primary.aborted) return primary;
  if (secondary.aborted) return secondary;
  return primary;
}

export function manifestSha256(manifest) {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
