#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const LOCAL_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const ROUTE_PROBE_REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function classifyReviewPage(html) {
  if (/id=["']response-form["']/.test(html) && /data-decision=["']approve["']/.test(html)) {
    return "response-interface";
  }
  if (/Open this review in Nib|Open this request in the installed Nib app/.test(html)) {
    return "legacy-launcher";
  }
  return "unknown";
}

export function inspectControls(html) {
  return {
    approve: /data-decision=["']approve["']/.test(html),
    reject: /data-decision=["']reject["']/.test(html),
    comment: /data-decision=["']comment["']/.test(html),
    liveStatus: /aria-live=["']polite["']/.test(html)
  };
}

export function nativeRequestId(html) {
  const match = html.match(/href=["']nib:\/\/request\/([^"'?#]+)["']/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function reviewExpectation(hasReviewUrl) {
  return hasReviewUrl
    ? { dataStatuses: [200], attachmentRequired: true }
    : { dataStatuses: [404], attachmentRequired: false };
}

export function healthPath(name) {
  return name === "local" ? "/api/health" : "/health";
}

export function tabulate(rows) {
  const headings = ["INTERFACE", "LOCAL", "PRODUCTION"];
  const widths = headings.map((heading, index) => Math.max(
    heading.length,
    ...rows.map((row) => String(row[index] ?? "").length)
  ));
  const line = (cells) => cells
    .map((cell, index) => String(cell ?? "").padEnd(widths[index]))
    .join("  ")
    .trimEnd();
  return [line(headings), ...rows.map(line)].join("\n");
}

function parseArgs(argv) {
  const options = {
    localBase: process.env.NIB_REVIEW_LOCAL_BASE || "http://127.0.0.1:8791",
    prodBase: process.env.NIB_REVIEW_PROD_BASE || "https://nibtool.com",
    prodUrl: process.env.NIB_REVIEW_PROD_URL || "",
    json: false,
    allowProdDrift: false,
    noLocalResponse: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--local-base") options.localBase = requiredValue(argv, ++index, argument);
    else if (argument === "--prod-base") options.prodBase = requiredValue(argv, ++index, argument);
    else if (argument === "--prod-url") options.prodUrl = requiredValue(argv, ++index, argument);
    else if (argument === "--json") options.json = true;
    else if (argument === "--allow-prod-drift") options.allowProdDrift = true;
    else if (argument === "--no-local-response") options.noLocalResponse = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function usage() {
  return `Usage: review-interface-smoke [options]

Options:
  --local-base URL       Running local Worker (default: http://127.0.0.1:8791)
  --prod-base URL        Production origin (default: https://nibtool.com)
  --prod-url URL         Existing production capability URL for a full read-only probe
  --allow-prod-drift     Report production differences without a nonzero exit
  --no-local-response    Leave the local fixture unanswered for manual testing
  --json                 Print the complete machine-readable result
  -h, --help             Show this help

The command creates and answers one local fixture. It never writes to production.`;
}

export function normalizedBase(raw, local) {
  const url = new URL(raw);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (local && !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error(`Refusing to seed a non-local origin: ${url.origin}`);
  }
  if (!local && url.protocol !== "https:") {
    throw new Error(`Production origin must use HTTPS: ${url.origin}`);
  }
  return url.origin + pathname;
}

function normalizedReviewUrl(raw, prodBase) {
  const url = new URL(raw);
  if (url.origin !== new URL(prodBase).origin) {
    throw new Error(`Production review URL must use ${new URL(prodBase).origin}`);
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "r" || !UUID.test(parts[1]) || !UUID.test(parts[2])) {
    throw new Error("Production review URL must be /r/:accountId/:requestId");
  }
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

async function request(url, init = {}) {
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      ...init
    });
    const text = await response.text();
    const contentType = (response.headers.get("content-type") || "").split(";")[0];
    let json = null;
    if (contentType === "application/json") {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: response.status, contentType, text, json, error: null };
  } catch (error) {
    return {
      status: 0,
      contentType: "",
      text: "",
      json: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function expectJson(url, init, expectedStatus) {
  const result = await request(url, init);
  if (result.status !== expectedStatus || !result.json) {
    const detail = result.error || result.text.slice(0, 300) || result.contentType || "empty response";
    throw new Error(`${init.method || "GET"} ${url} returned ${result.status}: ${detail}`);
  }
  return result.json;
}

async function seedLocalReview(localBase) {
  const headers = {
    "content-type": "application/json",
    "x-nib-account-id": LOCAL_ACCOUNT_ID
  };
  const created = await expectJson(`${localBase}/api/requests`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "visual-review",
      title: "Local and production interface smoke",
      prompt: "Verify the same review interface in every environment.",
      source: "review-interface-smoke",
      metadata: { contract: "nib.visual-review/v1" },
      notify: false
    })
  }, 201);

  const bytes = await readFile(new URL("../../../tests/fixtures/tiny.png", import.meta.url));
  const contentBase64 = bytes.toString("base64");
  const attachmentUrl = `${localBase}/api/requests/${created.id}/attachments`;
  await expectJson(attachmentUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "preview.png",
      contentType: "image/png",
      contentBase64,
      metadata: { role: "preview" }
    })
  }, 201);
  await expectJson(attachmentUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "review.nib",
      contentType: "application/x-nib",
      contentBase64,
      metadata: { role: "canonical" }
    })
  }, 201);

  const published = await expectJson(`${localBase}/api/requests/${created.id}/publish`, {
    method: "POST",
    headers
  }, 200);
  const reviewUrl = published.metadata?.reviewUrl;
  if (typeof reviewUrl !== "string" || !reviewUrl) {
    throw new Error("Local publish did not return metadata.reviewUrl");
  }
  return { id: created.id, reviewUrl };
}

async function probeEnvironment(name, base, reviewUrl) {
  const requestId = new URL(reviewUrl).pathname.split("/").filter(Boolean)[2];
  const legacyUrl = `${base}/r/${encodeURIComponent(requestId)}`;
  const [health, page, legacy, data] = await Promise.all([
    request(`${base}${healthPath(name)}`),
    request(reviewUrl),
    request(legacyUrl),
    request(`${reviewUrl}/data`, { headers: { accept: "application/json" } })
  ]);
  const attachmentPath = data.json?.attachment?.url;
  const attachment = typeof attachmentPath === "string"
    ? await request(new URL(attachmentPath, reviewUrl).href)
    : null;
  return {
    name,
    base,
    reviewUrl,
    requestId,
    health,
    page: {
      ...page,
      classification: classifyReviewPage(page.text),
      controls: inspectControls(page.text),
      nativeRequestId: nativeRequestId(page.text)
    },
    legacy: {
      ...legacy,
      url: legacyUrl,
      classification: classifyReviewPage(legacy.text),
      nativeRequestId: nativeRequestId(legacy.text)
    },
    data,
    attachment
  };
}

async function answerLocalReview(reviewUrl) {
  return request(`${reviewUrl}/respond`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `review-interface-smoke-${crypto.randomUUID()}`
    },
    body: JSON.stringify({
      decision: "comment",
      comment: "Local interface smoke response"
    })
  });
}

function cell(result, detail = "") {
  if (!result) return "not applicable";
  if (result.error) return `error ${result.error}`;
  return `${result.status}${detail ? ` ${detail}` : ""}`;
}

function controlCell(controls) {
  const found = Object.entries(controls).filter(([, present]) => present).map(([name]) => name);
  return found.length === 4 ? "approve reject comment live" : `missing ${4 - found.length}/4`;
}

function nativeCell(probe) {
  return probe.page.nativeRequestId === null && probe.legacy.nativeRequestId === null
    ? "web only"
    : "native handoff found";
}

function summarizeResponse(response) {
  if (!response) return null;
  return {
    status: response.status,
    contentType: response.contentType,
    error: response.error
  };
}

export function summarizeProbe(probe) {
  return {
    name: probe.name,
    base: probe.base,
    reviewUrl: probe.reviewUrl,
    requestId: probe.requestId,
    health: summarizeResponse(probe.health),
    page: {
      ...summarizeResponse(probe.page),
      classification: probe.page.classification,
      controls: probe.page.controls,
      nativeRequestId: probe.page.nativeRequestId
    },
    legacy: probe.legacy ? {
      ...summarizeResponse(probe.legacy),
      url: probe.legacy.url,
      classification: probe.legacy.classification,
      nativeRequestId: probe.legacy.nativeRequestId
    } : null,
    data: {
      ...summarizeResponse(probe.data),
      hasReview: typeof probe.data.json?.id === "string",
      hasAttachment: Boolean(probe.data.json?.attachment)
    },
    attachment: summarizeResponse(probe.attachment)
  };
}

function evaluateProbe(probe, expectation, response) {
  const failures = [];
  if (probe.health.status !== 200) failures.push(`health returned ${probe.health.status || probe.health.error}`);
  if (probe.page.status !== 200) failures.push(`page returned ${probe.page.status || probe.page.error}`);
  if (probe.page.classification !== "response-interface") {
    failures.push(`page is ${probe.page.classification}`);
  }
  if (!Object.values(probe.page.controls).every(Boolean)) failures.push("response controls are incomplete");
  if (probe.page.nativeRequestId !== null) failures.push("page still exposes a native-app handoff");
  if (![302, 404].includes(probe.legacy.status) || probe.legacy.classification === "legacy-launcher") {
    failures.push(`legacy route is ${probe.legacy.status} ${probe.legacy.classification}`);
  }
  if (probe.legacy.nativeRequestId !== null) failures.push("legacy route still exposes a native-app handoff");
  if (!expectation.dataStatuses.includes(probe.data.status) || probe.data.contentType !== "application/json") {
    failures.push(`data returned ${probe.data.status} ${probe.data.contentType || "without content type"}`);
  }
  if (expectation.attachmentRequired && probe.attachment?.status !== 200) {
    failures.push(`attachment returned ${probe.attachment?.status || "no response"}`);
  }
  if (response && (response.status !== 200 || response.json?.response?.decision !== "comment")) {
    failures.push(`response returned ${response.status || response.error}`);
  }
  return { passed: failures.length === 0, failures };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    options.localBase = normalizedBase(options.localBase, true);
    options.prodBase = normalizedBase(options.prodBase, false);
    if (options.prodUrl) options.prodUrl = normalizedReviewUrl(options.prodUrl, options.prodBase);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 64;
    return;
  }

  try {
    const fixture = await seedLocalReview(options.localBase);
    const prodReviewUrl = options.prodUrl || `${options.prodBase}/r/${LOCAL_ACCOUNT_ID}/${ROUTE_PROBE_REQUEST_ID}`;
    const [local, production] = await Promise.all([
      probeEnvironment("local", options.localBase, fixture.reviewUrl),
      probeEnvironment("production", options.prodBase, prodReviewUrl)
    ]);
    const localResponse = options.noLocalResponse ? null : await answerLocalReview(fixture.reviewUrl);
    const localVerdict = evaluateProbe(
      local,
      { dataStatuses: [200], attachmentRequired: true },
      localResponse
    );
    const productionVerdict = evaluateProbe(production, reviewExpectation(Boolean(options.prodUrl)), null);
    const rows = [
      ["health", cell(local.health, local.health.contentType), cell(production.health, production.health.contentType)],
      ["page", cell(local.page, local.page.classification), cell(production.page, production.page.classification)],
      ["controls", controlCell(local.page.controls), controlCell(production.page.controls)],
      ["legacy", cell(local.legacy, local.legacy.classification), cell(production.legacy, production.legacy.classification)],
      ["native", nativeCell(local), nativeCell(production)],
      ["data", cell(local.data, local.data.contentType), cell(production.data, production.data.contentType)],
      ["attachment", cell(local.attachment, local.attachment?.contentType), cell(production.attachment, production.attachment?.contentType)],
      [
        "response",
        localResponse ? cell(localResponse, localResponse.json?.response?.decision || "") : "manual",
        "read-only"
      ]
    ];
    const result = {
      local: {
        ...summarizeProbe(local),
        response: summarizeResponse(localResponse),
        verdict: localVerdict
      },
      production: {
        ...summarizeProbe(production),
        verdict: productionVerdict,
        routeOnly: !options.prodUrl
      },
      productionWrites: false
    };

    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(tabulate(rows));
      console.log(`\nLOCAL URL       ${fixture.reviewUrl}`);
      console.log(`PRODUCTION URL  ${prodReviewUrl}${options.prodUrl ? "" : " (route-only probe)"}`);
      console.log(`LOCAL VERDICT   ${localVerdict.passed ? "PASS" : `FAIL: ${localVerdict.failures.join("; ")}`}`);
      console.log(`PROD VERDICT    ${productionVerdict.passed ? "PASS" : `DRIFT: ${productionVerdict.failures.join("; ")}`}`);
      console.log("PROD WRITES     none");
    }

    if (!localVerdict.passed) process.exitCode = 1;
    else if (!productionVerdict.passed && !options.allowProdDrift) process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
