import type { NibAccount } from "../account-auth";
import type { AcceptanceChangedEvent, AcceptanceIntegrationEnv } from "./common";
import {
  assertGithubPublication,
  assertGithubVerification,
  authenticateGithubWorkflow,
  handleGitHubIntegrationRoute,
  publishGitHubChecksForAcceptanceEvent,
  reconcileGitHubAcceptanceChecks,
  refreshGitHubChecksForReview,
} from "./github";
import {
  deliverQueuedCustomerWebhooks,
  enqueueCustomerWebhooksForAcceptanceEvent,
  handleCustomerWebhookRoutes,
} from "./webhooks";

export type { AcceptanceChangedEvent, AcceptanceIntegrationEnv, AutomationActor } from "./common";
export {
  assertGithubPublication,
  assertGithubVerification,
  authenticateGithubWorkflow,
  deliverQueuedCustomerWebhooks,
  reconcileGitHubAcceptanceChecks,
  refreshGitHubChecksForReview,
};

export async function handleIntegrationRoutes(
  request: Request,
  env: AcceptanceIntegrationEnv,
  account: NibAccount | null,
): Promise<Response | null> {
  const github = await handleGitHubIntegrationRoute(request, env, account);
  if (github) return github;
  return handleCustomerWebhookRoutes(request, env, account);
}

export async function deliverAcceptanceEvent(
  event: AcceptanceChangedEvent,
  env: AcceptanceIntegrationEnv,
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO acceptance_integration_events(
       id, project_id, review_id, subject, gate, revision, sequence, state, manifest_hash, payload_json, occurred_at, received_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
  ).bind(
    event.id,
    event.projectId,
    event.reviewId,
    event.subject,
    event.gate,
    event.revision,
    event.sequence,
    event.state,
    event.manifestHash,
    JSON.stringify(event),
    event.occurredAt,
  ).run();

  const results = await Promise.allSettled([
    runEventSink(env, event.id, "github", () => publishGitHubChecksForAcceptanceEvent(event, env)),
    runEventSink(env, event.id, "webhooks", () => enqueueCustomerWebhooksForAcceptanceEvent(event, env)),
  ]);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}

const EVENT_SINK_LEASE_TIMEOUT_SECONDS = 300;

async function runEventSink(
  env: AcceptanceIntegrationEnv,
  eventId: string,
  sink: string,
  deliver: () => Promise<void>,
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO acceptance_integration_event_sinks(event_id, sink, state, updated_at)
     VALUES (?, ?, 'pending', unixepoch())`,
  ).bind(eventId, sink).run();
  const claim = await env.DB.prepare(
    `UPDATE acceptance_integration_event_sinks
        SET state = 'running',
            attempt_count = attempt_count + 1,
            claimed_at = unixepoch(),
            updated_at = unixepoch()
      WHERE event_id = ?
        AND sink = ?
        AND (
          state IN ('pending', 'failed')
          OR (state = 'running' AND updated_at <= unixepoch() - ?)
        )`,
  ).bind(eventId, sink, EVENT_SINK_LEASE_TIMEOUT_SECONDS).run();
  if (!claim.meta.changes) {
    const existing = await env.DB.prepare(
      "SELECT state FROM acceptance_integration_event_sinks WHERE event_id = ? AND sink = ?",
    ).bind(eventId, sink).first<{ state: string }>();
    if (existing?.state === "done") return;
    throw new Error(`Integration sink ${sink} for event ${eventId} is already in progress`);
  }

  try {
    await deliver();
    await env.DB.prepare(
      `UPDATE acceptance_integration_event_sinks
          SET state = 'done',
              completed_at = unixepoch(),
              last_error = NULL,
              updated_at = unixepoch()
        WHERE event_id = ? AND sink = ?`,
    ).bind(eventId, sink).run();
  } catch (error) {
    await env.DB.prepare(
      `UPDATE acceptance_integration_event_sinks
          SET state = 'failed',
              last_error = ?,
              updated_at = unixepoch()
        WHERE event_id = ? AND sink = ?`,
    ).bind(error instanceof Error ? error.message : "unknown integration delivery error", eventId, sink).run();
    throw error;
  }
}
