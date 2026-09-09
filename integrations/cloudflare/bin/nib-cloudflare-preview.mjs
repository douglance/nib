#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  deployCloudflarePreview,
  invalidateAcceptanceReview,
  loadPreviewRecipe,
  publishAcceptanceManifest,
  teardownCloudflarePreview,
  verifyAcceptanceGateFromManifest,
  verifyCloudflareManifest,
  LiveCloudflareApi,
} from "../src/cloudflare-preview.mjs";

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "plan";

try {
  if (command === "plan") {
    const recipe = await loadPreviewRecipe(required(args.recipe, "--recipe"));
    const result = await deployCloudflarePreview(recipe, { dryRun: true, root: process.cwd(), stateDir: args["state-dir"] });
    await writeJson(args.out, result.plan);
    printJson(result.plan);
  } else if (command === "deploy") {
    const recipe = await loadPreviewRecipe(required(args.recipe, "--recipe"));
    const result = await deployCloudflarePreview(recipe, {
      dryRun: false,
      allowLive: args["allow-live"] === true,
      root: process.cwd(),
      stateDir: args["state-dir"],
    });
    await writeJson(args.out, result.manifest);
    await writeJson(args["state-out"], result.state);
    printJson({ manifest: result.manifest, state: result.state, verification: result.verification });
  } else if (command === "publish") {
    const manifest = await readJson(required(args.manifest, "--manifest"));
    const response = await publishAcceptanceManifest({
      acceptanceUrl: required(args["acceptance-url"], "--acceptance-url"),
      token: tokenFromArgs(args),
      manifest,
      idempotencyKey: args["idempotency-key"],
    });
    printJson(response);
  } else if (command === "verify-cloudflare") {
    const manifest = await readJson(required(args.manifest, "--manifest"));
    const state = await readJson(required(args.state, "--state"));
    const api = new LiveCloudflareApi({
      accountId: process.env[args["account-id-env"] ?? "CLOUDFLARE_ACCOUNT_ID"],
      apiToken: process.env[args["api-token-env"] ?? "CLOUDFLARE_API_TOKEN"],
      wranglerPackage: path.resolve(process.cwd(), args["wrangler-package"] ?? "apps/web"),
    });
    printJson(await verifyCloudflareManifest(api, manifest, state));
  } else if (command === "verify-acceptance") {
    const manifest = await readJson(required(args.manifest, "--manifest"));
    const state = await readJson(required(args.state, "--state"));
    const api = new LiveCloudflareApi({
      accountId: process.env[args["account-id-env"] ?? "CLOUDFLARE_ACCOUNT_ID"],
      apiToken: process.env[args["api-token-env"] ?? "CLOUDFLARE_API_TOKEN"],
      wranglerPackage: path.resolve(process.cwd(), args["wrangler-package"] ?? "apps/web"),
    });
    const response = await verifyAcceptanceGateFromManifest({
      acceptanceUrl: required(args["acceptance-url"], "--acceptance-url"),
      token: tokenFromArgs(args),
      manifest,
      reviewId: required(args["review-id"], "--review-id"),
      api,
      localState: state,
    });
    printJson(response);
  } else if (command === "invalidate") {
    const response = await invalidateAcceptanceReview({
      acceptanceUrl: required(args["acceptance-url"], "--acceptance-url"),
      token: tokenFromArgs(args),
      projectId: required(args["project-id"], "--project-id"),
      reviewId: required(args["review-id"], "--review-id"),
      reason: args.reason ?? "Cloudflare preview invalidated",
      idempotencyKey: args["idempotency-key"],
    });
    printJson(response);
  } else if (command === "teardown") {
    const state = await readJson(required(args.state, "--state"));
    const response = await teardownCloudflarePreview(state, {
      allowLive: args["allow-live"] === true,
      root: process.cwd(),
      wranglerPackage: args["wrangler-package"],
      acceptanceUrl: required(args["acceptance-url"], "--acceptance-url"),
      token: tokenFromArgs(args),
      reviewId: required(args["review-id"], "--review-id"),
      reason: args.reason,
    });
    printJson(response);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error.stack ?? String(error));
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[name] = true;
    } else {
      parsed[name] = next;
      index += 1;
    }
  }
  return parsed;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  if (!filePath) return;
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function required(value, name) {
  if (!value || value === true) throw new Error(`${name} is required`);
  return value;
}

function tokenFromArgs(args) {
  const token = args.token ?? process.env[args["token-env"] ?? "NIB_ACCEPTANCE_TOKEN"];
  if (!token) throw new Error("--token or token env var is required");
  return token;
}
