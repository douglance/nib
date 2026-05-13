const CACHE_NAME = "prtl-shell-v3";
const SHELL_ASSETS = ["/", "/manifest.webmanifest", "/icons/prtl.svg", "/icons/prtl-192.png", "/icons/prtl-512.png"];

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
  const title = data.title || (data.projectName ? `Feedback: ${data.projectName}` : "Feedback request");
  const body = data.request || data.body || "Tap to give feedback.";
  const options = {
    body,
    tag: data.feedbackId ? `feedback:${data.feedbackId}` : "prtl-feedback",
    renotify: Boolean(data.feedbackId),
    requireInteraction: Boolean(data.feedbackId),
    timestamp: data.createdAt ? new Date(data.createdAt).getTime() : Date.now(),
    data,
    icon: "/icons/prtl-192.png",
    badge: "/icons/prtl-192.png",
    actions: data.feedbackId ? [{ action: "open-feedback", title: "Give feedback" }] : []
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || "/";
  const feedbackId = data.feedbackId;
  event.waitUntil(
    (async () => {
      if (feedbackId) {
        try {
          await fetch(`/api/feedback/${encodeURIComponent(feedbackId)}/notification-click`, { method: "POST" });
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
