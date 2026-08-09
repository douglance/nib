# Nib

The fastest way for humans to review AI-generated software.

Nib is the human-decision layer for autonomous software. Software sends a portable request containing evidence, policy, and the decision it needs. A human or review agent returns a structured decision that the originating software can consume.

Tests verify behavior. Nib verifies intent.

```ts
const decision = await nib.request({
  title: "Approve checkout redesign",
  artifacts,
}).wait();
```

The protocol, `.nib` format, CLI, SDKs, reviewer, and integrations are open source under Apache 2.0. Nib Cloud provides the managed network, billing, routing, delivery, and organization controls. See [the protocol](docs/protocol.md), [hosted request API](docs/request-api.md), and [open-core boundary](docs/open-core.md).

## Installation

### macOS (Homebrew)

```bash
brew install douglance/tap/nib
```

### Download Binary

Download the latest release for your platform from the [Releases](https://github.com/douglance/nib/releases) page.

### Build from Source

Requires Rust 1.88+

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

# Generate a UI image through the hosted service
export NIB_ACCESS_TOKEN="nib_live_..."
nib generate "A compact dark fleet analytics dashboard" --output dashboard.png
```

## Commands

| Command | Description |
|---------|-------------|
| `capture` | Capture screen region interactively |
| `generate` | Generate one UI image through the hosted Nib service |
| `gui <image>` | Open GUI annotation editor |
| `add-annotation` | Add annotation headlessly |
| `remove-annotation` | Remove annotation by ID |
| `clear-annotations` | Remove all annotations |
| `render` | Bake annotations into image |
| `read` | Extract QML from annotated image |
| `validate` | Check QML syntax validity |
| `find-text` | OCR text search in image |
| `grid` | Add coordinate grid overlay |
| `feedback` | Wait for human feedback in GPUI or a full-color terminal review window |
| `review` | Open an existing feedback session in the terminal reviewer |
| `request create` | Publish a durable request and return its request ID and review link |
| `request get` | Read the current canonical request state |
| `request wait` | Wait for a final structured decision without keeping CI alive |
| `request watch` | Read replayable request events |
| `request approve`, `request reject`, `request request-changes` | Submit a machine-readable decision |
| `pack`, `unpack`, `inspect` | Create, extract, or inspect a portable SQLite `.nib` request pack |
| `watch` | Watch a .nib file for annotation changes |
| `list` | List recent captures |
| `info` | Show image and annotation details |

Create a request directly from protocol JSON:

```bash
nib request create request.json
# { "request": { "id": "req_..." }, "reviewLink": "https://nibtool.com/r/..." }

nib request wait req_...
```

The GitHub Action, TypeScript SDK, Playwright reporter, Cypress adapter, and
delivery adapters live in [`integrations`](integrations) and [`packages`](packages).
Review links work in a browser without installing Nib or creating an account.

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
# Publish to a configured Nib portal, then wait for the first response.
# If the portal is unavailable, auto falls back to terminal review in tmux or the GUI.
nib feedback shot.png -t 120

# Require a configured web reviewer (no local fallback)
nib feedback shot.png --ui web -m "Ship this image?" -t 0

# Keep the agent pane noninteractive while review happens in a temporary tmux window
nib feedback shot.png --ui terminal -m "Ship this image?" -t 0

# Open without blocking, then await the same deterministic .nib session
nib feedback shot.png --ui terminal --detach
nib await-submit shot.nib --feedback -t 0 --json

# Zoom in around the annotation (x1,y1,x2,y2)
nib grid shot.rendered.png --region "1900,650,2300,850" -o shot.zoom.png
```

Terminal review sends lossless Kitty/iTerm image data and deliberately has no
character-art fallback. It supports true SSH, but rejects vmux/mosh because
mosh synchronizes terminal cell state rather than forwarding graphics control
sequences.

Web review requires `NIB_PORTAL_URL` to point at a deployment you control. The
CLI publishes the preview and canonical `.nib` together, prints the versioned
response JSON, and merges returned annotations into the originating `.nib`
file. The portal source is included under `apps/portal`.

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
cargo build --release
codex mcp add nib -- /absolute/path/to/nib --mcp
```

## Optional UI generation

The public `nib-ui` crate and generated command catalog expose `generate_ui`
through the hosted Nib service as an artifact generator. It is not the Nib Request primitive. The public interface is documented at
<https://nibtool.com> and versioned under
[`contracts/cloud/v1`](contracts/cloud/v1). Production model orchestration, account controls, billing, abuse controls, and operations are private Nib Cloud components.

The public site source lives in `apps/site`. From the repository root, build it
with `cargo run --manifest-path apps/site/Cargo.toml -- --export apps/site/dist`
or deploy its Worker with `wrangler deploy --config apps/site/wrangler.jsonc`.

## `.nib` file format

Nib uses portable SQLite `.nib` files. Schema version 4 stores:

- Versioned Nib Request JSON
- Content-addressed image, video, HTML, JSON, and file bytes
- External artifact references with byte length and SHA-256 integrity
- Append-only decisions, feedback, and replayable events
- Legacy image data, QML annotations, metadata, and history

Nib stores embedded media bytes without recompression. Schema versions 1 through 3 remain readable and upgrade transactionally on the first protocol write.

Annotations can also be stored as sidecar `.annotations.json` files for PNG/JPEG images.

## Platform Support

- **macOS** - Full support (primary target)
- **Linux** - Supported
- **Windows** - Supported

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
