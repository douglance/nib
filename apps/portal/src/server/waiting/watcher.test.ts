import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WaitingPane } from "../../shared/types";

test("persists waiting panes across watcher readers", async () => {
  process.env.NIB_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "nib-waiting-test-"));
  const { getWaiting, persistWaitingForSession } = await import("./watcher");
  const pane: WaitingPane = {
    session: "ignored",
    paneId: "1.1",
    window: "agent",
    reason: "plan approval gate",
    since: "2026-06-06T00:00:00.000Z",
    fingerprint: "fingerprint"
  };

  await persistWaitingForSession("smoke", [pane]);
  assert.deepStrictEqual(await getWaiting(), [{ ...pane, session: "smoke" }]);

  await persistWaitingForSession("smoke", []);
  assert.deepStrictEqual(await getWaiting(), []);
});
