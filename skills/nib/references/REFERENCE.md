# Nib Command Reference

Complete reference for all nib CLI commands and options.

## CLI Global Flags

| Flag | Purpose |
|------|---------|
| `-v, --verbose` | Enable verbose output |
| `--format [text\|json]` | Output format (default: text) |

## Commands

### `nib capture`

Capture a screenshot.

```bash
nib capture -o output.png
nib capture --mode region -o region.png
nib capture --mode window -o window.png
```

| Flag | Purpose |
|------|---------|
| `-o, --output` | Output file path |
| `--mode` | Capture mode: `region`, `screen`, `window` |

### `nib feedback`

Primary tool for visual collaboration. Opens GUI, shows annotations, waits for human response.

```bash
nib feedback image.png \
  -a '[{"type":"arrow","from":[100,100],"to":[200,150]}]' \
  -m "Where should the button go?" \
  -t 120
```

| Flag | Purpose | Default |
|------|---------|---------|
| `-a, --annotations` | JSON array of annotations to display | none |
| `-m, --message` | Question shown as toast notification | none |
| `-t, --timeout` | Seconds to wait for response | 60 |

**Owner-based filtering:** Annotations passed via `-a` are tagged `owner: "claude"` and excluded from the response. Only the human's new annotations are returned.

**Response format:**
```json
{"annotations": [{"id": "a1", "type": "rectangle", "at": [150, 200, 300, 100], "owner": "human"}]}
```

**Timeout response:**
```json
{"event": "timeout"}
```

Exit code 0 on timeout (not an error). GUI stays open.

### `nib gui`

Launch the GUI editor directly.

```bash
nib gui image.png
```

### `nib annotation add`

Add an annotation headlessly (no GUI needed).

```bash
nib annotation add image.png -t rectangle -x 100 -y 100 -w 200 -H 50 -c "#ff0000"
```

| Flag | Purpose |
|------|---------|
| `-t, --type` | Annotation type (see types below) |
| `-x` | X coordinate |
| `-y` | Y coordinate |
| `-w, --width` | Width |
| `-H, --height` | Height (uppercase H) |
| `-c, --color` | Color as hex string |
| `--from-x, --from-y` | Start point (for arrow, line) |
| `--to-x, --to-y` | End point (for arrow, line) |
| `--content` | Text content (for text type) |
| `--value` | Number value (for number type) |

Output: `Added annotation [a1] rectangle at (100, 100)`

### `nib annotation remove`

```bash
nib annotation remove image.png a1
```

### `nib annotation clear`

```bash
nib annotation clear image.png
```

### `nib annotation list`

```bash
nib annotation list image.png --json
```

### `nib render`

Bake annotations onto the image.

```bash
nib render image.png
# Output: image.rendered.png

nib render image.png -o custom_output.png
```

### `nib grid`

Overlay a coordinate grid for precision positioning.

```bash
# Visual overlay
nib grid image.png --spacing 100 -o grid.png

# Zoom into region (x1,y1,x2,y2)
nib grid image.png --region "300,150,500,300" --spacing 10 -o zoomed.png

# JSON metadata
nib grid image.png --spacing 100 --json
```

Grid labels use base36 encoding (0-9, A-Z).
Convert label to pixels: `pixel_x = col * spacing`, `pixel_y = row * spacing`.

### `nib find-text`

OCR text search and highlighting.

```bash
# Find text
nib find-text image.png -s "Submit"

# Highlight matches
nib find-text image.png -s "Error" --highlight --color "#ff0000"

# Search within region (x,y,width,height)
nib find-text image.png -r "100,200,400,300" -s "Button"
```

| Flag | Purpose |
|------|---------|
| `-s, --search` | Text to search for |
| `-r, --region` | Region to search within (x,y,w,h) |
| `--highlight` | Add highlight annotations for matches |
| `--color` | Highlight color (NOT `-c`, which is `--confidence`) |
| `-c, --confidence` | Minimum OCR confidence threshold |

### `nib import`

Convert image to `.nib` format.

```bash
nib import image.png
```

### `nib export`

Export `.nib` file.

```bash
nib export image.nib --export-format rendered
nib export image.nib --export-format json
nib export image.nib --export-format qml
```

### `nib validate`

Check QML syntax.

```bash
nib validate image.png
```

### `nib info`

Show `.nib` file metadata.

```bash
nib info image.nib --json
```

### `nib list`

List recent captures.

```bash
nib list
```

### `nib tile`

Manage tiled captures for large images.

```bash
# Query a point
nib tile query capture.tiles/ --point "500,300"

# Extract a region at full resolution
nib tile extract capture.tiles/ -r "100,100,400,300" -o region.png

# List tiles
nib tile list capture.tiles/
```

## Annotation JSON Format (Full)

All annotation types with every field:

```json
[
  {
    "type": "arrow",
    "from": [x, y],
    "to": [x, y],
    "color": "#ff0000"
  },
  {
    "type": "rectangle",
    "at": [x, y],
    "size": [w, h],
    "color": "#00ff00"
  },
  {
    "type": "text",
    "at": [x, y],
    "content": "Label text",
    "color": "#0000ff"
  },
  {
    "type": "highlight",
    "at": [x, y],
    "size": [w, h],
    "color": "#ffff0080"
  },
  {
    "type": "number",
    "at": [x, y],
    "value": 1,
    "color": "#3b82f6"
  },
  {
    "type": "ellipse",
    "center": [x, y],
    "radius": [rx, ry],
    "color": "#dc2626"
  },
  {
    "type": "line",
    "from": [x, y],
    "to": [x, y],
    "color": "#ffffff"
  },
  {
    "type": "blur",
    "at": [x, y],
    "size": [w, h]
  }
]
```

All types accept an optional `"color"` field as a hex string. Highlight colors typically include alpha (e.g. `"#ffff0080"`).

## Recipes

### OCR Highlight All Text

```bash
IMG=/tmp/shot.png && \
  nib capture -o $IMG && \
  nib annotation clear $IMG 2>/dev/null; \
  nib find-text $IMG --highlight --color "#ffff0080" && \
  nib render $IMG -o ${IMG%.png}_highlighted.png
```

### Capture, Annotate, Render Pipeline

```bash
nib capture -o shot.png
nib annotation add shot.png -t rectangle -x 100 -y 100 -w 50 -H 30 -c "#ff0000"
nib render shot.png
# Inspect shot.rendered.png
```

### Zoom and Inspect Region

```bash
nib grid image.png --region "1900,650,2300,850" --spacing 10 -o zoomed.png
# Inspect zoomed.png for precise coordinates
```

### Multi-Turn Visual Dialogue

```bash
# Round 1
RESP=$(nib feedback mockup.png \
  -a '[{"type":"text","at":[50,30],"content":"HEADER"}]' \
  -m "Where should the navigation go?" -t 120)

# Parse response, use coordinates for round 2
nib feedback mockup.png \
  -a '[{"type":"rectangle","at":[50,80],"size":[200,40],"color":"#22c55e"}]' \
  -m "Got it. Where should the sidebar be?" -t 120
```
