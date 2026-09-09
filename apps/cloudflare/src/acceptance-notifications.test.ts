import { describe, expect, it } from "vitest";
import { acceptanceNotification, acceptanceNotificationPayload } from "./acceptance-notifications";

const projectId = "11111111-1111-4111-8111-111111111111";
const reviewId = "22222222-2222-4222-8222-222222222222";
const input = {
  eventId: "event-1", projectId, reviewId, title: "Account access", change: "Members can see assigned projects",
  state: "pending", revision: 1, sequence: 1,
  reviewUrl: `https://nibtool.com/acceptance/projects/${projectId}/reviews/${reviewId}`,
  expiresAt: "2026-09-16T00:00:00.000Z",
};

describe("acceptance inbox notification", () => {
  it("uses one canonical review id and a web-only response path", () => {
    const notification = acceptanceNotification(input, "https://nibtool.com");
    const payload = acceptanceNotificationPayload(notification);
    expect(payload).toMatchObject({ type: "acceptance-review", requestId: reviewId, url: input.reviewUrl, choices: [], allowText: false });
    expect(payload).not.toHaveProperty("responseUrl");
  });
  it("uses silent resolution for terminal states", () => {
    expect(acceptanceNotificationPayload(acceptanceNotification({ ...input, state: "approved" }, "https://nibtool.com")))
      .toMatchObject({ type: "request-resolved", requestId: reviewId, status: "approved" });
  });
  it.each([
    { reviewUrl: "https://evil.example/acceptance" },
    { reviewUrl: `https://nibtool.com/acceptance/projects/${projectId}/reviews/other` },
    { reviewUrl: input.reviewUrl + "?redirect=https://evil.example" },
    { state: "invented" }, { sequence: -1 }, { revision: 0 }, { projectId: "../other" },
  ])("rejects malformed or unbound notification metadata %s", (change) => {
    expect(() => acceptanceNotification({ ...input, ...change }, "https://nibtool.com")).toThrow();
  });
});
