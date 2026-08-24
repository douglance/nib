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

### Ship every local surface

From a macOS development checkout, one command installs the release CLI and
GUI globally, syncs the Nib skills to the shared agent roots, deploys the
global Cloudflare request service, and installs and launches the signed native
apps:

```bash
make ship-everywhere
```

The defaults target Nib Cloud. Override `NIB_BIN_DIR`, `NIB_MAC_APP_DIR`,
`NIB_IOS_DESTINATION_ID`, `NIB_IOS_DEVICE_ID`,
`NIB_WATCH_DEVICE_ID`, or `NIB_APPLE_TEAM_ID` when shipping from another Mac,
server, or device. Cloudflare Durable Objects preserve request state and R2
preserves review media. The Watch app is always embedded in the installed iPhone
bundle; direct Watch installation is best-effort because a sleeping paired
Watch may not expose a Bluetooth developer tunnel.

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
| `feedback` | Publish a durable review and wait for its response |
| `request wait` | Resume waiting for a durable request by ID |
| `record` | Start, inspect, stop, or wait for a durable macOS screen recording |
| `media` | Inspect H.264 MP4 media, extract a poster, or request transcription |
| `auth` | Enroll clients and manage scoped credentials |
| `review` | Open an existing feedback session in the terminal reviewer |
| `watch` | Watch a .nib file for annotation changes |
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

## Image-First Feedback Loop (Fast)

Nib is designed for image-based communication. After each annotation event, the agent must inspect the image (zoom first, then full if unclear).

```bash
# Open the installed Nib macOS app and wait indefinitely.
nib feedback shot.png

# Explicitly select the shared request bus
nib feedback shot.png --ui web -m "Ship this image?" -t 0

# If an attached wait is interrupted, resume the same published request.
nib request wait REQUEST_ID

# Explicitly select the native macOS app
nib feedback shot.png --ui native -m "Ship this image?" -t 0

# Prefer the shared web reviewer, with a local fallback if it is unavailable
nib feedback shot.png --ui auto -m "Ship this image?" -t 0

# Record silently by default, then publish the resulting H.264 MP4.
nib record start --duration 30 --output /tmp/demo.mp4 --format json
nib record wait RECORDING_ID
nib feedback /tmp/demo.mp4 --format json

# Keep the agent pane noninteractive while review happens in a temporary tmux window
nib feedback shot.png --ui terminal -m "Ship this image?" -t 0

# Zoom in around the annotation (x1,y1,x2,y2)
nib grid shot.rendered.png --region "1900,650,2300,850" -o shot.zoom.png
```

`nib feedback` stays attached and waits for the response by default. Use
`--detach` only when the caller explicitly asks to publish without waiting.

Terminal review sends lossless Kitty/iTerm image data and deliberately has no
character-art fallback. It supports true SSH, but rejects vmux/mosh because
mosh synchronizes terminal cell state rather than forwarding graphics control
sequences.

Durable review uses the fixed `https://nibtool.com` service. Run
`nib auth login you@example.com` once and open the emailed sign-in link. The CLI
stores the resulting account session in macOS Keychain. `NIB_AUTH_TOKEN` remains
an explicit automation override and should not be stored in an app or shell
profile. Native Apple clients use the same email sign-in flow.
The CLI publishes the preview and canonical `.nib` together, prints the
versioned response JSON, and merges returned annotations into the originating
`.nib` file.

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

## Inline Codex Feedback

Build Nib with the `mcp` feature and configure its MCP server in Codex. The
`present_image` tool returns lossless image bytes as first-class MCP image
content, so Codex displays the image inside the current thread and collects the
human's next message as feedback. It does not depend on terminal graphics or a
machine-local file link.

```bash
cargo build --release --features mcp
codex mcp add nib -- /absolute/path/to/nib --mcp
```

Incurs Code Mode is the primary interface on that server. `codemode_search`
discovers the composable methods and `codemode_execute` runs one JavaScript
program over the typed recording, media, annotation, and review primitives, with
`codemode_execution`, `codemode_decide`, and `codemode_cancel` covering the rest
of the lifecycle. Prefer a single program over a chain of direct tool calls; the
direct tools stay listed for one-off work and for `present_image`, which must
return first-class inline MCP content. Executions, snippets, and artifacts use
Nib's durable local storage, so execution state survives an MCP restart.

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
