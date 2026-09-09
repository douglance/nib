import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAcceptanceTeamTestFixture, type AcceptanceTeamTestFixture } from "./team-test-db";
import { hasFreshProviderVerification, recordProviderVerification } from "./provider-verification";
import type { AcceptanceManifest } from "./contracts";

const db = () => fixture.db as unknown as D1Database;

let fixture: AcceptanceTeamTestFixture;
const now = 1_800_000_000;
const review = { projectId: "project", id: "review", manifestHash: "a".repeat(64),
  manifest: { build: { provider: "cloudflare", commit: "sha" } } as AcceptanceManifest };
const actor = { id: "bot", projectId: "project", scopes: ["verify"] };
const probe = { manifestHash: review.manifestHash, commit: "sha", verifiedAt: new Date(now * 1000).toISOString() };
beforeEach(async () => {
  fixture = await createAcceptanceTeamTestFixture({ migrations: ["0019_acceptance_provider_verifications.sql"], accounts: [{ id: "owner", email: "owner@example.com" }] });
  fixture.sqlite.exec(`INSERT INTO acceptance_teams(id,name,created_by,created_at,updated_at) VALUES ('team','Team','owner',1,1);
    INSERT INTO acceptance_projects(id,team_id,name,created_by,created_at,updated_at) VALUES ('project','team','Project','owner',1,1);`);
});
afterEach(() => fixture.sqlite.close());

describe("Cloudflare provider freshness", () => {
  it("fails closed until an authorized probe, and again after 60 seconds", async () => {
    expect(await hasFreshProviderVerification(db(), review, now)).toBe(false);
    await recordProviderVerification(db(), review, actor, probe, "probe", now);
    expect(await hasFreshProviderVerification(db(), review, now + 59)).toBe(true);
    expect(await hasFreshProviderVerification(db(), review, now + 60)).toBe(false);
    expect(await hasFreshProviderVerification(db(), { ...review, id: "other" }, now)).toBe(false);
    expect(await hasFreshProviderVerification(db(), { ...review, manifestHash: "b".repeat(64) }, now)).toBe(false);
  });
  it("rejects human assertions, wrong scope, wrong build, and stale or future probes", async () => {
    for (const identity of [null, { ...actor, projectId: "other" }, { ...actor, scopes: ["publish"] }]) {
      await expect(recordProviderVerification(db(), review, identity, probe, "probe", now)).rejects.toMatchObject({ status: 403 });
    }
    for (const value of [{ ...probe, commit: "other" }, { ...probe, manifestHash: "other" },
      { ...probe, verifiedAt: new Date((now - 60) * 1000).toISOString() },
      { ...probe, verifiedAt: new Date((now + 6) * 1000).toISOString() }]) {
      await expect(recordProviderVerification(db(), review, actor, value, "probe", now)).rejects.toMatchObject({ status: 400 });
    }
  });
  it("replays without extending probe expiry and rejects a different check under the same key", async () => {
    await recordProviderVerification(db(), review, actor, probe, "probe", now);
    await recordProviderVerification(db(), review, actor, probe, "probe", now + 30);
    expect(await hasFreshProviderVerification(db(), review, now + 60)).toBe(false);
    await expect(recordProviderVerification(db(), review, actor,
      { ...probe, verifiedAt: new Date((now + 1) * 1000).toISOString() }, "probe", now + 1)).rejects.toMatchObject({ status: 409 });
  });
});
