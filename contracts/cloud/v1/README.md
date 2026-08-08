# Nib Cloud public contract v1

These fixtures define the public discovery seam implemented by the proprietary Nib Cloud runtime:

- `openapi.json`: HTTP generation contract.
- `mcp-tools.json`: normalized MCP `tools/list` contract.
- `generate.SKILL.md`: installable generation skill.

Private CI checks its generated responses against these files from a pinned public commit. Compatible additive changes require a new public fixture commit before the private runtime changes. Breaking changes require a new version directory.
