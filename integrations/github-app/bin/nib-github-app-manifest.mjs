#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistrationServer, loadManifest } from "../src/registration.mjs";

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "serve";

try {
  if (command !== "serve") {
    throw new Error(`Unknown command: ${command}`);
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const manifestPath = path.resolve(process.cwd(), args.manifest ?? "integrations/github-app/manifest.json");
  const runtimeDir = path.resolve(process.cwd(), args["runtime-dir"] ?? "integrations/github-app/.tmp");
  const host = args.host ?? "127.0.0.1";
  const port = Number(args.port ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port must be an integer from 0 to 65535");
  }

  const manifest = await loadManifest(manifestPath);
  const registration = await createRegistrationServer({
    manifest,
    runtimeDir,
    host,
    port,
    githubNewAppUrl: args["github-new-app-url"] ?? "https://github.com/settings/apps/new",
    githubApiUrl: args["github-api-url"] ?? "https://api.github.com",
    githubApiVersion: args["github-api-version"] ?? "2022-11-28",
    userAgent: args["user-agent"] ?? "nib-github-app-manifest-registration",
    repoRoot,
    onComplete: (result) => {
      console.log(JSON.stringify({
        appId: result.appId,
        appUrl: result.appUrl,
        credentialsPath: result.credentialsPath,
      }, null, 2));
    },
  });

  console.log(`Nib GitHub App manifest review: ${registration.reviewUrl}`);
  console.log(`GitHub manifest callback: ${registration.callbackUrl}`);
  console.log(`Runtime credentials directory: ${runtimeDir}`);
  console.log("Keep this process running until GitHub redirects back after App creation.");

  await registration.closed;
} catch (error) {
  console.error(error.message ?? String(error));
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
