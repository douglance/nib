import type { Env } from "../types";
import type { AcceptanceEvent } from "./contracts";
import { getProjectSettings, listProjectRecipients } from "./teams";
import { isPilotAccountAllowed, isPilotProjectAllowed } from "./pilot";

type NotificationEnv = Env;
type MailSender = (env: NotificationEnv, email: string, title: string, body: string, messageId: string) => Promise<void>;

export async function deliverAcceptanceNotifications(event: AcceptanceEvent, env: NotificationEnv, sendMail: MailSender = sendAcceptanceMail): Promise<void> {
  if (!isPilotProjectAllowed(env, event.projectId)) return;
  const settings = await getProjectSettings(env.DB, event.projectId);
  if (!settings || !settings.enabled || env.ACCEPTANCE_ENABLED !== "true") return;
  const coordinator = env.ACCEPTANCE.get(env.ACCEPTANCE.idFromName(`project:${event.projectId}`));
  const review = await coordinator.getReview(event.reviewId);
  if (!review || review.state !== event.state || review.manifestHash !== event.manifestHash) return;
  const recipients = (await listProjectRecipients(env.DB, event.projectId)).filter(recipient => isPilotAccountAllowed(env, recipient.accountId));
  const link = new URL(`/acceptance/projects/${event.projectId}/reviews/${event.reviewId}`, env.PUBLIC_ORIGIN).toString();
  const title = review.state === "pending" ? `Review requested: ${review.manifest.title}` : `Review ${stateLabel(review.state)}: ${review.manifest.title}`;
  const body = `${review.manifest.change}\n\n${review.state === "pending" ? "Open the exact preview, check the requested behavior, and record your decision." : `The review is ${stateLabel(review.state)}.`}\n\n${link}\n\nThis decision applies to revision ${review.revision} and its recorded build. The connected workflow determines what happens next.`;
  // Comments and preview-open events do not produce another notification for the same state.
  const notificationId = `${review.id}:${review.state}`;
  const outcomes = await Promise.allSettled(recipients.flatMap(recipient => [
    withDelivery(env, notificationId, event.projectId, recipient.accountId, "email", () => sendMail(env, recipient.email, title, body, `${notificationId}:${recipient.accountId}`)),
    withDelivery(env, notificationId, event.projectId, recipient.accountId, "devices", async () => {
      const response = await env.REVIEW.fetch(new Request("https://nib.internal/api/acceptance-notifications", {
        method: "POST", headers: { "content-type": "application/json", "x-nib-account-id": recipient.accountId, "idempotency-key": notificationId },
        body: JSON.stringify({ eventId: event.id, projectId: event.projectId, reviewId: event.reviewId,
          title: review.manifest.title, change: review.manifest.change, state: review.state,
          revision: review.revision, sequence: event.sequence, reviewUrl: link, expiresAt: review.expiresAt }),
      }));
      if (!response.ok) throw new Error(`Device inbox delivery returned ${response.status}`);
    }),
  ]));
  const failed = outcomes.filter(result => result.status === "rejected");
  if (failed.length) throw new Error(`${failed.length} acceptance notification deliveries need retry`);
}

async function withDelivery(env: NotificationEnv, eventId: string, projectId: string, accountId: string, channel: string, send: () => Promise<void>): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO acceptance_notification_deliveries(event_id,project_id,account_id,channel) VALUES (?,?,?,?)")
    .bind(eventId, projectId, accountId, channel).run();
  const claimed = await env.DB.prepare(`UPDATE acceptance_notification_deliveries SET lease_until = unixepoch() + 120, attempts = attempts + 1
    WHERE event_id = ? AND account_id = ? AND channel = ? AND delivered_at IS NULL AND lease_until <= unixepoch() RETURNING event_id`)
    .bind(eventId, accountId, channel).first();
  if (!claimed) {
    const row = await env.DB.prepare("SELECT delivered_at FROM acceptance_notification_deliveries WHERE event_id = ? AND account_id = ? AND channel = ?")
      .bind(eventId, accountId, channel).first<{ delivered_at: number | null }>();
    if (row?.delivered_at) return;
    throw new Error("Acceptance notification delivery is already in progress");
  }
  try {
    await send();
    await env.DB.prepare("UPDATE acceptance_notification_deliveries SET delivered_at = unixepoch(), lease_until = 0, last_error = NULL WHERE event_id = ? AND account_id = ? AND channel = ?")
      .bind(eventId, accountId, channel).run();
  } catch (error) {
    await env.DB.prepare("UPDATE acceptance_notification_deliveries SET lease_until = 0, last_error = ? WHERE event_id = ? AND account_id = ? AND channel = ?")
      .bind(error instanceof Error ? error.message.slice(0, 500) : "Delivery failed", eventId, accountId, channel).run();
    throw error;
  }
}

export function acceptanceMail(email: string, title: string, body: string, messageId: string): string {
  if (/[\r\n]/.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Invalid notification recipient");
  const subject = title.replace(/[\r\n]/g, " ").slice(0, 180);
  const encodedSubject = btoa(String.fromCharCode(...new TextEncoder().encode(subject)));
  return ["From: Nib <login@nibtool.com>", `To: ${email}`, `Subject: =?UTF-8?B?${encodedSubject}?=`,
    `Message-ID: <${messageId.replace(/[^a-zA-Z0-9:._-]/g, "_")}@nibtool.com>`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "",
    btoa(String.fromCharCode(...new TextEncoder().encode(body))).match(/.{1,76}/g)?.join("\r\n") || "", "",
  ].join("\r\n");
}

async function sendAcceptanceMail(env: NotificationEnv, email: string, title: string, body: string, messageId: string): Promise<void> {
  const { EmailMessage } = await import("cloudflare:email");
  await env.EMAIL.send(new EmailMessage("login@nibtool.com", email, acceptanceMail(email, title, body, messageId)));
}

function stateLabel(state: string): string {
  return ({ revision_requested: "awaiting revision", superseded: "superseded", invalidated: "invalidated", expired: "expired", rejected: "rejected", approved: "approved" } as Record<string, string>)[state] || state;
}
