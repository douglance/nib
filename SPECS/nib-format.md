# .nib File Format Specification

> **STATUS: ✅ CORE COMPLETE** — SQLite format, annotations, OCR/grid/render caches, session management all implemented. Agent CLI commands pending.

## Overview

`.nib` is a self-contained document format for annotated images. It's a SQLite database containing the source image, annotations, and cached data in a single portable file.

**Core concept**: A **visual communication channel** between humans and LLM agents.
- **Humans** use the GUI to view images and add annotations
- **Agents** use the CLI to discover open images, query content, and annotate
- The `.nib` file is the shared state that both parties read/write

## Design Goals

1. **Human ↔ Agent communication** - Visual dialog through annotations
2. **Agent self-service** - CLI provides everything an LLM needs to understand and annotate images
3. **Real-time sync** - GUI and CLI see each other's changes immediately
4. **Single file** - One `.nib` file = one annotated image document
5. **Queryable** - Agents can query dimensions, OCR text, existing annotations via CLI
6. **Portable** - Works on any platform with SQLite

## Image-First Verification (Required for Agents)

Annotations are pointers to pixels. Agents must inspect the image after each new annotation. Start with a zoomed crop around the annotation (use `nib grid` or `nib extract`), then zoom out if unclear. Use grid metadata to locate coordinates precisely.

## File Extension

- Primary: `.nib`
- MIME type: `application/x-nib` (or register `application/vnd.nib`)

## Prerequisite

This spec assumes the rename from "nib" to "nib" is complete. See `SPECS/rename-to-nib.md`.

## SQLite Schema

```sql
-- Schema version for migrations
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY
);
INSERT INTO schema_version VALUES (1);

-- Source image data
CREATE TABLE image (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- Single row
  data BLOB NOT NULL,                      -- Original image bytes
  format TEXT NOT NULL,                    -- "png", "jpg", "webp"
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  imported_at INTEGER NOT NULL,            -- Unix timestamp
  original_path TEXT                       -- Where it came from (optional)
);

-- Annotations (shared by human and agent)
CREATE TABLE annotations (
  id TEXT PRIMARY KEY,                     -- "a1", "a2", etc.
  type TEXT NOT NULL,                      -- "rectangle", "arrow", "text", etc.
  data JSON NOT NULL,                      -- Type-specific fields
  color TEXT NOT NULL,                     -- Hex "#rrggbbaa"
  source TEXT NOT NULL DEFAULT 'human',    -- "human", "agent", or agent ID
  z_index INTEGER DEFAULT 0,
  visible INTEGER DEFAULT 1,
  locked INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL
);

-- OCR cache (expensive to recompute)
CREATE TABLE ocr_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  region TEXT,                             -- "x,y,w,h" or NULL for full image
  text TEXT NOT NULL,
  bounds JSON NOT NULL,                    -- {"x":0,"y":0,"width":100,"height":20}
  confidence REAL,
  engine TEXT DEFAULT 'tesseract',
  cached_at INTEGER NOT NULL
);
CREATE INDEX idx_ocr_region ON ocr_cache(region);

-- Grid cache
CREATE TABLE grid_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spacing INTEGER NOT NULL,
  region TEXT,                             -- "x1,y1,x2,y2" or NULL for full image
  metadata JSON NOT NULL,                  -- Grid calculation results
  cached_at INTEGER NOT NULL
);

-- Rendered image cache
CREATE TABLE render_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),   -- Single row
  data BLOB,                               -- Rendered PNG with annotations
  annotations_hash TEXT,                   -- Hash of annotations state
  rendered_at INTEGER
);

-- Document metadata
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Future tables (reserved)
-- CREATE TABLE undo_history (...);
-- CREATE TABLE collaboration_state (...);
-- CREATE TABLE tags (...);
```

## Annotation Data JSON Schemas

Each annotation type has specific fields in the `data` JSON column:

### Rectangle/Box
```json
{
  "x": 100.0,
  "y": 200.0,
  "width": 150.0,
  "height": 75.0,
  "stroke_width": 2.0,
  "corner_radius": 0.0,
  "filled": false
}
```

### Arrow
```json
{
  "start_x": 100.0,
  "start_y": 100.0,
  "end_x": 200.0,
  "end_y": 200.0,
  "stroke_width": 2.0,
  "head_style": "filled"
}
```

### Text
```json
{
  "x": 100.0,
  "y": 100.0,
  "content": "Hello world",
  "font_size": 16.0,
  "align": "left",
  "background": "#ffffff80"
}
```

### Number
```json
{
  "x": 100.0,
  "y": 100.0,
  "value": 1,
  "radius": 16.0
}
```

### Highlight
```json
{
  "x": 100.0,
  "y": 100.0,
  "width": 200.0,
  "height": 30.0,
  "corner_radius": 4.0
}
```

### Blur
```json
{
  "x": 100.0,
  "y": 100.0,
  "width": 200.0,
  "height": 100.0,
  "intensity": "medium"
}
```

### Line
```json
{
  "start_x": 0.0,
  "start_y": 0.0,
  "end_x": 100.0,
  "end_y": 100.0,
  "stroke_width": 2.0,
  "stroke_style": "solid"
}
```

### Ellipse
```json
{
  "center_x": 150.0,
  "center_y": 150.0,
  "radius_x": 50.0,
  "radius_y": 30.0,
  "stroke_width": 2.0,
  "filled": false
}
```

## Communication Model

```
┌─────────────────┐                      ┌─────────────────┐
│     Human       │                      │    LLM Agent    │
│   (Nib.app)     │                      │     (CLI)       │
└────────┬────────┘                      └────────┬────────┘
         │                                        │
         │  opens image                           │
         ▼                                        │
    ┌─────────┐                                   │
    │  .nib   │◄──────────────────────────────────┤ nib list (discover)
    │  file   │                                   │
    │         │◄──────────────────────────────────┤ nib info (query)
    │         │                                   │
    │         │◄──────────────────────────────────┤ nib find-text (OCR)
    │         │                                   │
    │         │◄──────────────────────────────────┤ nib annotate (respond)
    └─────────┘                                   │
         │                                        │
         │  sees agent annotations                │
         │  adds own annotations                  │
         ▼                                        │
    ┌─────────┐                                   │
    │  .nib   │───────────────────────────────────► nib watch (observe)
    │  file   │                                   │
    └─────────┘                                   │
```

## Session Management

When the GUI opens a .nib file, it registers the session so CLI can discover it.

```sql
-- Sessions table (in each .nib file)
CREATE TABLE session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  gui_pid INTEGER,                        -- Process ID of Nib.app
  opened_at INTEGER,
  last_activity INTEGER
);
```

**Alternative**: Central session registry at `~/.nib/sessions.json`:
```json
{
  "sessions": [
    {
      "path": "/Users/doug/screenshot.nib",
      "pid": 12345,
      "opened_at": 1704067200
    }
  ]
}
```

## CLI Workflow (Agent-Oriented)

### 1. Discover open images
```bash
# List all .nib files currently open in GUI
nib list
# Output:
#   1. /Users/doug/screenshot.nib (1920x1080, 3 annotations)
#   2. /Users/doug/error.nib (800x600, 0 annotations)

# List with details
nib list --json
```

### 2. Query image content (agent self-service)
```bash
# Get everything agent needs to understand the image
nib info screenshot.nib
# Output:
#   Path: /Users/doug/screenshot.nib
#   Dimensions: 1920x1080
#   Annotations: 3
#   OCR text: "Submit" at (340,520), "Cancel" at (450,520), ...

# Full OCR dump
nib find-text screenshot.nib
# Output: All detected text with coordinates

# Search for specific text
nib find-text screenshot.nib -s "error"
# Output: Matching text with exact coordinates

# Get grid coordinates
nib grid screenshot.nib --spacing 100 --json
# Output: Grid metadata for coordinate reference

# Query annotations
nib annotations screenshot.nib
# Output: All existing annotations (from human or agent)

# JSON output for parsing
nib info screenshot.nib --json
nib annotations screenshot.nib --json
```

### 3. Add annotations (agent response)
```bash
# Highlight something the human should see
nib annotate screenshot.nib -t highlight -x 340 -y 520 -w 80 -H 30 -c "#ffff00"

# Point to something with arrow
nib annotate screenshot.nib -t arrow --start 100,100 --end 340,520

# Add explanatory text
nib annotate screenshot.nib -t text -x 100 -y 50 --text "Click this button"

# Add numbered callout
nib annotate screenshot.nib -t number -x 340 -y 520 --value 1

# Identify as agent (renders with monospace font, optional icon)
nib annotate screenshot.nib -t text -x 100 -y 50 --text "Found it" --source agent

# Or specific agent ID
nib annotate screenshot.nib -t highlight ... --source "claude-3.5"
```

Note: GUI annotations default to `--source human`, CLI defaults to `--source agent`.

### 4. Watch for changes (observe human response)
```bash
# Stream annotation changes
nib watch screenshot.nib
# Output: Real-time feed of new/modified annotations

# Poll for changes
nib annotations screenshot.nib --since 1704067200
```

### 5. Open image for human
```bash
# Human gives agent a screenshot, agent opens it in GUI
nib open photo.png                      # Creates .nib, opens in GUI

# Or import without opening
nib import photo.png                    # Creates photo.nib only
```

### 6. Export when done
```bash
# Export final annotated image
nib export screenshot.nib -o final.png
```

## Agent Query Commands

These commands are designed for LLM consumption - they output structured data the agent can parse and reason about.

### `nib info` - Image overview
```bash
nib info doc.nib --json
```
```json
{
  "path": "/Users/doug/doc.nib",
  "dimensions": { "width": 1920, "height": 1080 },
  "format": "png",
  "annotations": {
    "count": 5,
    "by_type": { "rectangle": 2, "text": 2, "arrow": 1 }
  },
  "ocr": {
    "text_regions": 42,
    "cached": true
  },
  "session": {
    "open_in_gui": true,
    "last_activity": "2024-01-01T12:00:00Z"
  }
}
```

### `nib find-text` - OCR with coordinates
```bash
nib find-text doc.nib --json
```
```json
{
  "regions": [
    { "text": "Submit", "x": 340, "y": 520, "width": 80, "height": 24, "confidence": 0.95 },
    { "text": "Cancel", "x": 450, "y": 520, "width": 70, "height": 24, "confidence": 0.93 }
  ]
}
```

### `nib annotations` - Current annotations
```bash
nib annotations doc.nib --json
```
```json
{
  "annotations": [
    { "id": "a1", "type": "rectangle", "x": 100, "y": 100, "width": 50, "height": 30, "color": "#ff0000" },
    { "id": "a2", "type": "text", "x": 200, "y": 50, "content": "Look here", "color": "#0000ff" }
  ]
}
```

### `nib grid` - Coordinate system
```bash
nib grid doc.nib --spacing 100 --json
```
```json
{
  "spacing": 100,
  "origin": { "x": 0, "y": 0 },
  "columns": 19,
  "rows": 10,
  "formula": "pixel = index * spacing"
}
```

## Migration Path

### From current JSON sidecar format
```bash
# Migrate single file
nib migrate image.png                   # Reads image.png + image.png.annotations.json
                                        # Creates image.nib

# Migrate directory
nib migrate ./screenshots/              # Migrates all images with sidecars
```

### Backward compatibility
- Keep ability to export to JSON format
- `nib export doc.nib --format json` creates legacy sidecar

## Implementation Phases

### Phase 1: Core Format ✅ COMPLETE
- [x] Define SQLite schema in Rust (`src/storage/nib_file.rs`)
- [x] Create NibFile struct with open/create/save methods
- [x] Implement image table (store/retrieve BLOB)
- [x] Implement annotations table (CRUD operations)
- [x] Wire up to existing Annotation types (all 9 types: Box, Arrow, Text, Number, Highlight, Blur, Line, Ellipse, Crop)

### Phase 2: Agent Discovery & Query — PARTIAL
- [ ] Session registry (`~/.nib/sessions.json`) — schema exists, central registry not implemented
- [ ] `nib list` - discover open .nib files
- [ ] `nib info` - comprehensive image/annotation summary
- [ ] `nib open` - import image and open in GUI
- [ ] JSON output for all query commands

### Phase 3: Real-time Sync ✅ COMPLETE
- [x] GUI registers session on open, removes on close (`update_session()`, `clear_session()`)
- [x] File watching for CLI→GUI updates (sidecar file watching in `app.rs`)
- [ ] `nib watch` - stream changes for agent observation
- [ ] `--since` flag for polling changes

### Phase 4: Caching ✅ COMPLETE
- [x] Implement OCR cache with region support, confidence scores, bounds
- [x] Implement grid cache with spacing/region/metadata storage
- [x] Implement render cache with SHA256 hash invalidation

### Phase 5: Migration & Polish
- [ ] `nib migrate` command for JSON sidecars
- [ ] macOS app registration (double-click .nib opens Nib.app)
- [ ] UTI/MIME type registration

## File Size Considerations

| Content | Typical Size |
|---------|--------------|
| Image (PNG screenshot) | 500KB - 5MB |
| Annotations (50) | ~10KB |
| OCR cache | ~5KB |
| Grid cache | ~1KB |
| Render cache | 500KB - 5MB |

**Total:** Roughly 2x original image size with render cache, or ~1x without.

Option: Make render cache opt-in or auto-evict after time period.

## SQLite Pragmas

For optimal performance:
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
```

## Versioning & Migrations

Schema changes handled via version number:
```rust
fn migrate(conn: &Connection) -> Result<()> {
    let version: i32 = conn.query_row(
        "SELECT version FROM schema_version",
        [],
        |row| row.get(0)
    )?;

    if version < 2 {
        // Add new table/column
        conn.execute("ALTER TABLE ...", [])?;
        conn.execute("UPDATE schema_version SET version = 2", [])?;
    }
    // ... more migrations
    Ok(())
}
```

## Security Considerations

- SQLite files can contain arbitrary SQL; validate on open
- Image BLOB should be validated as actual image data
- Consider signing/checksum for integrity verification

## Typical Agent Workflow

```
Human: "Help me find the submit button in this screenshot"
       [pastes screenshot.png]

Agent: # 1. Open image in GUI so human can see what agent sees
       nib open screenshot.png

       # 2. Query image to understand it
       nib find-text screenshot.nib --json
       # Returns: [{"text": "Submit", "x": 340, "y": 520, ...}, ...]

       # 3. Annotate to show human what was found
       nib annotate screenshot.nib -t highlight -x 335 -y 515 -w 90 -H 34 -c "#00ff00"
       nib annotate screenshot.nib -t text -x 340 -y 480 --text "Found: Submit button"

Agent: "I found the Submit button at coordinates (340, 520).
        I've highlighted it in green in the Nib window."
```

## Questions to Resolve

1. **Compression**: Store image BLOB compressed or raw?
   - Raw = faster access, larger files
   - Compressed = smaller files, CPU overhead

2. **Render cache**: Include by default or opt-in?
   - Doubles file size but instant preview

3. **Multi-image documents**: Support multiple images per .nib?
   - Current design = 1 image per file
   - Could extend later with `image_id` foreign keys

4. **Session registry location**: In each .nib file or central `~/.nib/`?
   - In-file = self-contained but requires scanning
   - Central = fast lookup but external dependency

5. **Annotation styling by source**: Resolved - yes, visually distinguish by source
   - Agent annotations: monospaced/technical font, optional robot icon
   - Human annotations: natural/handwritten style
   - Both can use any color (user preference), distinction is in typography/iconography
