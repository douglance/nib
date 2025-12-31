# @douglance/nib

Screenshot annotation tool that bridges human visual thinking with AI comprehension.

## Installation

```bash
npm install -g @douglance/nib
```

Or use with npx:

```bash
npx @douglance/nib capture
```

## Usage with Claude Code

This package includes an MCP server for use with Claude Code:

```bash
# Add the plugin marketplace
/plugin marketplace add douglance/nib

# Install the plugin
/plugin install nib
```

Or manually configure MCP:

```json
{
  "mcpServers": {
    "nib": {
      "command": "npx",
      "args": ["-y", "@douglance/nib", "mcp-server"]
    }
  }
}
```

## MCP Tools

- `add_annotation` - Add annotations (arrow, rectangle, text, etc.)
- `read_annotations` - List all annotations on an image
- `remove_annotation` - Remove annotation by ID
- `clear_annotations` - Clear all annotations
- `render` - Bake annotations onto image
- `wait_for_events` - Wait for human annotation events

## CLI Commands

```bash
nib capture              # Capture screen region
nib gui image.png        # Open GUI editor
nib add-annotation ...   # Add annotation headlessly
nib render image.png     # Render annotations onto image
nib find-text image.png  # OCR text detection
```

## License

Commercial - See LICENSE file
