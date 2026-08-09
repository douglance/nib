# @douglance/nib

Open visual tooling for AI agents: capture, annotation, human feedback, and hosted UI image generation.

## Installation

```bash
npm install -g @douglance/nib
```

Or use with npx:

```bash
npx @douglance/nib capture
```

## Usage with Claude Code

This package includes the Nib binary and its generated MCP server:

```bash
npx @douglance/nib --mcp
```

Or manually configure MCP:

```json
{
  "mcpServers": {
    "nib": {
      "command": "npx",
      "args": ["-y", "@douglance/nib", "--mcp"]
    }
  }
}
```

The MCP server projects the current CLI command catalog, so the host's
`tools/list` response is the source of truth for available tools.

## CLI Commands

```bash
nib capture              # Capture screen region
nib gui image.png        # Open GUI editor
nib add-annotation ...   # Add annotation headlessly
nib render image.png     # Render annotations onto image
nib find-text image.png  # OCR text detection
nib generate "A dark analytics dashboard" --output dashboard.png
```

Hosted generation requires a revocable Nib token from the public signup page:

```bash
export NIB_ACCESS_TOKEN="nib_live_..."
```

## License

Apache License 2.0. See LICENSE.
