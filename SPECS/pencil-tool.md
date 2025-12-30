# Pencil Tool

## Overview

Free-form drawing tool for creating path annotations. User draws by clicking and dragging; the resulting path is stored as a series of points.

## Implementation

### 1. Add AnnotationType::Path variant

**File:** `src/core/types.rs`

```rust
pub enum AnnotationType {
    // ... existing variants
    Path {
        points: Vec<Point>,
        stroke_width: f64,
        stroke_style: StrokeStyle,
    },
}
```

### 2. Add ToolId::Pencil

**File:** `src/gui/tools/trait.rs`

```rust
pub enum ToolId {
    Select,
    Arrow,
    Rectangle,
    Ellipse,
    Line,
    Text,
    Number,
    Highlight,
    Blur,
    Crop,
    Pencil,  // NEW
}
```

### 3. Add ToolPreview::Path variant

**File:** `src/gui/tools/mod.rs`

```rust
pub enum ToolPreview {
    // ... existing variants
    Path {
        points: Vec<Point>,
        color: Color,
        stroke_width: f64,
    },
}
```

### 4. Create PencilTool

**File:** `src/gui/tools/pencil.rs` (NEW FILE)

```rust
use super::*;

pub struct PencilTool {
    points: Vec<Point>,
    is_drawing: bool,
}

impl PencilTool {
    pub fn new() -> Self {
        Self {
            points: Vec::new(),
            is_drawing: false,
        }
    }
}

impl Tool for PencilTool {
    fn id(&self) -> ToolId {
        ToolId::Pencil
    }

    fn name(&self) -> &'static str {
        "Pencil"
    }

    fn shortcut(&self) -> char {
        'p'
    }

    fn icon_path(&self) -> &'static str {
        "icons/pencil.svg"
    }

    fn handle_event(&mut self, event: ToolEvent, ctx: &ToolContext) -> ToolResult {
        match event {
            ToolEvent::MouseDown { position, button: MouseButton::Left, .. } => {
                let image_pos = ctx.screen_to_image(position.x, position.y);
                self.points.clear();
                self.points.push(image_pos);
                self.is_drawing = true;
                ToolResult::Handled
            }

            ToolEvent::MouseMove { position, .. } if self.is_drawing => {
                let image_pos = ctx.screen_to_image(position.x, position.y);

                // Only add point if it's far enough from the last point
                // This prevents too many points when moving slowly
                if let Some(last) = self.points.last() {
                    if last.distance_to(image_pos) >= 2.0 {
                        self.points.push(image_pos);
                    }
                }

                ToolResult::Handled
            }

            ToolEvent::MouseUp { button: MouseButton::Left, .. } if self.is_drawing => {
                self.is_drawing = false;

                // Need at least 2 points to create a path
                if self.points.len() < 2 {
                    self.points.clear();
                    return ToolResult::Ignored;
                }

                let annotation = Annotation::new(AnnotationType::Path {
                    points: self.points.clone(),
                    stroke_width: ctx.stroke_width,
                    stroke_style: StrokeStyle::Solid,
                })
                .with_color(ctx.effective_color())
                .with_severity(ctx.style.severity());

                self.points.clear();
                ToolResult::Created(annotation)
            }

            _ => ToolResult::Ignored,
        }
    }

    fn preview(&self, ctx: &ToolContext) -> ToolPreview {
        if self.is_drawing && !self.points.is_empty() {
            ToolPreview::Path {
                points: self.points.clone(),
                color: ctx.effective_color(),
                stroke_width: ctx.stroke_width,
            }
        } else {
            ToolPreview::None
        }
    }

    fn reset(&mut self) {
        self.points.clear();
        self.is_drawing = false;
    }

    fn is_active(&self) -> bool {
        self.is_drawing
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}
```

### 5. Register tool in manager

**File:** `src/gui/tools/manager.rs`

```rust
pub fn with_all_tools() -> Self {
    let mut manager = Self::new();
    // ... existing tools
    manager.register(Box::new(super::PencilTool::new()));
    manager
}
```

### 6. Export in mod.rs

**File:** `src/gui/tools/mod.rs`

```rust
mod pencil;
pub use pencil::PencilTool;
```

### 7. Render path preview

**File:** `src/gui/app.rs`

In the preview rendering section:

```rust
ToolPreview::Path { points, color, stroke_width } => {
    // Convert points to screen coordinates and draw polyline
    let screen_points: Vec<_> = points
        .iter()
        .map(|p| self.image_to_screen(*p))
        .collect();

    // Draw lines between consecutive points
    for window in screen_points.windows(2) {
        let start = window[0];
        let end = window[1];
        // Draw line segment from start to end
    }
}
```

### 8. Export path annotation

**File:** `src/storage/export.rs`

```rust
AnnotationType::Path { points, stroke_width, stroke_style } => {
    // Draw polyline connecting all points
    let color = annotation.color.to_rgba();

    for window in points.windows(2) {
        let start = window[0];
        let end = window[1];

        draw_line_segment_mut(
            &mut img,
            (start.x as f32, start.y as f32),
            (end.x as f32, end.y as f32),
            Rgba([color.0, color.1, color.2, color.3]),
        );
    }
}
```

### 9. Serialize path annotation

**File:** `src/storage/nib_file.rs`

```rust
#[derive(Serialize, Deserialize)]
struct PathData {
    points: Vec<PointData>,
    stroke_width: f64,
    stroke_style: String,
}

#[derive(Serialize, Deserialize)]
struct PointData {
    x: f64,
    y: f64,
}
```

### 10. QML format support

**File:** `src/core/qml.rs`

```
PATH@x1,y1;x2,y2;x3,y3->"label"!severity
```

Example:
```
a1:PATH@100,100;150,120;200,150;180,200->"freehand circle"!info
```

## Files to Modify

- `src/core/types.rs` - Add Path variant to AnnotationType
- `src/gui/tools/trait.rs` - Add Pencil to ToolId
- `src/gui/tools/mod.rs` - Add Path to ToolPreview, export PencilTool
- `src/gui/tools/pencil.rs` - **NEW FILE**
- `src/gui/tools/manager.rs` - Register PencilTool
- `src/gui/app.rs` - Render Path preview
- `src/storage/export.rs` - Export Path annotations
- `src/storage/nib_file.rs` - Serialize/deserialize PathData
- `src/core/qml.rs` - PATH annotation format

## Dependencies

- Global Annotation Styles (for ctx.effective_color() and ctx.style.severity())

## Acceptance Criteria

- [ ] Pencil tool appears in toolbar with 'p' shortcut
- [ ] Click and drag creates a path
- [ ] Path preview shows while drawing
- [ ] Released path creates an annotation
- [ ] Path uses current style color and severity
- [ ] Path is exported/rendered correctly
- [ ] Path is serialized to .nib format
- [ ] Path is encoded in QML format
