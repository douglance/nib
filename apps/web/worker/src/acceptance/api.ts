import { verifiedAccount, type NibAccount } from "../account-auth";
import type { Env } from "../types";
import type { AcceptanceCoordinator } from "./coordinator";
import { validateAcceptanceManifest, type AcceptanceReview } from "./contracts";
import {
  authenticateAutomation, getProjectAccess, getProjectSettings,
  handleTeamRoutes, listEligibleReviewers,
} from "./teams";
import { assertGithubPublication, assertGithubVerification, authenticateGithubWorkflow, handleIntegrationRoutes, refreshGitHubChecksForReview } from "./integrations";
import { acceptanceJwksResponse } from "./receipts";
import { acceptancePage } from "./pages";
import { evidenceResponse, uploadEvidence, validateStoredEvidence } from "./evidence";
import { readProjectMetrics, recordAcceptanceMetric } from "./metrics";
import { hasFreshProviderVerification, recordProviderVerification } from "./provider-verification";
import { AcceptanceHttpError, acceptanceErrorResponse, acceptanceJson, assertSameOrigin, jsonBody, mutationKey } from "./http";
import { acceptancePilotEnabled, assertPilotAccount, assertPilotProject, isPilotAccountAllowed } from "./pilot";

const PREFIX = "/api/acceptance/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AcceptanceApiEnv = Env & {
  ACCEPTANCE_ENABLED?: string;
  ACCEPTANCE: DurableObjectNamespace<AcceptanceCoordinator>;
};

export async function handleAcceptanceRequest(request: Request, env: AcceptanceApiEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const page = url.pathname === "/acceptance" || url.pathname.startsWith("/acceptance/");
  const api = url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`);
  const keys = url.pathname === "/.well-known/acceptance-jwks.json";
  if (!page && !api && !keys) return null;
  try {
    if (keys) {
      if (request.method !== "GET") throw new AcceptanceHttpError(405, "method_not_allowed", "Use GET.");
      return acceptanceJwksResponse(env);
    }
    // Record signed revocations and head changes even while interactive acceptance is paused.
    if (url.pathname === `${PREFIX}/github/webhook` && request.method === "POST") {
      const webhook = await handleIntegrationRoutes(request, env, null);
      if (webhook) return webhook;
    }
    if (env.ACCEPTANCE_ENABLED !== "true") {
      return acceptanceJson({ satisfied: false, error: { code: "acceptance_disabled", message: "Acceptance is disabled. This gate cannot pass." } }, 503);
    }
    const account = await verifiedAccount(request, env) ?? null;
    if (account) assertPilotAccount(env, account.id);
    const requestedProject = url.pathname.match(/\/(?:api\/acceptance\/v1|acceptance)\/projects\/([^/]+)/)?.[1];
    if (requestedProject) assertPilotProject(env, decodeURIComponent(requestedProject));
    if (page) return await handlePage(request, env, account);
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (mutating) assertSameOrigin(request);

    // The integration handler verifies public GitHub signatures/OIDC before granting any authority.
    const integration = await handleIntegrationRoutes(request, env, account);
    if (integration) return integration;

    const parts = url.pathname.slice(PREFIX.length).split("/").filter(Boolean);
    if (parts[0] !== "projects" || !parts[1] || !UUID.test(parts[1])) {
      if (!account) throw new AcceptanceHttpError(401, "sign_in_required", "Sign in to manage your team.");
      if (mutating) mutationKey(request);
      return await handleTeamRoutes(request, env, account) ?? acceptanceJson({ error: { code: "not_found", message: "Not found" } }, 404);
    }

    const projectId = parts[1];
    const section = parts[2];
    if (!["reviews", "current", "evidence", "metrics"].includes(section || "")) {
      if (!account) throw new AcceptanceHttpError(401, "sign_in_required", "Sign in to manage the project.");
      if (mutating) mutationKey(request);
      return await handleTeamRoutes(request, env, account) ?? acceptanceJson({ error: { code: "not_found", message: "Not found" } }, 404);
    }
    const action = parts[4];
    const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const automation = !account && token
      ? await authenticateAutomation(env.DB, token) ?? await authenticateGithubWorkflow(env.DB, token)
      : null;
    if (automation && automation.projectId !== projectId) throw new AcceptanceHttpError(403, "project_forbidden", "This credential is scoped to a different project.");
    const access = account ? await getProjectAccess(env.DB, projectId, account.id) : null;
    const settings = await getProjectSettings(env.DB, projectId);
    if (!settings) throw new AcceptanceHttpError(404, "project_not_found", "Project not found.");
    const publicRead = !acceptancePilotEnabled(env) && !access && !automation && settings.publicRead && request.method === "GET" &&
      ((section === "reviews" && parts.length === 4) || (section === "evidence" && parts.length === 4));
    if (!account && !automation && !publicRead) throw new AcceptanceHttpError(401, "sign_in_required", "Sign in to access this review.");
    if (account && !access && !publicRead) throw new AcceptanceHttpError(403, "project_forbidden", "You do not have access to this project.");
    if (!settings.enabled) return acceptanceJson({ satisfied: false, error: { code: "project_disabled", message: "This project's acceptance gate is disabled and cannot pass." } }, 503);
    const canRead = !!access?.permissions.read || !!automation?.scopes.includes("read") || publicRead;
    const canPublish = !!access?.permissions.publish || !!automation?.scopes.includes("publish");
    const canVerify = !!access?.permissions.read || !!automation?.scopes.includes("verify");
    const actorId = account?.id || automation?.id || "public";
    const coordinator = env.ACCEPTANCE.get(env.ACCEPTANCE.idFromName(`project:${projectId}`));
    const requirePermission = (allowed: boolean) => {
      if (!allowed) throw new AcceptanceHttpError(403, "permission_denied", "Your project role does not allow this operation.");
    };

    if (section === "metrics" && request.method === "GET" && parts.length === 3) {
      requirePermission(!!account && !!access?.permissions.manage);
      return acceptanceJson(await readProjectMetrics(env.DB, projectId));
    }

    if (section === "evidence") {
      if (request.method === "POST" && parts.length === 3) {
        requirePermission(canPublish);
        mutationKey(request);
        return await uploadEvidence(request, env, projectId, actorId);
      }
      if (request.method === "GET" && parts.length === 4) {
        requirePermission(canRead);
        return await evidenceResponse(env, projectId, parts[3]!);
      }
      throw new AcceptanceHttpError(405, "method_not_allowed", "Use POST to upload evidence or GET to read it.");
    }
    const eligible = publicRead ? undefined : (await listEligibleReviewers(env.DB, projectId)).filter(id => isPilotAccountAllowed(env, id));
    if (section === "current" && request.method === "GET" && parts.length === 3) {
      requirePermission(canRead || canVerify);
      const subject = url.searchParams.get("subject");
      const gate = url.searchParams.get("gate");
      if (!subject || !gate) throw new AcceptanceHttpError(400, "subject_and_gate_required", "Specify subject and gate.");
      const current = await coordinator.getCurrent(subject, gate, eligible);
      return acceptanceJson(canRead || !current ? current : {
        reviewId: current.id, revision: current.revision, subject: current.subject, gate: current.gate,
        manifestHash: current.manifestHash, state: current.state,
      });
    }
    if (section !== "reviews") throw new AcceptanceHttpError(404, "not_found", "Not found.");
    if (parts.length === 3) {
      if (request.method === "GET") {
        requirePermission(canRead);
        return acceptanceJson({ reviews: await coordinator.listReviews(eligible), access });
      }
      if (request.method === "POST") {
        requirePermission(canPublish);
        const key = mutationKey(request);
        const body = await jsonBody(request);
        const manifest = validateAcceptanceManifest(body.manifest);
        if (manifest.projectId !== projectId) throw new AcceptanceHttpError(400, "project_mismatch", "The packet must identify this project.");
        if (automation) await assertGithubPublication(env, automation, manifest);
        await validateStoredEvidence(manifest, env, projectId);
        const result = await coordinator.publish(manifest, {
          actorId, eligibleReviewers: eligible!,
          policy: { quorum: settings.quorum, ttlSeconds: settings.ttlSeconds },
        }, key);
        await recordAcceptanceMetric(env, { eventType: "review_published", projectId, reviewId: result.id,
          actorId, idempotencyKey: key, revision: result.revision,
          occurredAt: Math.floor(Date.parse(result.createdAt) / 1000) });
        return acceptanceJson({ ...result, reviewUrl: reviewUrl(env, projectId, result.id) }, 201);
      }
      throw new AcceptanceHttpError(405, "method_not_allowed", "Use GET or POST.");
    }
    const reviewId = parts[3]!;
    if (!UUID.test(reviewId) || parts.length > 5) throw new AcceptanceHttpError(404, "not_found", "Review not found.");
    if (!action && request.method === "GET") {
      requirePermission(canRead);
      const result = await coordinator.getReview(reviewId, eligible);
      if (!result) throw new AcceptanceHttpError(404, "review_not_found", "Review not found.");
      return acceptanceJson(publicRead ? publicReview(result) : {
        ...result, access: access ? { role: access.role, permissions: access.permissions } : { role: "automation", permissions: { read: canRead, publish: canPublish, review: false, manage: false } },
        currentUser: account ? { id: account.id, email: account.email } : null,
      });
    }
    if (action === "export" && request.method === "GET") {
      requirePermission(canRead && !publicRead);
      const result = await coordinator.getReview(reviewId, eligible);
      if (!result) throw new AcceptanceHttpError(404, "review_not_found", "Review not found.");
      return acceptanceJson({ contract: "nib.acceptance.export/v1", review: result, evidence: result.manifest.evidence });
    }
    if (request.method !== "POST") throw new AcceptanceHttpError(405, "method_not_allowed", "Use POST for this operation.");
    const key = mutationKey(request);
    const body = await jsonBody(request);
    if (action === "verify") {
      requirePermission(canVerify);
      if (typeof body.manifestHash !== "string" || !/^[a-f0-9]{64}$/.test(body.manifestHash)) throw new AcceptanceHttpError(400, "manifest_hash_required", "Supply the expected packet SHA-256.");
      const expected = {
        manifestHash: body.manifestHash,
        ...(typeof body.commit === "string" ? { commit: body.commit } : {}),
        ...(typeof body.subject === "string" ? { subject: body.subject } : {}),
        ...(typeof body.gate === "string" ? { gate: body.gate } : {}),
      };
      const result = await coordinator.verify(reviewId, expected, eligible);
      if (!result.satisfied) return acceptanceJson(result);
      const review = await coordinator.getReview(reviewId, eligible);
      if (!review) throw new AcceptanceHttpError(404, "review_not_found", "Review not found.");
      if (automation) await assertGithubVerification(env, automation, review.manifest);
      if (body.deploymentVerification !== undefined) {
        await recordProviderVerification(env.DB, review, automation, body.deploymentVerification, key);
        await refreshGitHubChecksForReview(env, projectId, reviewId);
      }
      if (!(await hasFreshProviderVerification(env.DB, review))) {
        return acceptanceJson({ ...result, satisfied: false, reason: "cloudflare_current_version_unverified" });
      }
      return acceptanceJson(await coordinator.verify(reviewId, expected, eligible));
    }
    if (action === "decisions") {
      requirePermission(!!account && !!access?.permissions.review);
      const result = await coordinator.decide(reviewId, {
        decision: body.decision as "approve" | "reject" | "request_revision",
        comment: typeof body.comment === "string" ? body.comment : undefined,
        criteriaIds: body.criteriaIds as string[],
      }, { actorId, eligibleReviewers: eligible! }, key);
      await recordAcceptanceMetric(env, { eventType: "review_decision_recorded", projectId, reviewId,
        actorId, idempotencyKey: key, revision: result.revision,
        decision: body.decision as "approve" | "reject" | "request_revision" });
      return acceptanceJson(result);
    }
    if (action === "comments") {
      requirePermission(!!account && !!access?.permissions.review);
      if (typeof body.text !== "string") throw new AcceptanceHttpError(400, "comment_required", "Supply a comment.");
      return acceptanceJson(await coordinator.comment(reviewId, body.text, actorId, key));
    }
    if (action === "preview-open") {
      requirePermission(!!account && !!access?.permissions.read);
      const result = await coordinator.openPreview(reviewId, actorId, key);
      await recordAcceptanceMetric(env, { eventType: "preview_opened", projectId, reviewId, actorId, idempotencyKey: key });
      return acceptanceJson(result);
    }
    if (action === "viewed") {
      requirePermission(!!account && !!access?.permissions.read);
      const result = await coordinator.getReview(reviewId, eligible);
      if (!result) throw new AcceptanceHttpError(404, "review_not_found", "Review not found.");
      await recordAcceptanceMetric(env, { eventType: "review_page_viewed", projectId, reviewId, actorId, idempotencyKey: key });
      return acceptanceJson({ recorded: true });
    }
    if (action === "invalidate") {
      requirePermission(!!account && !!access?.permissions.manage);
      if (typeof body.reason !== "string") throw new AcceptanceHttpError(400, "reason_required", "Explain why this approval is invalid.");
      return acceptanceJson(await coordinator.invalidate(reviewId, body.reason, actorId, key));
    }
    throw new AcceptanceHttpError(404, "not_found", "Not found.");
  } catch (error) { return acceptanceErrorResponse(error); }
}

async function handlePage(request: Request, env: AcceptanceApiEnv, account: NibAccount | null): Promise<Response> {
  if (request.method !== "GET") throw new AcceptanceHttpError(405, "method_not_allowed", "Use GET.");
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/acceptance\/projects\/([a-f0-9-]+)\/reviews\/([a-f0-9-]+)$/i);
  if (!account) {
    if (!acceptancePilotEnabled(env) && match && UUID.test(match[1]!) && UUID.test(match[2]!)) {
      const settings = await getProjectSettings(env.DB, match[1]!);
      if (settings?.enabled && settings.publicRead) return acceptancePage(request) ?? new Response("Not found", { status: 404 });
    }
    const signIn = new URL("/auth/sign-in", url.origin);
    signIn.searchParams.set("returnTo", url.pathname + url.search);
    return Response.redirect(signIn, 302);
  }
  return acceptancePage(request) ?? new Response("Not found", { status: 404 });
}

function reviewUrl(env: AcceptanceApiEnv, projectId: string, id: string): string {
  return new URL(`/acceptance/projects/${projectId}/reviews/${id}`, env.PUBLIC_ORIGIN).toString();
}

function publicReview(review: AcceptanceReview): Record<string, unknown> {
  return {
    id: review.id, projectId: review.projectId, subject: review.subject, gate: review.gate,
    revision: review.revision, manifest: review.manifest, manifestHash: review.manifestHash,
    state: review.state, policy: review.policy, createdAt: review.createdAt, expiresAt: review.expiresAt,
    approvalCount: review.votes.filter(vote => vote.decision === "approve").length,
    readOnly: true,
  };
}
