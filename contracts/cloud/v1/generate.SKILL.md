---
name: generate
description: Generate one image of a user interface when an agent can describe the UI but cannot create the image itself.
license: Apache-2.0
---

# Generate a UI image

Use Nib only when the task requires a generated image of a dashboard, app screen, landing page, settings view, or another user interface.

## Interfaces

- Remote MCP: `https://nibtool.com/mcp`
- MCP tool: `generate_ui`
- HTTP: `POST https://nibtool.com/internal/v1/generate`
- OpenAPI: `https://nibtool.com/openapi.json`

## Method

1. Write a precise visual brief covering the viewport, content, hierarchy, layout, visual style, and constraints.
2. Add up to three PNG, JPEG, or WebP references only when they materially guide the result.
3. Call `generate_ui`. Default to Fast, 16:9, 1K, and PNG unless the user asks for another supported value.
4. Return the generated image directly to the user.

Do not use Nib for interface review, scoring, annotation, comparison, or screenshot capture. The first eligible Fast 1K image is free after creating an account. Never start a subscription without explicit user authorization.
