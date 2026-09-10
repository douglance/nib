#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const [name, output] = process.argv.slice(2);
if (!["onboarding", "business-rules", "permissions"].includes(name) || !output) {
  throw new Error("Usage: node examples/acceptance/prepare.mjs onboarding|business-rules|permissions OUTPUT.json");
}
const required = (name, pattern) => {
  const value = process.env[name];
  if (!value || !pattern.test(value)) throw new Error(`${name} is missing or invalid`);
  return value;
};
const recipe = JSON.parse(await readFile(new URL(`./${name}/recipe.json`, import.meta.url), "utf8"));
recipe.projectId = required("NIB_ACCEPTANCE_PROJECT_ID", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
recipe.build.commit = required("NIB_ACCEPTANCE_COMMIT", /^[0-9a-f]{40}$/i);
recipe.revision = process.env.NIB_ACCEPTANCE_REVISION || recipe.build.commit;
const [owner, repo] = required("NIB_ACCEPTANCE_REPOSITORY", /^[^/\s]+\/[^/\s]+$/).split("/");
recipe.build.repository = { id: required("NIB_ACCEPTANCE_REPOSITORY_ID", /^\d+$/), owner, name: repo };
if (process.env.NIB_ACCEPTANCE_SUBJECT) recipe.subject = process.env.NIB_ACCEPTANCE_SUBJECT;
const pilotEmails = resolvePilotEmails(recipe);
configurePilotEmailBinding(recipe, pilotEmails);
configurePreviewVars(recipe);
configurePreviewSecrets(recipe);
await materializeSeedFiles(name, output, recipe, pilotEmails);
await mkdir(path.dirname(path.resolve(output)), { recursive: true });
await writeFile(output, `${JSON.stringify(recipe, null, 2)}\n`);
console.log(JSON.stringify({ recipe: path.resolve(output), projectId: recipe.projectId, commit: recipe.build.commit, subject: recipe.subject }));

function resolvePilotEmails(recipe) {
  const references = recipe.references?.pilotEmails ?? {};
  const emails = {};
  for (const [key, reference] of Object.entries(references)) {
    const env = requiredLiteral(reference.env, /^[A-Z0-9_]+$/, `references.pilotEmails.${key}.env`);
    const value = requiredEmail(env);
    emails[key] = { env, value };
  }
  return emails;
}

function configurePilotEmailBinding(recipe, pilotEmails) {
  const destinations = Object.values(pilotEmails).map((entry) => entry.value);
  if (destinations.length === 0) return;
  const primary = primaryComponent(recipe);
  primary.email = {
    ...(primary.email ?? {}),
    allowedDestinationAddresses: destinations,
  };
}

function configurePreviewVars(recipe) {
  const previewVars = recipe.references?.previewVars ?? [];
  if (previewVars.length === 0) return;
  const primary = primaryComponent(recipe);
  primary.vars = { ...(primary.vars ?? {}) };
  for (const variable of previewVars) {
    const name = requiredLiteral(variable.name, /^[A-Z][A-Z0-9_]{0,127}$/, "references.previewVars.name");
    const env = requiredLiteral(variable.env, /^NIB_ACCEPTANCE_PREVIEW_[A-Z0-9_]+$/, "references.previewVars.env");
    primary.vars[name] = requiredPreviewVar(env, name);
  }
}

function configurePreviewSecrets(recipe) {
  const previewSecrets = recipe.references?.previewSecrets ?? [];
  if (previewSecrets.length === 0) return;
  const primary = primaryComponent(recipe);
  primary.secrets = previewSecrets.map((secret) => ({
    name: requiredLiteral(secret.name, /^[A-Z][A-Z0-9_]{0,127}$/, "references.previewSecrets.name"),
    env: requiredLiteral(secret.env, /^NIB_ACCEPTANCE_PREVIEW_[A-Z0-9_]+$/, "references.previewSecrets.env"),
  }));
}

async function materializeSeedFiles(name, output, recipe, pilotEmails) {
  const replacements = Object.fromEntries(
    Object.values(pilotEmails).map(({ env, value }) => [`__${env}__`, value])
  );
  const targetRoot = path.join(path.dirname(path.resolve(output)), `${name}-fixtures`);
  for (const component of recipe.cloudflare?.components ?? []) {
    for (const seed of [...component.seed?.d1 ?? [], ...component.seed?.r2 ?? []]) {
      seed.file = await materializeReferencedFile(seed.file, name, targetRoot, replacements);
    }
  }
}

async function materializeReferencedFile(file, exampleName, targetRoot, replacements) {
  const source = path.resolve(REPO_ROOT, file);
  const sourceRoot = path.join(REPO_ROOT, "examples", "acceptance", exampleName);
  const relative = path.relative(sourceRoot, source);
  const target = path.join(targetRoot, relative);
  let contents = await readFile(source, "utf8");
  for (const [placeholder, value] of Object.entries(replacements)) {
    contents = contents.split(placeholder).join(escapedReplacement(value, path.extname(source)));
  }
  if (contents.includes("__NIB_ACCEPTANCE_") || contents.includes(".invalid")) {
    throw new Error(`${file} still contains unresolved hosted pilot placeholders`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
  return path.relative(REPO_ROOT, target);
}

function escapedReplacement(value, extension) {
  if (extension === ".sql") return value.replaceAll("'", "''");
  if (extension === ".json") return JSON.stringify(value).slice(1, -1);
  return value;
}

function primaryComponent(recipe) {
  const components = recipe.cloudflare?.components ?? [];
  const primary = components.find((component) => component.primary === true) ?? components[0];
  if (!primary) throw new Error("recipe has no Cloudflare components");
  return primary;
}

function requiredPreviewVar(env, name) {
  const value = required(env, /^.+$/).trim();
  if (!value) throw new Error(`${env} is missing or invalid`);
  if ((name === "DEFAULT_PRICE_ID" || name === "HIGH_PRICE_ID" || name === "USAGE_PRICE_ID") && !value.startsWith("price_")) {
    throw new Error(`${env} must be a Stripe price id`);
  }
  return value;
}

function requiredEmail(name) {
  const email = required(name, /^[^\s@]+@[^\s@]+\.[^\s@]+$/).trim().toLowerCase();
  if (email.endsWith(".invalid")) throw new Error(`${name} must not use .invalid for hosted pilots`);
  return email;
}

function requiredLiteral(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${name} is missing or invalid`);
  return value;
}
