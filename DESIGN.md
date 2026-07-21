# Nib design language

The native desktop editor is Nib's visual source of truth. Web, iPhone, Watch,
and terminal surfaces adapt its hierarchy to their input model without creating
a separate brand.

## Tokens

| Role | Canonical value | Use |
| --- | --- | --- |
| App background | `#101010` | Top-level product chrome |
| Canvas/sunken surface | `#181818` / `#08080858` | Work areas and request shells |
| Floating surface | `#2c2c2ce8` | Toolbars, menus, compact controls |
| Primary text | `#f2f2f2` | Titles and actionable labels |
| Secondary text | `#cccccc` | Metadata, hints, inactive controls |
| Hairline | `#ffffff24` | Surface borders and separators |
| Focus/selection | `#0078d4` | Active tools, keyboard focus, selection |
| Approve | `#2e7d32` | Approval actions and outcomes only |
| Reject | `#c62828` | Rejection actions and failures only |
| Neutral action | `#4a4a4a` | Comment, cancel, and secondary actions |

Use system sans type in graphical apps and the terminal's monospace face in the
TUI. Controls use 6-10px radii, 1px hairlines, restrained shadows, and compact
spacing. Mobile controls may grow to 44pt without changing the hierarchy.

## Product hierarchy

1. Keep the reviewed artifact dominant.
2. Put request context and response controls in a dedicated rail or sheet.
3. Keep annotation tools together in a floating graphite toolbar.
4. Reserve semantic color for focus and decisions; never use amber to imply row priority.
5. Keep the same words everywhere: **Approve**, **Reject**, and **Comment**.

## Cross-surface contract

Every client consumes the same `RequestRecord` and submits the same structured
visual-review response: `decision`, optional `comment`, and `annotations` under
`nib.visual-review/v1`. Presentation may adapt, but decision names, one-shot
semantics, publication requirements, and attachment roles may not diverge.
