import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadWorker() {
  const listeners = new Map();
  const shownNotifications = [];
  const fetches = [];
  const openedWindows = [];
  const focusedClients = [];
  const clientsApi = {
    claim: async () => {},
    matchAll: async () => [],
    openWindow: async (url) => {
      openedWindows.push(url);
    }
  };
  const cacheApi = {
    open: async () => ({
      addAll: async () => {},
      put: async () => {}
    }),
    keys: async () => [],
    delete: async () => true,
    match: async () => null
  };
  const context = {
    self: {
      location: new URL("https://nib.test/"),
      clients: clientsApi,
      registration: {
        showNotification: async (title, options) => {
          shownNotifications.push({ title, options });
        }
      },
      skipWaiting: () => {},
      addEventListener: (type, handler) => {
        listeners.set(type, handler);
      }
    },
    caches: cacheApi,
    clients: clientsApi,
    fetch: async (url, options) => {
      fetches.push({ url: String(url), options });
      return { ok: true, clone: () => ({ ok: true }) };
    },
    focusedClients,
    URL,
    Date,
    Number,
    Boolean,
    Promise,
    encodeURIComponent
  };
  context.globalThis = context;
  vm.runInNewContext(await readFile("public/sw.js", "utf8"), context, { filename: "public/sw.js" });
  return { clientsApi, fetches, focusedClients, listeners, openedWindows, shownNotifications };
}

async function dispatch(listeners, type, event) {
  const waits = [];
  event.waitUntil = (promise) => {
    waits.push(Promise.resolve(promise));
  };
  listeners.get(type)(event);
  await Promise.all(waits);
}

test("web push notification shows quick-choice actions before open", async () => {
  const worker = await loadWorker();
  await dispatch(worker.listeners, "push", {
    data: {
      json: () => ({
        requestId: "req_123",
        title: "Need approval",
        request: "Deploy the current branch?",
        choices: ["Approve", "Hold", "Escalate"]
      })
    }
  });

  assert.equal(worker.shownNotifications.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(worker.shownNotifications[0].options.actions)), [
    { action: "choice:0", title: "Approve" },
    { action: "choice:1", title: "Hold" },
    { action: "open-request", title: "Open" }
  ]);
});

test("web notification choice responds without opening the app", async () => {
  const worker = await loadWorker();
  let closed = false;
  await dispatch(worker.listeners, "notificationclick", {
    action: "choice:1",
    notification: {
      data: { requestId: "req 123", url: "/requests/req_123", deviceId: "web-device-123" },
      close: () => {
        closed = true;
      }
    }
  });

  assert.equal(closed, true);
  assert.equal(worker.openedWindows.length, 0);
  assert.equal(worker.fetches.length, 1);
  assert.equal(worker.fetches[0].url, "/api/requests/req%20123/respond");
  assert.equal(worker.fetches[0].options.method, "POST");
  assert.deepEqual(JSON.parse(worker.fetches[0].options.body), {
    choiceIndex: 1,
    deviceId: "web-device-123",
    notificationResponse: true
  });
});

test("web notification open marks clicks and opens the target URL", async () => {
  const worker = await loadWorker();
  await dispatch(worker.listeners, "notificationclick", {
    action: "open-request",
    notification: {
      data: { feedbackId: "fb_123", requestId: "req_123", url: "/view/project-1" },
      close: () => {}
    }
  });

  assert.deepEqual(
    worker.fetches.map((fetchCall) => [fetchCall.url, fetchCall.options?.method]),
    [
      ["/api/feedback/fb_123/notification-click", "POST"],
      ["/api/requests/req_123/notification-click", "POST"]
    ]
  );
  assert.deepEqual(worker.openedWindows, ["/view/project-1"]);
});
