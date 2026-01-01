---
name: using-nib
description: Visual collaboration with humans via screenshot annotations. Use when you need human input on visual decisions, want to show your work, or need to ask "where should X go?" The feedback command is your primary tool for back-and-forth visual dialogue.
---

# Using Nib

Nib enables visual collaboration between Claude and humans. You draw annotations, ask questions, and get visual responses back instantly.

## Primary Workflow: `nib feedback`

This is your main tool. One command that:
1. Opens GUI (or connects if already open)
2. Shows your annotations
3. Displays your question as a toast
4. Waits for human to respond
5. Returns their annotations as JSON (excludes your own)

```bash
nib feedback image.png \
  -a '[{"type":"arrow","from":[100,100],"to":[200,150]}]' \
  -m "Where should the button go?"
```

### JSON Annotation Format

```json
[
  {"type":"arrow","from":[x,y],"to":[x,y],"color":"#ff0000"},
  {"type":"rectangle","at":[x,y],"size":[w,h],"color":"#00ff00"},
  {"type":"text","at":[x,y],"content":"Label","color":"#0000ff"},
  {"type":"highlight","at":[x,y],"size":[w,h],"color":"#ffff0080"},
  {"type":"number","at":[x,y],"value":1},
  {"type":"ellipse","center":[x,y],"radius":[rx,ry]},
  {"type":"line","from":[x,y],"to":[x,y]},
  {"type":"blur","at":[x,y],"size":[w,h]}
]
```

### Response Format

Human's annotations come back as JSON:
```json
{"annotations":[{"id":"a1","type":"rectangle","at":[150,200,300,100],"owner":"human"}]}
```

### Owner-Based Filtering

The feedback loop automatically separates Claude's annotations from human annotations:

| Source | Owner Field | Filtered? |
|--------|-------------|-----------|
| CLI (`-a` flag) | `"claude"` | Yes - excluded from response |
| Human drawing | `"human"` | No - included in response |

When human hits Cmd+Enter, `send_to_claude()` returns only:
- Annotations where `owner != "claude"`
- Annotations not already sent in this session

This means you always get back just the human's new work, never your own annotations echoed back.

### Flags

| Flag | Purpose |
|------|---------|
| `-a, --annotations` | JSON array of your annotations |
| `-m, --message` | Question/context shown as toast |
| `-t, --timeout` | Seconds to wait (default: 60) |

### Timeout Behavior

If timeout expires before human responds:
```json
{"event":"timeout"}
```
Exit code is 0 (not an error). GUI stays open for human to continue working.

### Example: Multi-Turn Conversation

```bash
# Round 1: Ask about layout
nib feedback mockup.png \
  -a '[{"type":"text","at":[50,30],"content":"HEADER"}]' \
  -m "Where should the navigation go?"
# Human draws rectangle → returns JSON with human annotations only

# Round 2: Confirm and ask next question
nib feedback mockup.png \
  -a '[{"type":"rectangle","at":[50,80],"size":[200,40],"color":"#22c55e"}]' \
  -m "Got it. Where should the sidebar be?"
# Human draws again → returns JSON

# Round 3: Just open and wait (no prompt)
nib feedback mockup.png -t 300
```

### Human Shortcuts

- `⌘↵` (Cmd+Enter) - Send response to Claude (GUI stays open)
- Human can close GUI when done with session

---

## Supplementary Commands

These are useful for specific tasks but `nib feedback` handles most collaboration.

### Finding Coordinates with OCR

```bash
nib find-text image.png -s "Submit"
# Output: x=213, y=4, width=29, height=15

# Auto-highlight matches
nib find-text image.png -s "Error" --highlight --color "#ff0000"

# Focus on region (x,y,width,height)
nib find-text image.png -r "100,200,400,300" -s "Button"
```

### Headless Annotation

When you don't need human response:

```bash
# Add annotation
nib annotation add image.png -t highlight -x 100 -y 50 -w 200 -H 30 -c "#ffff00"

# Remove by ID
nib annotation remove image.png a1

# Clear all
nib annotation clear image.png

# List annotations
nib annotation list image.png --json

# Render annotations onto image
nib render image.png  # creates image.rendered.png
```

### Grid Overlay for Precision

```bash
# Overlay coordinate grid
nib grid image.png --spacing 50

# Focus on specific region
nib grid image.png --region "300,150,500,300" --spacing 10 -o zoomed.png
```

### Capture Screenshots

```bash
nib capture -o screenshot.png
```

---

## Annotation Types

| Type | Use For |
|------|---------|
| `arrow` | Point to something |
| `rectangle` | Frame UI elements |
| `highlight` | Semi-transparent overlay |
| `text` | Add labels |
| `number` | Numbered callouts |
| `ellipse` | Circle items |
| `line` | Connect points |
| `blur` | Hide sensitive content |

---

## Color Convention

| Actor | Color | Hex |
|-------|-------|-----|
| Claude | Blue | `#3b82f6` |
| Human | Red | `#dc2626` |
| Success | Green | `#22c55e` |
| Warning | Yellow | `#eab308` |

---

## When to Use This

Use `nib feedback` when:
- You need human input on visual decisions
- You want to confirm which UI element to target
- Complex layouts require human judgment
- You're iterating on a design with the human

Use headless commands when:
- You already know exact coordinates
- Bulk annotating from OCR results
- No human interaction needed
