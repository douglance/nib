const CACHE_NAME = "nib-shell-v5";
const SHELL_ASSETS = ["/", "/manifest.webmanifest", "/icons/nib-192.png", "/icons/nib-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/p/")) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (event.request.method === "GET" && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/")))
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || (data.projectName ? `Feedback: ${data.projectName}` : "nib request");
  const body = data.request || data.body || "Tap to give feedback.";
  const tag = data.feedbackId ? `feedback:${data.feedbackId}` : data.tag || (data.requestId ? `request:${data.requestId}` : "nib-request");
  const actions = notificationActions(data);
  const options = {
    body,
    tag,
    renotify: data.renotify !== undefined ? Boolean(data.renotify) : Boolean(data.feedbackId || data.requestId),
    requireInteraction: data.requireInteraction !== undefined ? Boolean(data.requireInteraction) : Boolean(data.feedbackId || data.requestId),
    timestamp: data.createdAt ? new Date(data.createdAt).getTime() : Date.now(),
    data,
    icon: "/icons/nib-192.png",
    badge: "/icons/nib-192.png",
    actions
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const action = event.action || "open-request";
  const url = data.url || "/";
  const feedbackId = data.feedbackId;
  const requestId = data.requestId;
  event.waitUntil(
    (async () => {
      if (requestId && action.startsWith("choice:")) {
        const choiceIndex = Number(action.slice("choice:".length));
        if (Number.isInteger(choiceIndex)) {
          try {
            await fetch(`/api/requests/${encodeURIComponent(requestId)}/respond`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                choiceIndex,
                deviceId: data.deviceId || "web-notification",
                notificationResponse: true
              })
            });
            return;
          } catch {
            // Fall through to opening the app; the user can still answer there.
          }
        }
      }
      if (feedbackId) {
        try {
          await fetch(`/api/feedback/${encodeURIComponent(feedbackId)}/notification-click`, { method: "POST" });
        } catch {
          // Ignore analytics failures; opening the app is the priority.
        }
      }
      if (requestId) {
        try {
          await fetch(`/api/requests/${encodeURIComponent(requestId)}/notification-click`, { method: "POST" });
        } catch {
          // Ignore analytics failures; opening the app is the priority.
        }
      }
      const clientsList = await clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientsList) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) return client.navigate(url);
          return;
        }
      }
      return clients.openWindow(url);
    })()
  );
});

function notificationActions(data) {
  if (!data.feedbackId && !data.requestId) return [];
  const actions = [];
  if (data.requestId && Array.isArray(data.choices)) {
    for (const [index, choice] of data.choices.slice(0, 2).entries()) {
      if (typeof choice === "string" && choice.trim()) {
        actions.push({ action: `choice:${index}`, title: choice.slice(0, 24) });
      }
    }
  }
  actions.push({ action: "open-request", title: "Open" });
  return actions.slice(0, 3);
}
