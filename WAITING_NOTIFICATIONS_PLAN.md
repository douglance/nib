# Plan: Waiting Notifications — push me when an agent pane is blocked

**Goal:** Get a Web Push notification on my phone the moment one of my tmux Claude-agent
panes is blocked waiting for human input (plan-approval gates, "Enter to select" menus,
confirm prompts), plus a generic trigger so any agent/script can push me too.

## What already exists in prtl (DO NOT rebuild)

prtl is already a PWA with a **complete web-push pipeline**, served over HTTPS via Tailscale
(`PUBLIC_BASE_URL = https://doug-mm.tail5d92b4.ts.net`, `serve:tailscale` = `tailscale serve --bg 4070`),
so push to the phone works today. Reuse all of it:

- `src/server/notifications.ts` — VAPID keygen/persist (`.prtl/push.json`), `subscribeNotifications`,
  `unsubscribeNotifications`, **`sendPushPayload(payload)`** (generic: loops all subs, prunes 404/410),
  `notificationStatus`. The payload shape is already free-form `{type,title,body,url,createdAt,...}`.
- `src/server/index.ts` — routes `/api/notifications/{vapid-public-key,status,subscribe,unsubscribe,test}`
  and helpers `sendJson`, `readJsonBody<T>`.
- `public/sw.js` — `push` + `notificationclick` handlers (currently feedback-shaped).
- `public/manifest.webmanifest`, `public/icons/*` — installable PWA assets.
- `src/client/ui/App.tsx` — the bell: permission + `PushManager.subscribe` flow (around lines 481–560).
- `src/cli/index.ts` — incur CLI; `feedback test-notification` shows the `apiPost(portalBaseUrl(),"/api/notifications/test",{})` pattern.

**The gap:** nothing watches blocked tmux panes, and there is no generic "push me" trigger.

## Reference implementation to port

A working, tested classifier + tmux scanner already exists at
`/Users/douglance/Developer/lv/waiting/` (`detect.mjs`, `detect.test.mjs`, `scanner.mjs`).
Port `detect.mjs` → TypeScript in Step 1; reuse its tmux scan loop in Step 4. That standalone
project becomes redundant once this lands and can be deleted separately (not in scope here).

## Design

Three additions, all riding the existing `sendPushPayload`:
1. **Generic push trigger** — `POST /api/notify` + `prtl notify` CLI (smallest useful win; lets anything ping me).
2. **tmux waiting-watcher** — opt-in producer (`prtl watch`) that detects blocked panes and calls the trigger.
3. **Waiting surface** — `GET /api/waiting` snapshot + a small panel in the portal, and `sw.js` support for the generic payload.

Keys: PORT 4070, session `0`, dev `npm run server` (tsx) / `NODE_ENV=production npm run preview`.

---

## Step 1 — Port the blocked-pane classifier (pure + tested)

Port the pure detector from the reference project to TS. Strong signals ONLY (low noise):
plan-approval gates (`Would you like to proceed?`, `Implement this plan?`), interactive selection
menus (`Enter to select`, `Press enter to confirm or esc to go back`, pointer `❯`/`›` + numbered
choice + a question). NOT waiting: actively working (`Working (`, `Analyzing…`, `Worked for`,
`esc to interrupt`), shell prompts (`➜`, `v22.22.3`), and an empty `❯` input box with no menu.

- **New** `src/server/waiting/detect.ts` — `export function classifyPane(text: string): { waiting: boolean; reason: string }`
- **New** `src/server/waiting/detect.test.ts` — `node:assert` over the 4 waiting / 5 not-waiting
  samples copied from `/Users/douglance/Developer/lv/waiting/detect.test.mjs`. Make it a standalone
  tsx script that `process.exit(1)`s on any assertion failure (repo has no test runner configured).

**Verify (CODE TEST):**
```
cd /Users/douglance/Developer/lv/prtl
npx tsx src/server/waiting/detect.test.ts   # prints "ok 9/9", exit 0
npm run typecheck                            # tsc --noEmit stays green
```

**out_of_scope:** no notification for idle empty-`❯` panes; no changes outside `src/server/waiting/`.

---

## Step 2 — Generic push trigger (module fn + endpoint + CLI)

- **Edit** `src/server/notifications.ts` — add and export:
  `sendNotice(input: { title: string; body: string; url?: string; tag?: string; kind?: string }): Promise<{ sent: number }>`
  → builds `{ type: input.kind ?? "notice", title, body, url: input.url ?? "/", tag: input.tag, requireInteraction: true, renotify: true, createdAt: new Date().toISOString() }`
  and returns `{ sent: await sendPushPayload(payload) }`. Reuse `sendPushPayload` verbatim.
- **Edit** `src/server/index.ts` — add near the `/api/notifications/test` route (~line 267):
  ```ts
  if (url.pathname === "/api/notify" && req.method === "POST") {
    const body = await readJsonBody<{ title?: string; body?: string; url?: string; tag?: string; kind?: string }>(req);
    if (!body.title || !body.body) { sendJson(res, { error: "title and body are required" }, 400); return; }
    sendJson(res, await sendNotice(body as { title: string; body: string; url?: string; tag?: string; kind?: string }));
    return;
  }
  ```
  (import `sendNotice` in the existing `./notifications` import block.)
- **Edit** `src/cli/index.ts` — add a top-level `notify` command following the `feedback.command` pattern:
  `args: z.object({ title: z.string(), body: z.string() })`, `options: z.object({ url: z.string().optional() })`,
  `run: ({args,options}) => apiPost(portalBaseUrl(), "/api/notify", { ...args, url: options.url })`.

**Verify (CODE TEST):**
```
PORT=4070 npm run server &        # tsx src/server/index.ts
sleep 2
curl -s -XPOST localhost:4070/api/notify -H 'content-type: application/json' \
  -d '{"title":"t","body":"b"}'   # -> {"sent":N} (N=0 with no device, no crash)
prtl notify --title t --body b     # -> { sent: N }
npm run typecheck
```

**out_of_scope:** no auth/rate-limit (LAN/Tailscale-only); don't alter feedback push.

---

## Step 3 — Service worker: honor the generic payload

- **Edit** `public/sw.js` `push` handler so non-feedback payloads (`type: "notice"|"waiting"`) use
  `data.tag` (distinct per source so multiple waiting alerts don't collapse), `data.url`,
  `requireInteraction`/`renotify` from data, and the prtl icon. Keep the existing feedback branch
  (`data.feedbackId`) unchanged. Bump `CACHE_NAME` to `prtl-shell-v4`.

**Verify (CODE TEST):**
```
node --check public/sw.js                     # syntax ok
# agent-browser (per AGENTS.md dev workflow):
agent-browser open https://doug-mm.tail5d92b4.ts.net
agent-browser eval "navigator.serviceWorker.getRegistration().then(r=>r&&r.active&&r.active.state)"  # "activated"
agent-browser eval "caches.keys()"            # includes "prtl-shell-v4"
```
Then end-to-end: with the phone subscribed, `prtl notify --title hi --body works` → notification on lock screen.

**out_of_scope:** don't change `fetch`/`activate` caching beyond the version bump.

---

## Step 4 — tmux waiting-watcher producer (opt-in)

- **New** `src/server/waiting/watcher.ts`:
  - `scanOnce(session: string): Promise<WaitingPane[]>` — `tmux has-session -t $session`; if tmux or
    session absent, return `[]` (log once). `tmux list-panes -s -t $session -F '#{window_index}.#{pane_index}|#{window_name}|#{pane_current_command}'`,
    then `tmux capture-pane -p -t $session:$paneId` (last ~25 non-blank lines) → `classifyPane`.
  - `startWatch({ session, intervalMs })` — poll loop; keep `Map<paneId,reason>`; on idle→waiting
    (or changed reason) call `sendNotice({ kind:"waiting", title:\`⏳ ${window} needs you\`,
    body:\`${reason} · pane ${paneId}\`, tag:\`waiting:${paneId}\`, url:"/" })`; clear entry on leaving
    waiting so the next block re-notifies. Maintain exported `getWaiting(): WaitingPane[]` snapshot.
  - `WaitingPane = { paneId: string; window: string; reason: string; since: string }` (add to `src/shared/types.ts`).
- **Edit** `src/cli/index.ts` — add `watch` command: `options: { session=default "0", interval=default 20000,
  once?: boolean, json?: boolean }`. `--once` scans a single pass; `--once --json` prints the detected
  waiting panes and exits WITHOUT pushing (dry detection); plain `watch` runs the loop and pushes.
- Document a launchd/tmux-tab way to keep `prtl watch` running (mirror `scripts/install-launchd.sh`); not required for this plan.

**Verify (CODE TEST):** (run against the live session `0`, which has known blocked panes)
```
prtl watch --session 0 --once --json
# -> JSON array of currently-waiting panes; asserts ≥1 (e.g. plan-approval panes 1.1/1.2/3.1/4.1, menu 5.1)
prtl watch --session 0 --once          # actually pushes; prints { notified: M }
```

**out_of_scope:** do NOT auto-start the scanner inside the always-on server (opt-in only, no surprise
background scanning); tmux via `child_process` only; idle empty-`❯` panes never notify.

---

## Step 5 — Waiting surface in the portal

- **Edit** `src/server/index.ts` — add `GET /api/waiting` → `sendJson(res, getWaiting())` (empty array if
  watcher not running). Import `getWaiting` from `./waiting/watcher`.
- **Edit** `src/client/ui/App.tsx` — small "Waiting" panel near the bell: fetch `/api/waiting`, list
  `window · pane · reason`; show a count badge; poll every ~15s. Minimal styling consistent with the app.

**Verify (CODE TEST):**
```
curl -s localhost:4070/api/waiting              # JSON array (or [])
npm run build                                   # typecheck + vite build succeeds
agent-browser open https://doug-mm.tail5d92b4.ts.net
agent-browser snapshot                          # the "Waiting" panel renders
```

**out_of_scope:** no per-pane actions (focus/kill) in v1 — display only.

---

## Global scope fence (hard prohibitions for every step)

- Reuse the existing VAPID/subscribe/`sendPushPayload`/manifest/icons — do not reimplement push core.
- Do not modify feedback-request notification behavior (`sendFeedbackNotification`, feedback payload/tags).
- Do not auto-run the tmux scanner from the default server; it is opt-in via `prtl watch`.
- Notify on strong selection/confirm gates only (the Step-1 classifier); never on idle empty prompts.
- No new heavy deps, no DB, no auth layer. Don't touch `native/` (zig), Tailscale config, launchd defaults, or any repo outside `/Users/douglance/Developer/lv/prtl`.
- Keep `npm run typecheck` green at every step; keep diffs surgical.

## Done = all five verify blocks pass + one real push lands on the phone from `prtl notify` and from a live blocked pane via `prtl watch`.
