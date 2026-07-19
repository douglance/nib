#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$HOME/bin"
TARGET="$BIN_DIR/prtl"
INSTRUCTIONS_DIR="$HOME/.prtl"
INSTRUCTIONS="$INSTRUCTIONS_DIR/AGENT_INSTRUCTIONS.md"

mkdir -p "$BIN_DIR" "$INSTRUCTIONS_DIR"
ln -sf "$ROOT/bin/prtl" "$TARGET"
chmod +x "$ROOT/bin/prtl"

cat > "$INSTRUCTIONS" <<'EOF'
# prtl Agent Instructions

Use `prtl` as the default human feedback loop on this machine.

- Discover running apps with `prtl project list`.
- Register existing websites with `prtl target add-url <url> --name <name>`.
- Register standalone HTML artifacts with `prtl target add-html <file.html> --name <name>`.
- Do not treat `prtl` as an HTML generator. The human or agent authors HTML; `prtl` wraps it, enriches it, and moves structured feedback back to the terminal.
- Use `prtl library list/show/context` to inspect the libraries and interaction contracts the chrome supports.
- Use `prtl bridge show` to inspect the injected `window.prtl.feedback` bridge available to custom feedback HTML.
- Use `prtl html validate` and `prtl html validate-feedback` as compatibility checks for the prtl chrome.
- Use `prtl html import/list/show/open/screenshot/export/share` to manage existing HTML artifacts as durable prtl targets.
- Use `prtl html diff`, `prtl html normalize`, and `prtl html design-system scan` to improve reviewability and visual consistency.
- Ask precise product or performance questions with `prtl feedback request <project>`.
- For one-shot feedback on a website or HTML file, use `prtl feedback request --url <url>` or `prtl feedback request --html <file.html>`.
- Attach a custom feedback chrome with `--surface-html <feedback.html>` when the response needs richer controls than choices/freeform.
- Target an exact route with `--path`.
- Operate the app inside the prtl chrome with `prtl operate snapshot|click|type|press|wait|eval|run <project>` before asking for human feedback when you need to inspect or exercise the exact framed experience.
- Ask one human-visible question at a time.
- Use product-facing language, not code-review language.
- Prefer clear choices plus optional freeform detail.
- Use `prtl feedback wait <requestId>` when blocked on the human response.
- Use `prtl feedback export <requestId>` and `prtl feedback edits <requestId>` to bring human responses and tracked page edits back into the terminal.
- Use `prtl feedback metrics` to monitor feedback-loop speed.
- Do not rely on ad hoc screenshots or notes as the primary feedback loop.

Performance prompt template:

```bash
prtl feedback request <project> \
  --path <route> \
  --prompt 'On your phone, does <specific action> feel instant? Watch for input lag, delayed transitions, loading stalls, or anything that feels stuck.' \
  --response-mode choice \
  --option 'Feels instant' \
  --option 'Slight lag' \
  --option 'Clearly slow' \
  --option 'Broken' \
  --metadata '{"type":"perf","action":"<specific action>"}'
```

Readiness check:

```bash
prtl doctor
```
EOF

echo "Installed prtl at $TARGET"
echo "Wrote agent instructions to $INSTRUCTIONS"
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo "Add $BIN_DIR to PATH for shells and agent runtimes."
fi
