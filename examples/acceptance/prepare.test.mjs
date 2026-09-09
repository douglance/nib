import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
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
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const recipe = JSON.parse(await readFile(output, "utf8"));
      assert.equal(recipe.build.commit, "a".repeat(40));
      assert.equal(recipe.subject, "github:test/example:pull/7");
      const plan = await planCloudflarePreview(recipe, { root, stateDir: path.join(temp, name) });
      assert.equal(plan.components.length, 3);
      const primary = plan.components.find((component) => component.role === "primary");
      assert.equal(primary.baseName, "nib");
      assert.equal(primary.generatedConfig.vars.ACCEPTANCE_ENABLED, "true");
      assert.equal(primary.generatedConfig.vars.ENVIRONMENT, "production");
      for (const component of plan.components.filter((component) => component !== primary)) {
        assert.equal(component.generatedConfig.workers_dev, false);
        assert.equal(component.generatedConfig.preview_urls, false);
      }
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
