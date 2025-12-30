# Color Picker

## Overview

Expose color picker in the toolbar for selecting custom colors. Used when "Custom" annotation style is selected.

## Current State

- `ColorPicker` struct exists in `src/gui/color_picker.rs` but is **unused**
- Has 10 predefined colors: RED, Orange, YELLOW, GREEN, BLUE, Purple, Pink, WHITE, Gray, BLACK
- Tracks recent colors (up to 5)
- Has `selected`, `is_open`, `recent` state

## Implementation

### 1. Add ColorPicker to EditorView

**File:** `src/gui/app.rs`

```rust
struct EditorView {
    // ... existing fields
    color_picker: ColorPicker,
}
```

Initialize in `new()`:
```rust
color_picker: ColorPicker::new(),
```

### 2. Render color swatch in toolbar

**File:** `src/gui/app.rs`

When Custom style is selected, show a color swatch button:
- Display current `custom_color` as filled square
- On click: toggle `color_picker.is_open`

```rust
// In render_toolbar()
if self.current_style == AnnotationStyle::Custom {
    div()
        .size_8()
        .rounded_sm()
        .bg(self.custom_color)
        .border_1()
        .border_color(white())
        .cursor_pointer()
        .on_click(|_| self.color_picker.toggle())
}
```

### 3. Render color palette popup

**File:** `src/gui/app.rs`

When `color_picker.is_open`:
- Show floating popup near the toolbar
- Grid of palette colors (2 rows x 5 columns)
- Row of recent colors below
- Click color: update `custom_color`, close picker

```rust
fn render_color_picker(&self) -> impl IntoElement {
    if !self.color_picker.is_open {
        return div();
    }

    div()
        .absolute()
        .bottom_16()  // Above toolbar
        .p_2()
        .bg(rgb(0x2d2d2d))
        .rounded_md()
        .shadow_lg()
        .child(
            // Palette grid
            div()
                .flex()
                .flex_wrap()
                .gap_1()
                .children(ColorPicker::PALETTE.iter().map(|color| {
                    div()
                        .size_6()
                        .rounded_sm()
                        .bg(*color)
                        .cursor_pointer()
                        .on_click(move |_| self.select_color(*color))
                }))
        )
        .child(
            // Recent colors
            div()
                .flex()
                .gap_1()
                .mt_2()
                .children(self.color_picker.recent.iter().map(|color| {
                    div()
                        .size_5()
                        .rounded_sm()
                        .bg(*color)
                        .cursor_pointer()
                        .on_click(move |_| self.select_color(*color))
                }))
        )
}
```

### 4. Handle color selection

```rust
fn select_color(&mut self, color: Color) {
    self.custom_color = color;
    self.color_picker.add_to_recent(color);
    self.color_picker.is_open = false;
}
```

## Files to Modify

- `src/gui/app.rs` - Add color_picker field, render UI, handle events

## Dependencies

- Global Annotation Styles (Custom style triggers color picker visibility)

## Acceptance Criteria

- [ ] Color swatch visible when Custom style is selected
- [ ] Clicking swatch opens color palette popup
- [ ] Clicking a palette color selects it and closes popup
- [ ] Selected color is used for new annotations
- [ ] Recent colors are tracked and displayed
- [ ] Clicking outside popup closes it
