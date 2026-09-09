import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrations = new URL("../../apps/web/worker/migrations/", import.meta.url);
const businessSeed = readFileSync(new URL("./business-rules/seed.sql", import.meta.url), "utf8");
const permissionsSeed = readFileSync(new URL("./permissions/seed.sql", import.meta.url), "utf8");

test("example seeds match every production migration and preserve exercised state on replay", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
      db.exec(readFileSync(new URL(file, migrations), "utf8"));
    }
    db.exec(businessSeed);
    db.exec(permissionsSeed);
    assert.equal(db.prepare("SELECT count(*) AS total FROM accounts").get().total, 5);
    assert.deepEqual({ ...db.prepare("SELECT plan, trial_state, unmetered_access FROM accounts WHERE account_id = ?").get("acct_acceptance_business_rules") }, {
      plan: "default", trial_state: "available", unmetered_access: 0,
    });
    const roles = db.prepare(`SELECT tm.role AS team_role, pm.role AS project_role
      FROM acceptance_team_members tm JOIN acceptance_project_members pm ON pm.account_id = tm.account_id
      WHERE tm.account_id = ?`).get("acct_acceptance_admin");
    assert.deepEqual({ ...roles }, { team_role: "member", project_role: "admin" });
    assert.equal(db.prepare("SELECT count(*) AS total FROM acceptance_project_credentials").get().total, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

    db.prepare("UPDATE accounts SET trial_state = 'used' WHERE account_id = ?").run("acct_acceptance_business_rules");
    db.prepare("UPDATE acceptance_project_members SET role = 'viewer' WHERE account_id = ?").run("acct_acceptance_reviewer");
    db.exec(businessSeed);
    db.exec(permissionsSeed);
    assert.equal(db.prepare("SELECT count(*) AS total FROM accounts").get().total, 5);
    assert.equal(db.prepare("SELECT trial_state FROM accounts WHERE account_id = ?").get("acct_acceptance_business_rules").trial_state, "used");
    assert.equal(db.prepare("SELECT role FROM acceptance_project_members WHERE account_id = ?").get("acct_acceptance_reviewer").role, "viewer");
  } finally {
    db.close();
  }
});
