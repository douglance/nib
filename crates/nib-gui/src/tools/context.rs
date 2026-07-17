//! Context provided to tools during event handling

use nib_core::{
    Annotation, AnnotationStyle, AnnotationType, ArrowHead, BlurIntensity, Color, Point,
    StrokeStyle,
};

use super::TEXT_FONT_SIZE;

/// Style option defaults used for newly-created annotations. Grouped into one struct
/// (rather than separate `EditorView` fields) so every `ToolContext` construction site
/// copies the same values through a single method instead of repeating each field
/// literally — see `StyleState::tool_context`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StyleState {
    /// Current annotation style (semantic preset)
    pub style: AnnotationStyle,
    /// Custom color (used when style == Custom)
    pub custom_color: Color,
    /// Current stroke width
    pub stroke_width: f64,
    /// Whether fill is enabled for shapes
    pub fill_enabled: bool,
    /// Current stroke style (solid/dashed/dotted)
    pub stroke_style: StrokeStyle,
    /// Current arrowhead placement
    pub arrow_head: ArrowHead,
    /// Current text font size
    pub font_size: f64,
    /// Current blur intensity
    pub blur_intensity: BlurIntensity,
    /// Current opacity (0.0-1.0), applied to the effective color's alpha
    pub opacity: f64,
}

impl Default for StyleState {
    fn default() -> Self {
        Self {
            style: AnnotationStyle::default(),
            custom_color: Color::RED,
            stroke_width: 2.0,
            fill_enabled: false,
            stroke_style: StrokeStyle::Solid,
            arrow_head: ArrowHead::End,
            font_size: TEXT_FONT_SIZE,
            blur_intensity: BlurIntensity::Medium,
            opacity: 1.0,
        }
    }
}

impl StyleState {
    /// Get the effective color based on style, with `opacity` applied to alpha.
    /// Returns custom_color if style is Custom, otherwise the style's default color.
    pub fn effective_color(&self) -> Color {
        let mut color = match self.style {
            AnnotationStyle::Custom => self.custom_color,
            _ => self.style.color(),
        };
        color.a = (self.opacity.clamp(0.0, 1.0) * 255.0).round() as u8;
        color
    }

    /// Build a `ToolContext` from this style state plus the coordinate/document
    /// state that varies per call. Takes `&self` (not `&EditorView`) so callers
    /// that need split borrows (e.g. borrowing `annotations` here while later
    /// mutably borrowing an unrelated `tool_manager` field) aren't blocked by the
    /// whole-`self` borrow a method on `EditorView` would require.
    pub fn tool_context<'a>(
        &self,
        image_size: (u32, u32),
        scale: f32,
        offset: (f32, f32),
        annotations: &'a [Annotation],
        min_drag_distance: f64,
    ) -> ToolContext<'a> {
        ToolContext {
            style: self.style,
            custom_color: self.custom_color,
            stroke_width: self.stroke_width,
            fill_enabled: self.fill_enabled,
            stroke_style: self.stroke_style,
            arrow_head: self.arrow_head,
            font_size: self.font_size,
            blur_intensity: self.blur_intensity,
            opacity: self.opacity,
            image_size,
            scale,
            offset,
            annotations,
            min_drag_distance,
        }
    }
}

/// Shared context provided to all tools
pub struct ToolContext<'a> {
    // === Drawing Properties ===
    /// Current annotation style (semantic preset)
    pub style: AnnotationStyle,
    /// Custom color (used when style == Custom)
    pub custom_color: Color,
    /// Current stroke width
    pub stroke_width: f64,
    /// Whether fill is enabled for shapes
    pub fill_enabled: bool,
    /// Current stroke style (solid/dashed/dotted)
    pub stroke_style: StrokeStyle,
    /// Current arrowhead placement
    pub arrow_head: ArrowHead,
    /// Current text font size
    pub font_size: f64,
    /// Current blur intensity
    pub blur_intensity: BlurIntensity,
    /// Current opacity (0.0-1.0), applied to the effective color's alpha
    pub opacity: f64,

    // === Coordinate System ===
    /// Image dimensions in pixels
    pub image_size: (u32, u32),
    /// Current scale factor (canvas / image)
    pub scale: f32,
    /// Offset for centered image rendering
    pub offset: (f32, f32),

    // === Document State (read-only) ===
    /// All existing annotations
    pub annotations: &'a [Annotation],

    // === Configuration ===
    /// Minimum drag distance to create annotation (pixels in image space)
    pub min_drag_distance: f64,
}

impl<'a> ToolContext<'a> {
    /// Get the effective color based on style, with `opacity` applied to alpha.
    /// Returns custom_color if style is Custom, otherwise the style's default color.
    pub fn effective_color(&self) -> Color {
        let mut color = match self.style {
            AnnotationStyle::Custom => self.custom_color,
            _ => self.style.color(),
        };
        color.a = (self.opacity.clamp(0.0, 1.0) * 255.0).round() as u8;
        color
    }

    /// Convert screen coordinates to image coordinates
    pub fn screen_to_image(&self, screen_x: f32, screen_y: f32) -> Point {
        let image_x = (screen_x - self.offset.0) / self.scale;
        let image_y = (screen_y - self.offset.1) / self.scale;
        Point::new(image_x as f64, image_y as f64)
    }

    /// Convert image coordinates to screen coordinates
    pub fn image_to_screen(&self, point: Point) -> (f32, f32) {
        let screen_x = (point.x as f32 * self.scale) + self.offset.0;
        let screen_y = (point.y as f32 * self.scale) + self.offset.1;
        (screen_x, screen_y)
    }

    /// Find annotation at point (for selection)
    pub fn annotation_at(&self, point: Point) -> Option<&'a Annotation> {
        self.annotations
            .iter()
            .rev() // Check top-most first (highest z-index)
            .filter(|a| a.visible)
            .find(|a| {
                let bounds = a.annotation_type.bounds();
                bounds.contains(point)
            })
    }

    /// Get next number value for Number tool
    pub fn next_number_value(&self) -> u32 {
        self.annotations
            .iter()
            .filter_map(|a| match &a.annotation_type {
                AnnotationType::Number { value, .. } => Some(*value),
                _ => None,
            })
            .max()
            .unwrap_or(0)
            + 1
    }
}
