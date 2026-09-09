import { describe, expect, it } from "vitest";
import { acceptancePage } from "./pages";

async function html(path: string, init?: RequestInit): Promise<string> {
  const response = acceptancePage(new Request(`https://nib.example.com${path}`, init));
  expect(response).not.toBeNull();
  expect(response?.headers.get("content-type")).toContain("text/html");
  expect(response?.headers.get("cache-control")).toBe("private, no-store");
  return response!.text();
}

describe("acceptance pages", () => {
  it("serves the administration shell only on the acceptance route", async () => {
    const body = await html("/acceptance");

    expect(body).toContain("Team and project controls");
    expect(body).toContain("/api/acceptance/v1");
    expect(body).toContain("data-mutation=\"create-team\"");
    expect(body).toContain("data-mutation=\"github-save\"");
    expect(body).toContain("Repository ownership proof");
    expect(body).toContain("type=\"password\" name=\"ownershipOidcToken\" required");
    expect(body).toContain("data-mutation=\"evidence-upload\"");
    expect(body).toContain("data-mutation=\"team-archive\"");
    expect(body).toContain("data-mutation=\"project-archive\"");
    expect(body).toContain("data-mutation=\"invitation-accept\"");
    expect(body).toContain("Project usage");
    expect(body).toContain("/metrics");
    expect(body).toContain("Public read-only review links");
    expect(body).toContain("TTL days");
    expect(body).toContain("max=\"7\"");
    expect(body).toContain("/api/auth/session");
    expect(acceptancePage(new Request("https://nib.example.com/account"))).toBeNull();
  });

  it("embeds project and review IDs for the review shell", async () => {
    const body = await html("/acceptance/projects/project-a/reviews/review-b");

    expect(body).toContain("\"name\":\"review\"");
    expect(body).toContain("\"projectId\":\"project-a\"");
    expect(body).toContain("\"reviewId\":\"review-b\"");
    expect(body).toContain("Open exact preview");
    expect(body).toContain("Approval requires acknowledging every criterion");
    expect(body).toContain("Quorum and history");
  });

  it("does not serve mutating methods as pages", () => {
    expect(
      acceptancePage(new Request("https://nib.example.com/acceptance", {
        method: "POST",
      })),
    ).toBeNull();
  });

  it("keeps mutations idempotent and surfaces real API errors", async () => {
    const body = await html("/acceptance/projects/project-a/reviews/review-b");

    expect(body).toContain("\"Idempotency-Key\": idempotencyKey(method, path)");
    expect(body).toContain("payload?.error?.message");
    expect(body).toContain("Approve requires every criterion to be acknowledged.");
    expect(body).toContain("/preview-open");
    expect(body).toContain("/viewed");
    expect(body).toContain("/invalidate");
    expect(body).toContain("viewedReviewAttempts");
    expect(body).toContain("state.viewedReviewKeys[key]");
    expect(body).toContain("\"X-Nib-Filename\": filename");
    expect(body).toContain("\"content-type\": contentType");
    expect(body).not.toContain("fake success");
    expect(body).not.toContain("mock");
  });

  it("renders read-only review states in the client shell", async () => {
    const body = await html("/acceptance/projects/project-a/reviews/review-b");

    expect(body).toContain("terminalStates");
    expect(body).toContain("review.readOnly");
    expect(body).toContain("review.access?.permissions?.review");
    expect(body).toContain("review.access?.permissions?.manage");
    expect(body).toContain("canRecordPreview");
    expect(body).toContain("This review is read-only.");
    expect(body).toContain("A newer packet revision replaced this review.");
    expect(body).toContain("current verification fails closed");
  });

  it("matches the team, project, webhook, GitHub, and invitation API contracts", async () => {
    const body = await html("/acceptance?invitation=invite-token");

    expect(body).toContain("/teams/\" + enc(form.dataset.teamId || teamId)");
    expect(body).toContain("quorum: Number(body.quorum || 1), ttlSeconds: ttlDays * 86400");
    expect(body).toContain("/invitations/\" + enc(form.dataset.token) + \"/accept");
    expect(body).toContain("/integrations/webhooks");
    expect(body).toContain("events: linesToArray(body.events)");
    expect(body).toContain("formatDuration(first.decisionAfterPublishSeconds)");
    expect(body).toContain("method: \"PUT\", path: api + \"/projects/\" + enc(projectId) + \"/integrations/github\"");
    expect(body).toContain("ownershipOidcToken: body.ownershipOidcToken");
    expect(body).toContain("/integrations/github?repositoryId=");
    expect(body).not.toContain("/projects/\" + enc(projectId) + \"/webhooks");
    expect(body).not.toContain("policy: { quorum: Number(body.quorum || 1)");
  });
});
