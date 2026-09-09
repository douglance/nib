import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAcceptanceTeamTestFixture, type AcceptanceTeamTestFixture } from "./team-test-db";
import { evidenceResponse, uploadEvidence, validateStoredEvidence } from "./evidence";
import { readBoundedBody } from "./http";
import type { Env } from "../types";
import type { AcceptanceManifest } from "./contracts";

const project = "11111111-1111-4111-8111-111111111111";
let fixture: AcceptanceTeamTestFixture;
let objects: Map<string, Uint8Array>;
let env: Env;
beforeEach(async () => {
  fixture = await createAcceptanceTeamTestFixture({ migrations: ["0017_acceptance_delivery_and_evidence.sql"], accounts: [{ id: "owner", email: "owner@example.com" }] });
  fixture.sqlite.exec(`INSERT INTO acceptance_teams(id,name,created_by,created_at,updated_at) VALUES ('team','Team','owner',1,1);
    INSERT INTO acceptance_projects(id,team_id,name,created_by,created_at,updated_at) VALUES ('${project}','team','Project','owner',1,1);`);
  objects = new Map();
  env = { DB: fixture.db, PUBLIC_ORIGIN: "https://nib.test", ARTIFACTS: {
    async put(key: string, value: Uint8Array) { objects.set(key, value); },
    async get(key: string) { const value = objects.get(key); return value ? { body: new Uint8Array(value).buffer } : null; },
    async head(key: string) { return objects.has(key) ? { key } : null; },
  } } as unknown as Env;
});
afterEach(() => fixture.sqlite.close());

function upload(body = "browser evidence", key = "upload-1", type = "text/plain") {
  return new Request(`https://nib.test/api/acceptance/v1/projects/${project}/evidence`, {
    method: "POST", headers: { "content-type": type, "x-nib-filename": "check.txt", "idempotency-key": key }, body,
  });
}

describe("private content-addressed acceptance evidence", () => {
  it("replays an upload without duplicating objects and exports verified SHA-256", async () => {
    const first = await uploadEvidence(upload(), env, project, "owner");
    const descriptor = await first.json() as Record<string, string>;
    const again = await uploadEvidence(upload(), env, project, "owner");
    expect(await again.json()).toEqual(descriptor);
    expect(objects.size).toBe(1);
    expect(descriptor.sha256).toMatch(/^[a-f0-9]{64}$/);
    const downloaded = await evidenceResponse(env, project, descriptor.sha256!);
    expect(await downloaded.text()).toBe("browser evidence");
    expect(downloaded.headers.get("cache-control")).toBe("private, no-store");
    expect(downloaded.headers.get("content-disposition")).toContain("attachment");
  });

  it("rejects reuse of an upload operation for different bytes", async () => {
    await uploadEvidence(upload(), env, project, "owner");
    await expect(uploadEvidence(upload("different evidence"), env, project, "owner")).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    expect(objects.size).toBe(1);
  });

  it("does not serve another project's object through a guessed digest", async () => {
    const result = await uploadEvidence(upload(), env, project, "owner");
    const descriptor = await result.json() as { sha256: string };
    await expect(evidenceResponse(env, "other-project", descriptor.sha256)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects active web content and missing evidence before publication", async () => {
    await expect(uploadEvidence(upload("<script>alert(1)</script>", "html", "text/html"), env, project, "owner")).rejects.toMatchObject({ status: 415 });
    const manifest = { evidence: [{ url: `https://nib.test/api/acceptance/v1/projects/${project}/evidence/${"a".repeat(64)}`, sha256: "a".repeat(64) }] } as AcceptanceManifest;
    await expect(validateStoredEvidence(manifest, env, project)).rejects.toMatchObject({ code: "evidence_missing" });
  });

  it("cancels a chunked body when it exceeds the limit", async () => {
    let canceled = false;
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(10)); }, cancel() { canceled = true; } });
    const request = new Request("https://nib.test", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await expect(readBoundedBody(request, 5)).rejects.toMatchObject({ status: 413 });
    expect(canceled).toBe(true);
  });

  it("rejects evidence over 16 MiB before buffering or storing it", async () => {
    const request = upload();
    request.headers.set("content-length", String(16 * 1024 * 1024 + 1));
    await expect(uploadEvidence(request, env, project, "owner")).rejects.toMatchObject({ status: 413 });
    expect(objects.size).toBe(0);
  });
});
