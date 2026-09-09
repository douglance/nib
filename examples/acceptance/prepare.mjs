#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
await mkdir(path.dirname(path.resolve(output)), { recursive: true });
await writeFile(output, `${JSON.stringify(recipe, null, 2)}\n`);
console.log(JSON.stringify({ recipe: path.resolve(output), projectId: recipe.projectId, commit: recipe.build.commit, subject: recipe.subject }));
