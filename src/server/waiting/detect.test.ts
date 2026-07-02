import { test } from "node:test";
import assert from "node:assert";
import { classifyPane } from "./detect";

const WAITING = [
  "Claude has written up a plan and is ready to execute. Would you like to proceed?\n   ❯ 1. Yes, and bypass permissions\n     2. Yes, manually approve edits\n     3. No, refine with Ultraplan\n     4. Tell Claude what to change",
  "  Implement this plan?\n  1. Yes, implement this plan          Switch to Default and start coding.\n› 2. Yes, clear context and implement  Fresh thread. Context: 87% used.\n  3. No, stay in Plan mode\n  Press enter to confirm or esc to go back",
  " The live vmux is visionPTY/Daemon, not the standalone prototype. Which should I build?\n❯ 1. visionPTY/Daemon (vmux + vmuxd)\n  2. Standalone lv/vmux\n  3. visionPTY VmuxCli\n  4. Type something.\nEnter to select · ↑/↓ to navigate · Esc to cancel",
  "  1. Consolidate into one domain method\n  2. Inline fix in validator only\n  3. Type something.\n  4. Chat about this\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel"
];

const NOT_WAITING = [
  "• Working (1m 01s • esc to interrupt)\n› Summarize recent commits\n  gpt-5.5 high · ~/Developer/lv/tmppr",
  "✶ Analyzing… (7m 53s · ↑ 35.5k tokens)\n  ⎿  Tip: Use /btw to ask a quick side question",
  "─ Worked for 8m 01s ───\n  2 background terminals running · /ps to view\n› Run /review on my current changes",
  "~ ⬢ v22.22.3\n➜ tmux attach -t 0",
  "  Nothing committed — changes are in the working tree.\n✻ Cooked for 6m 52s\n                 new task? /clear to save 128k tokens\n❯ \n  󰉋 ~/Developer/velo"
];

for (const [index, text] of WAITING.entries()) {
  test(`waiting sample #${index}`, () => {
    const result = classifyPane(text);
    assert.strictEqual(result.waiting, true, `expected waiting:true, got ${JSON.stringify(result)}`);
    assert.ok(result.reason.length > 0);
  });
}

for (const [index, text] of NOT_WAITING.entries()) {
  test(`not waiting sample #${index}`, () => {
    const result = classifyPane(text);
    assert.strictEqual(result.waiting, false, `expected waiting:false, got ${JSON.stringify(result)}`);
  });
}
