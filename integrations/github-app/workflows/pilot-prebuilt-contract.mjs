#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const examples = ["onboarding", "business-rules", "permissions"];
const bundleEntries = { "nib-site": "shim.js", "nib-global": "index.js", nib: "index.js" };
const command = process.argv[2];

if (command === "bind-recipe") {
  await bindRecipeFromEnv();
} else if (command === "validate-local-dry-run") {
  await validateLocalDryRun();
} else if (command === "validate-actual-wrangler-dry-run") {
  await validateLocalDryRun(true);
} else {
  throw new Error("Usage: node pilot-prebuilt-contract.mjs bind-recipe|validate-local-dry-run|validate-actual-wrangler-dry-run");
}

async function bindRecipeFromEnv() {
  const example = requiredEnv("NIB_PILOT_EXAMPLE");
  if (!examples.includes(example)) throw new Error(`Unsupported example: ${example}`);
  await bindRecipeToPrebuilt({
    example,
    trustedRoot: requiredEnv("NIB_TRUSTED_ROOT"),
    recipePath: requiredEnv("NIB_TRUSTED_RECIPE_PATH"),
    artifactRoot: requiredEnv("NIB_ARTIFACT_ROOT"),
    wranglerPackage: requiredEnv("NIB_TRUSTED_WRANGLER_PACKAGE"),
  });
}

async function validateLocalDryRun(actual = false) {
  const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const temp = await mkdtemp(path.join(tmpdir(), "nib-pilot-prebuilt-"));
  try {
    const artifactRoot = path.join(temp, "artifacts");
    if (actual) await writeActualWranglerDryRunArtifact(repoRoot, artifactRoot);
    else await writeSyntheticPrebuiltArtifact(artifactRoot);
    for (const example of examples) {
      const recipePath = path.join(temp, "recipes", `${example}.json`);
      await mkdir(path.dirname(recipePath), { recursive: true });
      const prepared = spawnSync(process.execPath, ["examples/acceptance/prepare.mjs", example, recipePath], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          NIB_ACCEPTANCE_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
          NIB_ACCEPTANCE_COMMIT: "a".repeat(40),
          NIB_ACCEPTANCE_REPOSITORY_ID: "123",
          NIB_ACCEPTANCE_REPOSITORY: "test/example",
          NIB_ACCEPTANCE_SUBJECT: "github:test/example:pull/7",
          NIB_ACCEPTANCE_REVISION: `dry-run-${example}`,
          NIB_ACCEPTANCE_PILOT_ONBOARDING_EMAIL: "pilot-onboarding@example.com",
          NIB_ACCEPTANCE_PILOT_BUSINESS_RULES_EMAIL: "pilot-business-rules@example.com",
          NIB_ACCEPTANCE_PILOT_PERMISSIONS_OWNER_EMAIL: "pilot-permissions-owner@example.com",
          NIB_ACCEPTANCE_PILOT_PERMISSIONS_ADMIN_EMAIL: "pilot-permissions-admin@example.com",
          NIB_ACCEPTANCE_PILOT_PERMISSIONS_REVIEWER_EMAIL: "pilot-permissions-reviewer@example.com",
          NIB_ACCEPTANCE_PILOT_PERMISSIONS_VIEWER_EMAIL: "pilot-permissions-viewer@example.com",
          NIB_ACCEPTANCE_PREVIEW_DEFAULT_PRICE_ID: "price_preview_default",
          NIB_ACCEPTANCE_PREVIEW_HIGH_PRICE_ID: "price_preview_high",
          NIB_ACCEPTANCE_PREVIEW_USAGE_PRICE_ID: "price_preview_usage",
        },
      });
      if (prepared.status !== 0) {
        throw new Error(`prepare ${example} failed\n${prepared.stdout}\n${prepared.stderr}`);
      }
      await bindRecipeToPrebuilt({
        example,
        trustedRoot: repoRoot,
        recipePath,
        artifactRoot,
        wranglerPackage: path.join(repoRoot, "apps/web"),
      });
      const planPath = path.join(temp, "plans", `${example}.json`);
      await mkdir(path.dirname(planPath), { recursive: true });
      const planned = spawnSync(process.execPath, [
        "integrations/cloudflare/bin/nib-cloudflare-preview.mjs",
        "plan",
        "--recipe",
        recipePath,
        "--state-dir",
        path.join(temp, "state", example),
        "--out",
        planPath,
      ], { cwd: repoRoot, encoding: "utf8" });
      if (planned.status !== 0) {
        throw new Error(`plan ${example} failed\n${planned.stdout}\n${planned.stderr}`);
      }
      const plan = JSON.parse(await readFile(planPath, "utf8"));
      const missingAssets = plan.components.flatMap((component) => component.missingAssets ?? []);
      if (missingAssets.length) throw new Error(`${example} has missing assets: ${missingAssets.join(", ")}`);
      for (const component of plan.components) {
        if (component.generatedConfig.no_bundle !== true) {
          throw new Error(`${example} ${component.name} did not preserve no_bundle`);
        }
        for (const database of component.generatedConfig.d1_databases ?? []) {
          const migrations = path.resolve(path.dirname(component.generatedConfigPath), database.migrations_dir);
          if (!(await stat(migrations)).isDirectory()) throw new Error(`Missing migrations: ${migrations}`);
        }
        if (actual) {
          const outdir = path.join(temp, "repacked", example, component.baseName);
          await mkdir(path.dirname(component.generatedConfigPath), { recursive: true });
          await writeFile(component.generatedConfigPath, `${JSON.stringify(component.generatedConfig, null, 2)}\n`);
          await run(path.join(repoRoot, "apps/web"), "./node_modules/.bin/wrangler", [
            "deploy", "--config", component.generatedConfigPath, "--dry-run", "--outdir", outdir,
          ]);
          await findBundleMain(outdir, component.baseName);
        }
      }
    }
    console.log(JSON.stringify({ examples, dryRun: "passed", actualBundles: actual }));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function bindRecipeToPrebuilt({ example, trustedRoot, recipePath, artifactRoot, wranglerPackage }) {
  const recipe = JSON.parse(await readFile(recipePath, "utf8"));
  recipe.cloudflare = { ...(recipe.cloudflare ?? {}), wranglerPackage };
  const configRoot = path.join(path.dirname(recipePath), "configs");
  await mkdir(configRoot, { recursive: true });
  const components = recipe.cloudflare?.components ?? [];
  for (const component of components) {
    const baseName = component.name;
    const sourceConfigPath = path.resolve(trustedRoot, component.config);
    const config = parseJsonc(await readFile(sourceConfigPath, "utf8"));
    const bundleMain = await findBundleMain(path.join(artifactRoot, "prebuilt", baseName), baseName);
    config.main = bundleMain;
    config.no_bundle = true;
    config.find_additional_modules = true;
    delete config.build;
    rebaseD1Migrations(config, sourceConfigPath);
    if (baseName === "nib") {
      config.assets = {
        ...(config.assets ?? {}),
        directory: path.join(artifactRoot, "assets", "site-assets"),
      };
    }
    const configPath = path.join(configRoot, `${baseName}.wrangler.jsonc`);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    component.config = configPath;
    component.cwd = wranglerPackage;
  }
  await writeFile(recipePath, `${JSON.stringify(recipe, null, 2)}\n`);
}

async function writeSyntheticPrebuiltArtifact(artifactRoot) {
  const prebuiltRoot = path.join(artifactRoot, "prebuilt");
  for (const component of ["nib-site", "nib-global", "nib"]) {
    const componentRoot = path.join(prebuiltRoot, component);
    await mkdir(componentRoot, { recursive: true });
    await writeFile(path.join(componentRoot, bundleEntries[component]), `export default { fetch() { return new Response(${JSON.stringify(component)}); } };\n`);
    if (component === "nib-site") await writeFile(path.join(componentRoot, "fixture-index.wasm"), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  }
  const assets = path.join(artifactRoot, "assets", "site-assets");
  await mkdir(assets, { recursive: true });
  await writeFile(path.join(assets, "asset.txt"), "synthetic site asset\n");
}

async function writeActualWranglerDryRunArtifact(repoRoot, artifactRoot) {
  await mkdir(path.join(artifactRoot, "prebuilt"), { recursive: true });
  await run(repoRoot, "npm", ["run", "site:build", "--prefix", "apps/web"]);
  await run(repoRoot, "npm", ["run", "site:worker:build", "--prefix", "apps/web"]);
  const components = [
    ["nib-site", "apps/web", "site/wrangler.jsonc"],
    ["nib-global", "apps/cloudflare", "wrangler.jsonc"],
    ["nib", "apps/web", "wrangler.jsonc"],
  ];
  const bundles = [];
  for (const [name, packagePath, config] of components) {
    await run(path.join(repoRoot, packagePath), "./node_modules/.bin/wrangler", [
      "deploy", "--config", config, "--dry-run", "--outdir", path.join(artifactRoot, "prebuilt", name),
    ]);
    const main = await findBundleMain(path.join(artifactRoot, "prebuilt", name), name);
    bundles.push({ name, main: path.basename(main) });
  }
  const assets = path.join(artifactRoot, "assets", "site-assets");
  await mkdir(assets, { recursive: true });
  await cp(path.join(repoRoot, "apps/web/site/dist/assets"), assets, { recursive: true });
  return bundles;
}

async function run(cwd, executable, args) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
}

async function findBundleMain(directory, component) {
  const entry = bundleEntries[component];
  if (!entry) throw new Error(`Unknown component: ${component}`);
  const main = path.join(directory, entry);
  if (!(await stat(main)).isFile()) throw new Error(`Missing compiled entry: ${main}`);
  if (component === "nib-site" && !(await listFiles(directory)).some(file => file.endsWith(".wasm"))) {
    throw new Error(`Missing compiled site WebAssembly in ${directory}`);
  }
  return main;
}

function rebaseD1Migrations(config, sourceConfigPath) {
  if (!Array.isArray(config.d1_databases)) return;
  const sourceConfigDir = path.dirname(sourceConfigPath);
  config.d1_databases = config.d1_databases.map((database) => {
    if (!database.migrations_dir || path.isAbsolute(database.migrations_dir)) return database;
    return { ...database, migrations_dir: path.resolve(sourceConfigDir, database.migrations_dir) };
  });
}

async function listFiles(directory) {
  const entries = await import("node:fs/promises").then(({ readdir }) => readdir(directory, { withFileTypes: true }));
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(full));
    if (entry.isFile()) files.push(full);
  }
  return files;
}

function parseJsonc(source) {
  return JSON.parse(stripJsonc(source));
}

function stripJsonc(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (inString) {
      output += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === "\"") {
        inString = false;
      }
      continue;
    }
    if (current === "\"") {
      inString = true;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    output += current;
  }
  return output;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
