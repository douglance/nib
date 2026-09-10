import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { planCloudflarePreview } from "../../integrations/cloudflare/src/cloudflare-preview.mjs";

test("all hosted example recipes prepare with concrete identity and isolated public routing", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "nib-prepared-examples-"));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  try {
    for (const name of ["onboarding", "business-rules", "permissions"]) {
      const output = path.join(temp, `${name}.json`);
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("./prepare.mjs", import.meta.url)), name, output], {
        encoding: "utf8", env: { ...process.env,
          NIB_ACCEPTANCE_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
          NIB_ACCEPTANCE_COMMIT: "a".repeat(40), NIB_ACCEPTANCE_REPOSITORY_ID: "123",
          NIB_ACCEPTANCE_REPOSITORY: "test/example", NIB_ACCEPTANCE_SUBJECT: "github:test/example:pull/7",
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
      assert.equal(result.status, 0, result.stderr);
      const recipe = JSON.parse(await readFile(output, "utf8"));
      assert.equal(recipe.build.commit, "a".repeat(40));
      assert.equal(recipe.subject, "github:test/example:pull/7");
      assert.equal(JSON.stringify(recipe).includes(".invalid"), false);
      assert.equal(JSON.stringify(recipe).includes("__NIB_ACCEPTANCE_"), false);
      const plan = await planCloudflarePreview(recipe, { root, stateDir: path.join(temp, name) });
      assert.equal(plan.components.length, 3);
      const primary = plan.components.find((component) => component.role === "primary");
      assert.equal(primary.baseName, "nib");
      assert.equal(primary.generatedConfig.vars.ACCEPTANCE_ENABLED, "true");
      assert.equal(primary.generatedConfig.vars.ENVIRONMENT, "production");
      if (name === "business-rules") {
        assert.equal(primary.generatedConfig.vars.DEFAULT_PRICE_ID, "price_preview_default");
        assert.equal(primary.generatedConfig.vars.HIGH_PRICE_ID, "price_preview_high");
        assert.equal(primary.generatedConfig.vars.USAGE_PRICE_ID, "price_preview_usage");
      }
      assert.deepEqual(
        primary.generatedConfig.send_email[0].allowed_destination_addresses,
        expectedPilotEmails(name),
      );
      assert.equal(plan.operations.some((operation) => operation.action === "secret"), true);
      for (const operation of plan.operations.filter((entry) => entry.action === "seed")) {
        const source = await readFile(operation.file, "utf8");
        assert.equal(source.includes(".invalid"), false);
        assert.equal(source.includes("__NIB_ACCEPTANCE_"), false);
      }
      for (const component of plan.components.filter((component) => component !== primary)) {
        assert.equal(component.generatedConfig.workers_dev, false);
        assert.equal(component.generatedConfig.preview_urls, false);
      }
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("hosted pilot fixture materialization escapes SQL and JSON replacements", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "nib-prepared-escaping-"));
  try {
    const output = path.join(temp, "onboarding.json");
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./prepare.mjs", import.meta.url)), "onboarding", output], {
      encoding: "utf8", env: { ...process.env,
        NIB_ACCEPTANCE_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
        NIB_ACCEPTANCE_COMMIT: "a".repeat(40),
        NIB_ACCEPTANCE_REPOSITORY_ID: "123",
        NIB_ACCEPTANCE_REPOSITORY: "test/example",
        NIB_ACCEPTANCE_PILOT_ONBOARDING_EMAIL: "pilot.o'quote@example.com",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const recipe = JSON.parse(await readFile(output, "utf8"));
    const seed = recipe.cloudflare.components
      .flatMap((component) => component.seed?.d1 ?? [])
      .find((entry) => entry.file.endsWith("seed.sql"));
    assert.ok(seed);
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("create table accounts(account_id text primary key, email text not null, created_at integer not null, updated_at integer not null);");
      db.exec(await readFile(path.join(fileURLToPath(new URL("../../", import.meta.url)), seed.file), "utf8"));
      assert.equal(
        db.prepare("select email from accounts where account_id = ?").get("acct_acceptance_onboarding").email,
        "pilot.o'quote@example.com",
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("hosted pilot JSON fixture materialization escapes JSON string replacements", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "nib-prepared-json-escaping-"));
  try {
    const output = path.join(temp, "onboarding.json");
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./prepare.mjs", import.meta.url)), "onboarding", output], {
      encoding: "utf8", env: { ...process.env,
        NIB_ACCEPTANCE_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
        NIB_ACCEPTANCE_COMMIT: "a".repeat(40),
        NIB_ACCEPTANCE_REPOSITORY_ID: "123",
        NIB_ACCEPTANCE_REPOSITORY: "test/example",
        NIB_ACCEPTANCE_PILOT_ONBOARDING_EMAIL: "pilot.d\"quote@example.com",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const reviewRequestPath = path.join(temp, "onboarding-fixtures", "review-request.json");
    assert.equal(JSON.parse(await readFile(reviewRequestPath, "utf8")).email, "pilot.d\"quote@example.com");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

function expectedPilotEmails(name) {
  if (name === "onboarding") return ["pilot-onboarding@example.com"];
  if (name === "business-rules") return ["pilot-business-rules@example.com"];
  return [
    "pilot-permissions-owner@example.com",
    "pilot-permissions-admin@example.com",
    "pilot-permissions-reviewer@example.com",
    "pilot-permissions-viewer@example.com",
  ];
}
