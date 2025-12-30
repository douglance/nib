---
name: using-nib
description: Annotate screenshots with Nib CLI. Use when adding annotations to images, finding text coordinates with OCR, highlighting regions, overlaying coordinate grids for precision, or working with screenshot markup.
---

# Using Nib

Nib is a Rust CLI for screenshot annotation. Annotations are stored in sidecar JSON files (`{image}.annotations.json`) and can be rendered onto images.

## Core Workflow

```bash
# 1. Add annotation to image
nib add-annotation image.png -t highlight -x 100 -y 50 -w 200 -H 30 -c "#ffff00"

# 2. View annotations
nib annotations image.png

# 3. Render annotations onto image (creates image.rendered.png)
nib render image.png

# 4. Remove if wrong
nib remove-annotation image.png a1

# 5. Clear all
nib clear-annotations image.png
```

## Finding Text Coordinates with OCR

Use `find-text` to get precise coordinates for any text in an image:

```bash
# Find specific text
nib find-text image.png --search "Submit"
# Output: x=213, y=4, width=29, height=15

# Auto-highlight found text
nib find-text image.png --search "Error" --highlight --color "#ff0000"

# List all text (for exploration)
nib find-text image.png

# Filter to specific region (x,y,width,height)
nib find-text image.png --region "100,200,400,300"

# Combine region filter with search
nib find-text image.png -r "0,0,500,100" -s "Header"

# JSON output for scripting
nib find-text image.png --search "Button" --json
```

## Annotation Types

| Type | Use For | Example |
|------|---------|---------|
| `highlight` | Semi-transparent overlay | Mark text, regions |
| `rectangle` | Solid outline box | Frame UI elements |
| `arrow` | Point to something | Direct attention |
| `line` | Connect points | Show relationships |
| `ellipse` | Circular highlight | Circle important items |
| `text` | Add label | Explain something |
| `number` | Numbered callout | Step-by-step |
| `blur` | Obscure content | Hide sensitive data |

## Command Reference

### add-annotation

```bash
nib add-annotation <file> [options]

Options:
  -t, --annotation-type  Type (default: rectangle)
  -x                     X coordinate
  -y                     Y coordinate
  -w, --width            Width (default: 100)
  -H, --height           Height (default: 50)
  -c, --color            Hex color (default: #ff0000)
  --text                 Text content (for text type)
  --value                Number value (for number type)
```

### find-text

```bash
nib find-text <file> [options]

Options:
  -s, --search     Filter by text (case-insensitive)
  -r, --region     Filter to region "x,y,width,height" (e.g., "100,200,300,150")
  --json           Output as JSON
  --highlight      Auto-create highlight annotations
  --color          Highlight color (default: #ffff00)
  --confidence     Min confidence 0-100 (default: 60)
```

### Other Commands

```bash
nib annotations <file>           # View annotations
nib annotations <file> --json    # As JSON
nib render <file>                # Bake onto image
nib render <file> -o out.png     # Custom output path
nib remove-annotation <file> a1  # Remove by ID
nib clear-annotations <file>     # Remove all
nib gui <file>                   # Open GUI editor
nib capture                      # Take screenshot
nib grid <file>                  # Overlay coordinate grid
nib grid <file> --spacing 50     # Custom grid spacing
```

## Annotation IDs

Annotations get sequential IDs: `a1`, `a2`, `a3`, etc. Use these with `remove-annotation`.

## Files

| File | Purpose |
|------|---------|
| `image.png` | Original image |
| `image.png.annotations.json` | Annotation data (sidecar) |
| `image.rendered.png` | Image with baked annotations |
| `image.grid.png` | Image with grid overlay |

## Example: Highlight a Button

```bash
# 1. Find the button's coordinates
nib find-text screenshot.png --search "Submit"
# Found: x=340, y=520, width=80, height=32

# 2. Add highlight with some padding
nib add-annotation screenshot.png \
  -t highlight \
  -x 335 -y 515 -w 90 -H 42 \
  -c "#00ff00"

# 3. Render to verify
nib render screenshot.png

# 4. View the result
open screenshot.rendered.png
```

## Example: Annotate Multiple Elements

```bash
# Find all "Error" text and highlight in red
nib find-text app.png --search "Error" --highlight --color "#ff0000"

# Add numbered callouts manually
nib add-annotation app.png -t number -x 100 -y 200 --value 1 -c "#0000ff"
nib add-annotation app.png -t number -x 300 -y 400 --value 2 -c "#0000ff"

# Render final result
nib render app.png
```

## Grid Overlay System

Use `grid` to overlay coordinate grids on images for precise positioning:

```bash
# Basic grid (100px spacing)
nib grid screenshot.png

# Custom spacing
nib grid screenshot.png --spacing 50

# Focus on specific region (x1,y1,x2,y2)
nib grid screenshot.png --region "300,150,500,300" --spacing 10

# Custom output path
nib grid screenshot.png -o screenshot_grid.png

# Get grid metadata as JSON (for calculations)
nib grid screenshot.png --json
```

### grid Options

```bash
nib grid <file> [options]

Options:
  -s, --spacing         Grid line spacing in pixels (default: 100)
  -r, --region          Focus region "x1,y1,x2,y2"
  -o, --output          Output file (default: {file}.grid.png)
  -c, --color           Grid line color (default: #80808080)
  --major-color         Major line color (default: #ff0000a0)
  --major-interval      Lines between major lines (default: 5)
  --json                Output metadata instead of image
```

### Grid Coordinate Labels

Grid junctions are labeled with base36 coordinates `(col,row)`:
- `0,0` = top-left origin
- `A,5` = column 10 (A in base36), row 5
- Use labels to quickly reference positions

### Example: Precise Element Location

```bash
# 1. Add coarse grid to identify region
nib grid ui.png --spacing 100 -o ui_coarse.png

# 2. Identify area of interest (e.g., around 300,200)
# 3. Add fine grid to that region
nib grid ui.png --region "250,150,400,300" --spacing 10 -o ui_fine.png

# 4. Read exact coordinates from fine grid
# 5. Add annotation at precise location
nib add-annotation ui.png -t rectangle -x 287 -y 193 -w 45 -H 22
```

### JSON Output Format

```bash
nib grid image.png --spacing 50 --json
```

Returns metadata with origin and spacing for calculating pixel coordinates:
- `origin`: Grid start point
- `spacing`: Pixels between lines
- Formula: `pixel = origin + (index * spacing)`

## Real-Time Visual Collaboration

When you need human input, launch the GUI with event streaming enabled:

```bash
# Launch GUI with real-time events
NIB_EVENTS=1 nib gui /tmp/question.png
```

### Event Format (Progressive Disclosure)

Events are minimal notifications - just enough to know what changed:

```
[NIB] human created a4 arrow
[NIB] human deleted a2 text
[NIB] human moved a3 rectangle, a5 ellipse
[NIB] human resized a1 highlight
```

Format: `[NIB] human <action> <id> <type>`

### Query for Details

When an event interests you, query for full annotation data:

```bash
# Get specific annotation details
nib annotations /tmp/question.png --id a4

# Get all annotations
nib annotations /tmp/question.png --json
```

### Collaboration Workflow

```bash
# 1. Capture and ask a question (blue = Claude)
nib capture -o /tmp/q.png
nib add-annotation /tmp/q.png -t text -x 100 -y 50 \
  --text "Which button should I click?" -c "#0000ff"

# 2. Launch GUI with events (human responds in red)
NIB_EVENTS=1 nib gui /tmp/q.png &

# 3. Watch for human response
# Output: [NIB] human created a2 arrow
# Output: [NIB] human created a3 text

# 4. Query what they drew
nib annotations /tmp/q.png --json
```

### Color Convention

| Actor | Color | Hex |
|-------|-------|-----|
| Claude | Blue | `#0000ff` |
| Human | Red | `#dc2626` |

**Use this workflow when:**
- You need to confirm which UI element to target
- Coordinates from OCR seem ambiguous
- You need the human to point at something
- Complex visual decisions require human judgment

## Tips

1. **Use find-text first** - Get exact coordinates before adding annotations
2. **Add padding** - Expand bounding boxes by 5-10px for better visibility
3. **Check with render** - Always render to verify placement
4. **Use --json** - For scripting or when you need exact values
5. **Use grid for precision** - Overlay grid when OCR doesn't find the target
6. **Suggest GUI for complex edits** - Human can fine-tune visually
7. **Color conventions**:
   - `#ff0000` red = errors, warnings
   - `#00ff00` green = success, correct
   - `#ffff00` yellow = highlight, attention
   - `#0000ff` blue = info, neutral
