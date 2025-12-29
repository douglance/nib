---
name: using-quill
description: Annotate screenshots with Quill CLI. Use when adding annotations to images, finding text coordinates with OCR, highlighting regions, overlaying coordinate grids for precision, or working with screenshot markup.
---

# Using Quill

Quill is a Rust CLI for screenshot annotation. Annotations are stored in sidecar JSON files (`{image}.annotations.json`) and can be rendered onto images.

## Core Workflow

```bash
# 1. Add annotation to image
quill add-annotation image.png -t highlight -x 100 -y 50 -w 200 -H 30 -c "#ffff00"

# 2. View annotations
quill annotations image.png

# 3. Render annotations onto image (creates image.rendered.png)
quill render image.png

# 4. Remove if wrong
quill remove-annotation image.png a1

# 5. Clear all
quill clear-annotations image.png
```

## Finding Text Coordinates with OCR

Use `find-text` to get precise coordinates for any text in an image:

```bash
# Find specific text
quill find-text image.png --search "Submit"
# Output: x=213, y=4, width=29, height=15

# Auto-highlight found text
quill find-text image.png --search "Error" --highlight --color "#ff0000"

# List all text (for exploration)
quill find-text image.png

# Filter to specific region (x,y,width,height)
quill find-text image.png --region "100,200,400,300"

# Combine region filter with search
quill find-text image.png -r "0,0,500,100" -s "Header"

# JSON output for scripting
quill find-text image.png --search "Button" --json
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
quill add-annotation <file> [options]

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
quill find-text <file> [options]

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
quill annotations <file>           # View annotations
quill annotations <file> --json    # As JSON
quill render <file>                # Bake onto image
quill render <file> -o out.png     # Custom output path
quill remove-annotation <file> a1  # Remove by ID
quill clear-annotations <file>     # Remove all
quill gui <file>                   # Open GUI editor
quill capture                      # Take screenshot
quill grid <file>                  # Overlay coordinate grid
quill grid <file> --spacing 50     # Custom grid spacing
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
quill find-text screenshot.png --search "Submit"
# Found: x=340, y=520, width=80, height=32

# 2. Add highlight with some padding
quill add-annotation screenshot.png \
  -t highlight \
  -x 335 -y 515 -w 90 -H 42 \
  -c "#00ff00"

# 3. Render to verify
quill render screenshot.png

# 4. View the result
open screenshot.rendered.png
```

## Example: Annotate Multiple Elements

```bash
# Find all "Error" text and highlight in red
quill find-text app.png --search "Error" --highlight --color "#ff0000"

# Add numbered callouts manually
quill add-annotation app.png -t number -x 100 -y 200 --value 1 -c "#0000ff"
quill add-annotation app.png -t number -x 300 -y 400 --value 2 -c "#0000ff"

# Render final result
quill render app.png
```

## Grid Overlay System

Use `grid` to overlay coordinate grids on images for precise positioning:

```bash
# Basic grid (100px spacing)
quill grid screenshot.png

# Custom spacing
quill grid screenshot.png --spacing 50

# Focus on specific region (x1,y1,x2,y2)
quill grid screenshot.png --region "300,150,500,300" --spacing 10

# Custom output path
quill grid screenshot.png -o screenshot_grid.png

# Get grid metadata as JSON (for calculations)
quill grid screenshot.png --json
```

### grid Options

```bash
quill grid <file> [options]

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
quill grid ui.png --spacing 100 -o ui_coarse.png

# 2. Identify area of interest (e.g., around 300,200)
# 3. Add fine grid to that region
quill grid ui.png --region "250,150,400,300" --spacing 10 -o ui_fine.png

# 4. Read exact coordinates from fine grid
# 5. Add annotation at precise location
quill add-annotation ui.png -t rectangle -x 287 -y 193 -w 45 -H 22
```

### JSON Output Format

```bash
quill grid image.png --spacing 50 --json
```

Returns metadata with origin and spacing for calculating pixel coordinates:
- `origin`: Grid start point
- `spacing`: Pixels between lines
- Formula: `pixel = origin + (index * spacing)`

## Tips

1. **Use grid for precision** - Overlay grid to find exact coordinates visually
2. **Use find-text first** - Get exact coordinates before adding annotations
3. **Add padding** - Expand bounding boxes by 5-10px for better visibility
4. **Check with render** - Always render to verify placement
5. **Use --json** - For scripting or when you need exact values
6. **Two-pass grid workflow** - Coarse grid (100px) to find region, fine grid (10px) for precision
7. **Color conventions**:
   - `#ff0000` red = errors, warnings
   - `#00ff00` green = success, correct
   - `#ffff00` yellow = highlight, attention
   - `#0000ff` blue = info, neutral
