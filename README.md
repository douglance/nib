# Nib

Fast, native screenshot annotation tool with semantic visual communication.

Nib bridges human visual thinking with AI comprehension using QML (Quick Markup Language) - a semantic annotation protocol where every annotation type has defined meaning.

## Installation

### macOS (Homebrew)

```bash
brew install douglance/tap/nib
```

### Download Binary

Download the latest release for your platform from the [Releases](https://github.com/douglance/nib/releases) page.

### Build from Source

Requires Rust 1.75+

```bash
git clone https://github.com/douglance/nib.git
cd nib
cargo build --release
```

Binary will be at `target/release/nib`.

## Quick Start

```bash
# Capture a screen region
nib capture

# Open GUI editor
nib gui image.png

# Add annotation via CLI
nib add-annotation image.png -t rectangle -x 100 -y 100 -w 200 -H 50 -c "#ff0000"

# Render annotations onto image
nib render image.png
```

## Commands

| Command | Description |
|---------|-------------|
| `capture` | Capture screen region interactively |
| `gui <image>` | Open GUI annotation editor |
| `add-annotation` | Add annotation headlessly |
| `remove-annotation` | Remove annotation by ID |
| `clear-annotations` | Remove all annotations |
| `render` | Bake annotations into image |
| `read` | Extract QML from annotated image |
| `validate` | Check QML syntax validity |
| `find-text` | OCR text search in image |
| `grid` | Add coordinate grid overlay |
| `list` | List recent captures |
| `info` | Show image and annotation details |

## CLI Annotation Workflow

```bash
# 1. Capture screenshot
nib capture -o shot.png

# 2. Add annotation
nib add-annotation shot.png -t rectangle -x 100 -y 100 -w 50 -H 30 -c "#ff0000"
# Output: Added annotation [a1] rectangle at (100, 100)

# 3. Render to see result
nib render shot.png
# Output: shot.rendered.png

# 4. If wrong, remove and retry
nib remove-annotation shot.png a1

# 5. When done, clear all if needed
nib clear-annotations shot.png
```

## Annotation Types

| Category | Types |
|----------|-------|
| **Attention** | Arrow, Star, Circle, Box, Question |
| **Spatial** | Squeeze, Expand, Align, Width, Height |
| **Judgment** | Good, Bad, Warning, Priority |
| **Action** | Remove, Add, Swap, Move, Duplicate |
| **Content** | Text, Color, Typography |
| **Flow** | Sequence, Connects |

## OCR Text Search

```bash
# Find text in image
nib find-text image.png -s "search term"

# Highlight all detected text
nib find-text image.png --highlight --color "#ffff0080"
nib render image.png -o highlighted.png
```

## Grid Overlay

```bash
# Visual grid for coordinate reference
nib grid image.png --spacing 100 -o grid.png

# JSON metadata output
nib grid image.png --spacing 100 --json
```

## File Format

Nib uses `.nib` files - SQLite databases containing:
- Original image data
- Annotations in QML format
- Metadata and history

Annotations can also be stored as sidecar `.annotations.json` files for PNG/JPEG images.

## Platform Support

- **macOS** - Full support (primary target)
- **Linux** - Supported
- **Windows** - Supported

## License

MIT
