import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrations = new URL("../../apps/web/worker/migrations/", import.meta.url);
const onboardingSeed = hostedSeed("./onboarding/seed.sql");
const businessSeed = hostedSeed("./business-rules/seed.sql");
const permissionsSeed = hostedSeed("./permissions/seed.sql");

test("example seeds match every production migration and preserve exercised state on replay", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
      db.exec(readFileSync(new URL(file, migrations), "utf8"));
    }
    db.exec(onboardingSeed);
    db.exec(businessSeed);
    db.exec(permissionsSeed);
    assert.equal(db.prepare("SELECT count(*) AS total FROM accounts").get().total, 6);
    assert.deepEqual({ ...db.prepare("SELECT plan, trial_state, unmetered_access FROM accounts WHERE account_id = ?").get("acct_acceptance_business_rules") }, {
      plan: "default", trial_state: "available", unmetered_access: 0,
    });
    assert.equal(
      db.prepare("SELECT email FROM accounts WHERE account_id = ?").get("acct_acceptance_onboarding").email,
      "pilot-onboarding@example.com",
    );
    const roles = db.prepare(`SELECT tm.role AS team_role, pm.role AS project_role
      FROM acceptance_team_members tm JOIN acceptance_project_members pm ON pm.account_id = tm.account_id
      WHERE tm.account_id = ?`).get("acct_acceptance_admin");
    assert.deepEqual({ ...roles }, { team_role: "member", project_role: "admin" });
    assert.equal(db.prepare("SELECT count(*) AS total FROM acceptance_project_credentials").get().total, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

    db.prepare("UPDATE accounts SET trial_state = 'used' WHERE account_id = ?").run("acct_acceptance_business_rules");
    db.prepare("UPDATE acceptance_project_members SET role = 'viewer' WHERE account_id = ?").run("acct_acceptance_reviewer");
    db.exec(onboardingSeed);
    db.exec(businessSeed);
    db.exec(permissionsSeed);
    assert.equal(db.prepare("SELECT count(*) AS total FROM accounts").get().total, 6);
    assert.equal(db.prepare("SELECT trial_state FROM accounts WHERE account_id = ?").get("acct_acceptance_business_rules").trial_state, "used");
    assert.equal(db.prepare("SELECT role FROM acceptance_project_members WHERE account_id = ?").get("acct_acceptance_reviewer").role, "viewer");
  } finally {
    db.close();
  }
});

function hostedSeed(file) {
  return readFileSync(new URL(file, import.meta.url), "utf8")
    .replaceAll("__NIB_ACCEPTANCE_PILOT_ONBOARDING_EMAIL__", "pilot-onboarding@example.com")
    .replaceAll("__NIB_ACCEPTANCE_PILOT_BUSINESS_RULES_EMAIL__", "pilot-business-rules@example.com")
    .replaceAll("__NIB_ACCEPTANCE_PILOT_PERMISSIONS_OWNER_EMAIL__", "pilot-permissions-owner@example.com")
    .replaceAll("__NIB_ACCEPTANCE_PILOT_PERMISSIONS_ADMIN_EMAIL__", "pilot-permissions-admin@example.com")
    .replaceAll("__NIB_ACCEPTANCE_PILOT_PERMISSIONS_REVIEWER_EMAIL__", "pilot-permissions-reviewer@example.com")
    .replaceAll("__NIB_ACCEPTANCE_PILOT_PERMISSIONS_VIEWER_EMAIL__", "pilot-permissions-viewer@example.com");
}
