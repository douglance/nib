import type { Env } from "../types";
import type { AcceptanceEvent } from "./contracts";
import { deliverAcceptanceEvent, deliverQueuedCustomerWebhooks } from "./integrations";
import { deliverAcceptanceNotifications } from "./notifications";

export async function consumeAcceptanceEvents(batch: MessageBatch<AcceptanceEvent>, env: Env): Promise<void> {
  await Promise.all(batch.messages.map(async message => {
    const results = await Promise.allSettled([
      deliverAcceptanceEvent(message.body, env),
      deliverAcceptanceNotifications(message.body, env),
    ]);
    if (results.some(result => result.status === "rejected")) {
      console.error("Acceptance event delivery will retry", { eventId: message.body.id,
        failures: results.filter(result => result.status === "rejected").map(result => (result as PromiseRejectedResult).reason instanceof Error ? (result as PromiseRejectedResult).reason.message : "delivery failed") });
      message.retry({ delaySeconds: 30 });
    } else message.ack();
  }));
  await deliverQueuedCustomerWebhooks(env);
}
