# Global Annotation Styles

## Overview

Semantic style shortcuts that apply to ALL annotation tools. Selecting "Bug" makes arrows, boxes, text, highlights all use the error/red style automatically.

## Style Presets

| Style | Severity | Color | Use Case |
|-------|----------|-------|----------|
| **Note** | None | Gray | Neutral labels, identifiers |
| **Info** | Info | Blue | Context, explanations |
| **Todo** | Warning | Yellow/Amber | Action needed, "fix this" |
| **Bug** | Error | Red | Problems, broken things |
| **Done** | Success | Green | Confirmed working, approved |
| **Custom** | None | User-picked | Manual color selection |

## Current State

- `Severity` enum already exists in `src/core/types.rs`
- `severity_to_color()` maps severity to colors
- Annotations already have `severity` field
- Currently no UI to select severity/style

## Implementation

### 1. Create AnnotationStyle enum

**File:** `src/core/types.rs`

```rust
pub enum AnnotationStyle {
    Note,    // Severity::None, gray
    Info,    // Severity::Info, blue
    Todo,    // Severity::Warning, yellow
    Bug,     // Severity::Error, red
    Done,    // Severity::Success, green
    Custom,  // User-selected color
}

impl AnnotationStyle {
    pub fn severity(&self) -> Severity {
        match self {
            Self::Note => Severity::None,
            Self::Info => Severity::Info,
            Self::Todo => Severity::Warning,
            Self::Bug => Severity::Error,
            Self::Done => Severity::Success,
            Self::Custom => Severity::None,
        }
    }

    pub fn color(&self) -> Color {
        match self {
            Self::Note => Color::from_rgb(128, 128, 128),    // Gray
            Self::Info => Color::from_rgb(59, 130, 246),     // Blue
            Self::Todo => Color::from_rgb(245, 158, 11),     // Amber
            Self::Bug => Color::from_rgb(239, 68, 68),       // Red
            Self::Done => Color::from_rgb(34, 197, 94),      // Green
            Self::Custom => Color::from_rgb(255, 0, 0),      // Default red, overridden by picker
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Self::Note => "Note",
            Self::Info => "Info",
            Self::Todo => "Todo",
            Self::Bug => "Bug",
            Self::Done => "Done",
            Self::Custom => "Custom",
        }
    }
}
```

### 2. Add to EditorView

**File:** `src/gui/app.rs`

```rust
struct EditorView {
    // ... existing fields
    current_style: AnnotationStyle,  // Default: Note
    custom_color: Color,             // For Custom style
}
```

### 3. Update ToolContext

**File:** `src/gui/tools/context.rs`

```rust
pub struct ToolContext<'a> {
    // ... existing fields
    pub style: AnnotationStyle,
    pub custom_color: Color,  // Used when style == Custom
}

impl ToolContext<'_> {
    pub fn effective_color(&self) -> Color {
        match self.style {
            AnnotationStyle::Custom => self.custom_color,
            _ => self.style.color(),
        }
    }
}
```

### 4. Render style selector in toolbar

**File:** `src/gui/app.rs`

- Add row of style buttons: Note | Info | Todo | Bug | Done | Custom
- Visual indicator for active style (highlight/border)
- Custom button shows color swatch with current custom color

### 5. Update all tools

All tools change from:
```rust
.with_color(ctx.color)
```

To:
```rust
.with_color(ctx.effective_color())
.with_severity(ctx.style.severity())
```

### 6. Text-specific styling

Styles affect text appearance:

| Style | Font Size | Background |
|-------|-----------|------------|
| Note | 14px | None |
| Info | 16px | Blue tint (20% opacity) |
| Todo | 16px | Yellow tint (20% opacity) |
| Bug | 16px | Red tint (20% opacity) |
| Done | 16px | Green tint (20% opacity) |
| Custom | 16px | Dark background |

## Files to Modify

- `src/core/types.rs` - Add AnnotationStyle enum
- `src/gui/app.rs` - Add current_style, custom_color, render style selector
- `src/gui/tools/context.rs` - Add style to ToolContext, add effective_color()
- `src/gui/toolbar.rs` - Add style to ToolbarState
- `src/gui/tools/arrow.rs` - Use ctx.effective_color()
- `src/gui/tools/rectangle.rs` - Use ctx.effective_color()
- `src/gui/tools/ellipse.rs` - Use ctx.effective_color()
- `src/gui/tools/line.rs` - Use ctx.effective_color()
- `src/gui/tools/text.rs` - Use ctx.effective_color() + style-based formatting
- `src/gui/tools/number.rs` - Use ctx.effective_color()
- `src/gui/tools/highlight.rs` - Use ctx.effective_color()
- `src/gui/tools/blur.rs` - Use ctx.effective_color()

## Dependencies

None - this is the foundation feature.

## Acceptance Criteria

- [ ] Style selector visible in toolbar
- [ ] Clicking a style changes the active style
- [ ] All new annotations use the selected style's color
- [ ] All new annotations have severity set based on style
- [ ] Text annotations have style-appropriate formatting
- [ ] Custom style allows manual color selection
