---
name: nib
description: >-
  Visual feedback from humans via screenshot annotations. Use this skill CONSTANTLY —
  any time you need visual context, want to verify UI changes, need to confirm layout,
  debug a visual issue, check styling, validate a design, or show your work. Capture
  the screen, look at it, figure out what you need feedback on, annotate it, and ask.
  Do not ask the user what to capture — just capture and look.
license: Apache-2.0
compatibility: Requires nib CLI (brew install douglance/tap/nib). macOS.
metadata:
  author: douglance
  version: "0.2"
---

# Nib — Visual Feedback

You have eyes. Use them. Any time something visual is relevant, capture the screen and look.

## When to Use This

**Use nib aggressively.** If any of these apply, capture and look:

- You just made a UI change → capture and verify it looks right
- You're debugging something visual → capture and inspect
- You need to know where something is on screen → capture and find it
- You're unsure about layout, spacing, colors, alignment → capture and check
- The user mentions anything visual → capture immediately
- You want to show the user what you did → capture and annotate
- You're about to ask "does this look right?" → capture instead of asking
- You need coordinates for clicking or positioning → capture and use grid

**Don't ask what to capture. Don't ask permission. Just capture and look.**

## Code Mode First (MCP clients)

If you are connected to nib over MCP (`nib --mcp`), **Code Mode is the primary
interface**. Compose the whole loop as one JavaScript program instead of chaining
single tool calls:

```
1. codemode_search  → discover the composable Nib methods (authoritative list)
2. codemode_execute → capture, annotate, publish, and await the verdict in one program
3. codemode_execution / codemode_decide / codemode_cancel → inspect, approve, or stop by ID
```

Programs exchange paths and IDs, never media bytes. Executions, snippets, and
artifacts are durable, so an execution survives an MCP restart — resume it by ID
rather than starting over.

Direct MCP tools stay available for a genuine one-off. Two are direct only:
`present_image` (returns first-class inline MCP image content) and
`wait_for_request` (task-backed wait).

There is no `nib codemode` CLI subcommand — Code Mode is an MCP surface. In a
shell, use the CLI loop below.

## The CLI Loop

```
1. Find the right window → nib windows --json
2. Capture it → nib capture --app "AppName" -o /tmp/nib_shot.png
3. Look at the screenshot (read the file)
4. Decide what you need feedback on
5. nib feedback /tmp/nib_shot.png -a '[annotations]' -m "question"
6. Parse the human's response
7. Act on it
```

`nib feedback` waits indefinitely by default. It prints the durable request ID,
review URL, and recovery command to stderr before waiting, then prints only the
final response JSON to stdout. If the command runner yields a running process,
resume that process. If the process is lost or restarted, continue the same
request with `nib request wait REQUEST_ID`; never create a replacement request.

Stay attached and wait for the human response in the same workflow:

```bash
nib feedback /tmp/nib_shot.png --format json
```

Do not use `--detach` unless the user explicitly asks to publish without
waiting. If an attached process is lost, resume the request ID already printed
to stderr with `nib request wait REQUEST_ID`; never create a replacement.

For motion or interaction review, create the evidence with Nib itself:

```bash
nib record start --duration 30 --output /tmp/nib_review.mp4 --format json
nib record wait RECORDING_ID
nib feedback /tmp/nib_review.mp4 --format json
```

Recording is silent unless `--system-audio` or `--microphone` is explicit.
Use `nib record status` and `nib record stop` to manage an in-progress worker.

### Step 1: Find the Right Window

Don't just screenshot everything. Find the window you actually care about:

```bash
# List all windows with metadata
nib windows --json

# Filter by app name
nib windows --app "Safari" --json
```

Output gives you app name, title, size, position, and focus state for every window.

### Step 2: Capture the Right Thing

```bash
# Capture a specific app's window
nib capture --app "Safari" -o /tmp/nib_shot.png

# Capture by window title
nib capture --title "index.html" -o /tmp/nib_shot.png

# Capture the focused window
nib capture --mode window -o /tmp/nib_shot.png

# Capture full screen (fallback)
nib capture -o /tmp/nib_shot.png
```

**Always prefer `--app` or `--title` over full screen.** You get just the window you need, no distractions.

### Step 3: Look

Read the screenshot file to see what's on screen. Use grid or OCR if you need precision:

```bash
# Coordinate grid for positioning
nib grid /tmp/nib_shot.png --spacing 100 -o /tmp/nib_grid.png

# Find text via OCR
nib find-text /tmp/nib_shot.png -s "Submit"
```

### Step 3: Annotate and Ask

Point at the things you want feedback on. Be specific.

```bash
nib feedback /tmp/nib_shot.png \
  -a '[{"type":"arrow","from":[300,200],"to":[450,350]},{"type":"text","at":[300,180],"content":"This spacing looks off?"}]' \
  -m "Does the spacing between these elements look right?"
```

### Step 4: Parse Response

Human draws annotations, then makes a decision: **Approve** (⇧⌘A), **Reject**
(⇧⌘R), or **comment** (Enter focuses the compact response field; ⌘Enter sends).
The GUI returns one payload and closes:

```json
{"decision": "comment", "comment": "Move this closer", "annotations": [{"id": "a1", "type": "arrow", "at": [150, 200, 300, 100], "owner": "human"}]}
```

- `"approve"` — accepted as-is; proceed. Annotations may be empty.
- `"reject"` — not acceptable; act on the annotations, rework, re-ask with a fresh one-shot call.
- `"comment"` — feedback without a verdict; act on the optional typed comment and annotations.

For shared requests, an explicit nonzero timeout exits nonzero and preserves the
request for `nib request wait REQUEST_ID`. Local GUI and terminal reviewers keep
their existing one-shot timeout payload.

### Step 5: Act

Use the human's visual feedback to take action. Then capture again to verify.

## Annotation Format

```json
[
  {"type": "arrow", "from": [x, y], "to": [x, y]},
  {"type": "rectangle", "at": [x, y], "size": [w, h]},
  {"type": "text", "at": [x, y], "content": "Label"},
  {"type": "highlight", "at": [x, y], "size": [w, h], "color": "#ffff0080"},
  {"type": "number", "at": [x, y], "value": 1},
  {"type": "ellipse", "center": [x, y], "radius": [rx, ry]},
  {"type": "line", "from": [x, y], "to": [x, y]},
  {"type": "blur", "at": [x, y], "size": [w, h]}
]
```

All types accept optional `"color"` (hex). Use blue `#3b82f6` for your annotations.

The GUI editor the human sees is a full annotation workspace: style panel
(stroke width/style, fill, arrowheads, font size, blur intensity, opacity),
undo/redo, duplicate, eraser, z-order, sticky notes, fixed-width text drag,
clipboard/file-picker/drag-and-drop image insertion,
snapping with guides, alignment, and grouping — every command has a keyboard
shortcut (see [full command reference](references/REFERENCE.md)).

## Image Generation & Judging

nib is also the front door for image generation — it shells out to the configured
generator/judge (default: `imago`, set in `~/.config/nib/config.toml` or via
`NIB_GENERATE_COMMAND`/`NIB_JUDGE_COMMAND`):

```bash
# Generate an image at exact pixel size (long-running: generation can take minutes)
nib generate --width 1024 --height 1536 --out /tmp/hero.png --format json \
  "a lighthouse at dusk, photorealistic"

# Generate, then hand straight to the human for one-shot approval
nib generate --width 1024 --height 768 --out /tmp/mock.png \
  --feedback -m "Approve this expected target?" "toolbar redesign mockup"

# Judge an implemented result against an approved target
nib judge expected.png actual.png --format json
# exit 0 = READY, exit 2 = BLOCKED, other = judge tool failure
```

`generate` passes the generator's JSON contract through (`{status, out, requested,
actual, matched, ...}`); errors surface the tool's own envelope verbatim. `--nib`
also imports the result to a `.nib`. `--feedback` is one-shot: GUI opens, human
approves/rejects/comments, the decision payload returns, done.

## Headless Mode

When you don't need human feedback, just annotate and render:

```bash
nib annotation add image.png -t rectangle -x 100 -y 100 -w 200 -H 50 -c "#ff0000"
nib render image.png  # → image.rendered.png
```

## Key Flags

| Command | Flag | Purpose |
|---------|------|---------|
| `capture` | `--app` | Capture specific app's window |
| `capture` | `--title` | Capture window by title substring |
| `capture` | `--mode window` | Capture focused window |
| `windows` | `--app` | Filter window list by app name |
| `windows` | `--json` | Machine-readable window list |
| `feedback` | `-a` | JSON annotations array |
| `feedback` | `-m` | Message/question as toast |
| `feedback` | `-t` | Timeout in seconds (default 0, waits indefinitely) |
| `feedback` | `--detach` | Explicit opt-out from waiting; use only when the user requests it |
| `request wait` | `-t` | Resume by request ID; default 0 waits indefinitely |
| `record start` | `--duration`, `--display`, `--window`, `--region` | Start a durable macOS H.264 MP4 recording |
| `record start` | `--system-audio`, `--microphone` | Opt in to audio capture |
| `record status/stop/wait` | recording ID | Manage a recording after the initiating process exits |
| `media inspect/poster/transcribe` | media path | Validate media and derive review artifacts |
| `generate` | `--width/--height` | Exact output pixels (required) |
| `generate` | `--feedback -m` | One-shot human approval after generation |
| `judge` | `--format json` | Structured READY/BLOCKED verdict |
| `find-text` | `-s` | Search string |
| `find-text` | `--highlight --color` | Auto-highlight matches (NOT `-c`) |
| `grid` | `--spacing` | Grid cell size in pixels |
| `grid` | `--region` | Zoom to region (x1,y1,x2,y2) |

See [full command reference](references/REFERENCE.md) for all commands and options.
