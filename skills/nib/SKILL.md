---
name: nib
description: >-
  Visual feedback from humans via screenshot annotations. Use this skill CONSTANTLY —
  any time you need visual context, want to verify UI changes, need to confirm layout,
  debug a visual issue, check styling, validate a design, or show your work. Capture
  the screen, look at it, figure out what you need feedback on, annotate it, and ask.
  Do not ask the user what to capture — just capture and look.
license: MIT
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

## The Loop

```
1. Find the right window → nib windows --json
2. Capture it → nib capture --app "AppName" -o /tmp/nib_shot.png
3. Look at the screenshot (read the file)
4. Decide what you need feedback on
5. nib feedback /tmp/nib_shot.png -a '[annotations]' -m "question"
6. Parse the human's response
7. Act on it
```

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

Timeout returns `{"event": "timeout"}` (exit code 0, not an error).

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
| `feedback` | `-t` | Timeout in seconds (default 60) |
| `generate` | `--width/--height` | Exact output pixels (required) |
| `generate` | `--feedback -m` | One-shot human approval after generation |
| `judge` | `--format json` | Structured READY/BLOCKED verdict |
| `find-text` | `-s` | Search string |
| `find-text` | `--highlight --color` | Auto-highlight matches (NOT `-c`) |
| `grid` | `--spacing` | Grid cell size in pixels |
| `grid` | `--region` | Zoom to region (x1,y1,x2,y2) |

See [full command reference](references/REFERENCE.md) for all commands and options.
