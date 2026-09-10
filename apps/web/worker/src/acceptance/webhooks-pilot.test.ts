import { afterEach, expect, it, vi } from "vitest";
import { createAcceptanceTeamTestFixture } from "./team-test-db";
import { deliverQueuedCustomerWebhooks } from "./webhooks";
import type { AcceptanceIntegrationEnv } from "./common";

afterEach(() => vi.unstubAllGlobals());

it("keeps non-pilot webhooks queued without consuming the pilot delivery batch", async () => {
  const fixture = await createAcceptanceTeamTestFixture({
    accounts: [{ id: "owner", email: "owner@example.com" }],
    migrations: ["0016_acceptance_integrations.sql"],
  });
  try {
    fixture.sqlite.exec("INSERT INTO acceptance_teams(id,name,created_by,created_at,updated_at) VALUES ('team','Team','owner',1,1)");
    for (const project of ["a-outside", "z-pilot"]) {
      fixture.sqlite.exec(`
        INSERT INTO acceptance_projects(id,team_id,name,created_by,created_at,updated_at)
          VALUES ('${project}','team','Project','owner',1,1);
        INSERT INTO acceptance_webhook_endpoints(id,project_id,url,secret,events_json,created_at,updated_at)
          VALUES ('${project}','${project}','https://93.184.216.34/hooks','test-secret','[]',1,1);
        INSERT INTO acceptance_integration_events(id,project_id,review_id,subject,gate,revision,sequence,state,manifest_hash,payload_json,occurred_at,received_at)
          VALUES ('${project}','${project}','review','subject','acceptance',1,1,'pending','hash','{}','2026-09-10',1);
        INSERT INTO acceptance_webhook_deliveries(id,webhook_id,project_id,event_id,project_sequence,payload_json,next_attempt_at,created_at,updated_at)
          VALUES ('${project}','${project}','${project}','${project}',1,'{}',0,1,1);
      `);
    }
    const requests: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL, init: RequestInit) => {
      requests.push(init);
      return new Response("ok");
    }));
    const env = {
      DB: fixture.db, PUBLIC_ORIGIN: "https://nib.test", ACCEPTANCE_ENABLED: "true",
      ACCEPTANCE_PILOT_ACCOUNT_IDS: "owner", ACCEPTANCE_PILOT_PROJECT_IDS: "z-pilot",
    } as unknown as AcceptanceIntegrationEnv;
    await deliverQueuedCustomerWebhooks(env, undefined, 1);
    const sent = requests.filter(request => request.method === "POST");
    expect(sent).toHaveLength(1);
    expect(new Headers(sent[0]!.headers).get("x-nib-project")).toBe("z-pilot");
    expect(fixture.sqlite.prepare("SELECT state FROM acceptance_webhook_deliveries WHERE id = ?").get("a-outside")?.state).toBe("queued");
    expect(fixture.sqlite.prepare("SELECT state FROM acceptance_webhook_deliveries WHERE id = ?").get("z-pilot")?.state).toBe("delivered");
  } finally {
    fixture.sqlite.close();
  }
});
