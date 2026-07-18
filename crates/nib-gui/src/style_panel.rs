//! Style popup flyout body: style/color swatches plus contextual style-option
//! rows (stroke width, fill, stroke style, arrowhead, font size, blur
//! intensity, opacity). `app.rs` renders only the trigger button and the
//! `.when(style_picker_open, ...)` call that invokes `EditorView::render_style_flyout`.

use gpui::prelude::FluentBuilder;
use gpui::{
    div, px, rgb, rgba, Context, InteractiveElement, IntoElement, ParentElement, Rgba,
    StatefulInteractiveElement, Styled,
};

use nib_core::{
    AnnotationId, AnnotationStyle, AnnotationType, ArrowHead, BlurIntensity, StrokeStyle,
};

use crate::app::EditorView;
use crate::layout::AlignMode;
use crate::tools::{SelectTool, ToolId};

/// Which contextual rows should be shown, given the active tool and the kinds of
/// annotation currently selected. Pure so it's directly unit-testable.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct RowVisibility {
    pub stroke_width: bool,
    pub fill: bool,
    pub stroke_style: bool,
    pub arrow_head: bool,
    pub font_size: bool,
    pub blur_intensity: bool,
}

/// tldraw semantics: a row shows when the active tool creates annotations that
/// use the field, OR the current selection contains at least one annotation
/// that has the field.
pub fn visible_rows(active_tool: ToolId, selected_kinds: &[&str]) -> RowVisibility {
    let has = |kinds: &[&str]| kinds.iter().any(|k| selected_kinds.contains(k));
    RowVisibility {
        stroke_width: matches!(
            active_tool,
            ToolId::Rectangle | ToolId::Arrow | ToolId::Ellipse | ToolId::Line | ToolId::Pencil
        ) || has(&["box", "arrow", "ellipse", "line", "path"]),
        fill: matches!(active_tool, ToolId::Rectangle | ToolId::Ellipse)
            || has(&["box", "ellipse"]),
        stroke_style: matches!(
            active_tool,
            ToolId::Rectangle | ToolId::Line | ToolId::Pencil
        ) || has(&["box", "line", "path"]),
        arrow_head: matches!(active_tool, ToolId::Arrow) || has(&["arrow"]),
        font_size: matches!(active_tool, ToolId::Text) || has(&["text"]),
        blur_intensity: matches!(active_tool, ToolId::Blur) || has(&["blur"]),
    }
}

impl EditorView {
    /// IDs of the currently selected annotations (empty if Select isn't active
    /// or nothing is selected).
    pub(crate) fn selected_annotation_ids(&self) -> Vec<AnnotationId> {
        self.tool_manager
            .get_tool_as::<SelectTool>(ToolId::Select)
            .map(|t| t.selected().to_vec())
            .unwrap_or_default()
    }

    /// `type_name()` of every currently selected annotation (for row visibility).
    fn selected_kinds(&self) -> Vec<&'static str> {
        let ids = self.selected_annotation_ids();
        self.annotations
            .iter()
            .filter(|a| ids.contains(&a.id))
            .map(|a| a.annotation_type.type_name())
            .collect()
    }

    /// tldraw semantics: apply `f` to every selected annotation's type (a no-op
    /// match arm handles variants that don't carry the field), record a history
    /// edit, and persist -- but only when there IS a selection. The caller always
    /// updates `style_state` (the default for new annotations) regardless of
    /// selection.
    fn apply_to_selected(&mut self, cx: &mut Context<Self>, f: impl Fn(&mut AnnotationType)) {
        let ids = self.selected_annotation_ids();
        if ids.is_empty() {
            return;
        }
        let mut edits = Vec::new();
        for ann in self.annotations.iter_mut().filter(|a| ids.contains(&a.id)) {
            let before = ann.clone();
            f(&mut ann.annotation_type);
            ann.touch();
            edits.push(crate::history::Edit::Replaced {
                before,
                after: ann.clone(),
            });
        }
        self.record_edit(crate::history::Edit::Batch(edits));
        self.save_annotations(cx);
    }

    fn set_stroke_width(&mut self, width: f64, cx: &mut Context<Self>) {
        self.style_state.stroke_width = width;
        self.apply_to_selected(cx, |t| match t {
            AnnotationType::Box { stroke_width, .. }
            | AnnotationType::Arrow { stroke_width, .. }
            | AnnotationType::Line { stroke_width, .. }
            | AnnotationType::Ellipse { stroke_width, .. }
            | AnnotationType::Path { stroke_width, .. } => *stroke_width = width,
            _ => {}
        });
        cx.notify();
    }

    fn set_fill_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.style_state.fill_enabled = enabled;
        self.apply_to_selected(cx, |t| match t {
            AnnotationType::Box { filled, .. } | AnnotationType::Ellipse { filled, .. } => {
                *filled = enabled;
            }
            _ => {}
        });
        cx.notify();
    }

    fn set_stroke_style(&mut self, style: StrokeStyle, cx: &mut Context<Self>) {
        self.style_state.stroke_style = style;
        self.apply_to_selected(cx, |t| match t {
            AnnotationType::Box { stroke_style, .. }
            | AnnotationType::Line { stroke_style, .. }
            | AnnotationType::Path { stroke_style, .. } => *stroke_style = style,
            _ => {}
        });
        cx.notify();
    }

    fn set_arrow_head(&mut self, head: ArrowHead, cx: &mut Context<Self>) {
        self.style_state.arrow_head = head;
        self.apply_to_selected(cx, |t| {
            if let AnnotationType::Arrow { head: h, .. } = t {
                *h = head;
            }
        });
        cx.notify();
    }

    fn set_font_size(&mut self, size: f64, cx: &mut Context<Self>) {
        self.style_state.font_size = size;
        self.apply_to_selected(cx, |t| {
            if let AnnotationType::Text { font_size, .. } = t {
                *font_size = size;
            }
        });
        cx.notify();
    }

    fn set_blur_intensity(&mut self, intensity: BlurIntensity, cx: &mut Context<Self>) {
        self.style_state.blur_intensity = intensity;
        self.apply_to_selected(cx, |t| {
            if let AnnotationType::Blur { intensity: i, .. } = t {
                *i = intensity;
            }
        });
        cx.notify();
    }

    fn set_opacity(&mut self, opacity: f64, cx: &mut Context<Self>) {
        self.style_state.opacity = opacity;
        let ids = self.selected_annotation_ids();
        if !ids.is_empty() {
            let alpha = (opacity.clamp(0.0, 1.0) * 255.0).round() as u8;
            let mut edits = Vec::new();
            for ann in self.annotations.iter_mut().filter(|a| ids.contains(&a.id)) {
                let before = ann.clone();
                ann.color.a = alpha;
                ann.touch();
                edits.push(crate::history::Edit::Replaced {
                    before,
                    after: ann.clone(),
                });
            }
            self.record_edit(crate::history::Edit::Batch(edits));
            self.save_annotations(cx);
        }
        cx.notify();
    }

    /// Renders the popup flyout body shown when the style-picker trigger is open:
    /// the style/color swatches (unchanged) followed by contextual rows for the
    /// style option fields relevant to the active tool/selection.
    pub(crate) fn render_style_flyout(
        &self,
        button_bg: Rgba,
        button_active_bg: Rgba,
        text_color: Rgba,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let rows = visible_rows(self.tool_manager.active_tool_id(), &self.selected_kinds());

        div()
            .absolute()
            .bottom(px(56.))
            .left(px(-138.))
            .flex()
            .flex_col()
            .gap_2()
            .px_2()
            .py_2()
            .bg(rgba(0x2d2d2dee))
            .rounded_lg()
            .border_1()
            .border_color(rgba(0x00000044))
            .shadow_lg()
            .child(self.render_style_swatches(button_bg, button_active_bg, text_color, cx))
            .when(rows.stroke_width, |el| {
                el.child(self.render_stroke_width_row(button_bg, button_active_bg, text_color, cx))
            })
            .when(rows.fill, |el| {
                el.child(self.render_fill_row(button_bg, button_active_bg, text_color, cx))
            })
            .when(rows.stroke_style, |el| {
                el.child(self.render_stroke_style_row(button_bg, button_active_bg, text_color, cx))
            })
            .when(rows.arrow_head, |el| {
                el.child(self.render_arrow_head_row(button_bg, button_active_bg, text_color, cx))
            })
            .when(rows.font_size, |el| {
                el.child(self.render_font_size_row(button_bg, button_active_bg, text_color, cx))
            })
            .when(rows.blur_intensity, |el| {
                el.child(self.render_blur_intensity_row(
                    button_bg,
                    button_active_bg,
                    text_color,
                    cx,
                ))
            })
            .when(self.selected_annotation_ids().len() >= 2, |el| {
                el.child(self.render_align_row(button_bg, text_color, cx))
            })
            .child(self.render_opacity_row(button_bg, button_active_bg, text_color, cx))
    }

    /// Align row (⇔ tldraw's align/distribute panel, minus distribute -- out
    /// of scope for Phase 5): six one-shot action buttons, shown only when
    /// ≥2 annotations are selected. Unlike the preset rows above there's no
    /// "current" value to highlight -- alignment is an action, not a toggle.
    fn render_align_row(
        &self,
        button_bg: Rgba,
        text_color: Rgba,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let options: [(&'static str, AlignMode); 6] = [
            ("⊢", AlignMode::Left),
            ("⊣⊢", AlignMode::CenterHorizontal),
            ("⊣", AlignMode::Right),
            ("⊤", AlignMode::Top),
            ("⊤⊥", AlignMode::CenterVertical),
            ("⊥", AlignMode::Bottom),
        ];

        div()
            .flex()
            .flex_row()
            .items_center()
            .gap_1()
            .child(
                div()
                    .w(px(52.))
                    .text_color(text_color)
                    .text_size(px(10.))
                    .child("Align"),
            )
            .children(options.into_iter().map(|(label, mode)| {
                div()
                    .id(label)
                    .flex()
                    .items_center()
                    .justify_center()
                    .h(px(24.))
                    .px(px(6.))
                    .rounded_md()
                    .cursor_pointer()
                    .bg(rgba(0x3d3d3d00))
                    .hover(|s| s.bg(button_bg))
                    .text_color(text_color)
                    .text_size(px(10.))
                    .child(label)
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        this.align_selected(mode, cx);
                    }))
            }))
    }

    fn render_style_swatches(
        &self,
        button_bg: Rgba,
        button_active_bg: Rgba,
        text_color: Rgba,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div()
            .flex()
            .flex_row()
            .gap_1()
            .children(AnnotationStyle::all().iter().map(|style| {
                let is_active = *style == self.style_state.style;
                let style_copy = *style;
                let style_color = if *style == AnnotationStyle::Custom {
                    self.style_state.custom_color
                } else {
                    style.color()
                };
                let gpui_style_color = rgb(style_color.r as u32 * 0x10000
                    + style_color.g as u32 * 0x100
                    + style_color.b as u32);

                div()
                    .id(style.label())
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .w(px(48.))
                    .h(px(48.))
                    .rounded_md()
                    .cursor_pointer()
                    .bg(if is_active {
                        button_active_bg
                    } else {
                        rgba(0x3d3d3d00)
                    })
                    .hover(|s| s.bg(button_bg))
                    .child(
                        div()
                            .w(px(20.))
                            .h(px(20.))
                            .rounded_full()
                            .bg(gpui_style_color)
                            .border_2()
                            .border_color(if is_active {
                                rgb(0xffffff)
                            } else {
                                rgba(0xffffff66)
                            }),
                    )
                    .child(
                        div()
                            .text_color(text_color)
                            .text_size(px(9.))
                            .mt(px(2.))
                            .child(style.label()),
                    )
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        this.style_state.style = style_copy;
                        this.style_picker_open = false;
                        cx.notify();
                    }))
            }))
    }

    fn render_stroke_width_row(
        &self,
        button_bg: Rgba,
        button_active_bg: Rgba,
        text_color: Rgba,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let current = self.style_state.stroke_width;
        render_option_row(
            "Stroke",
            &[("S", 2.0_f64), ("M", 4.0), ("L", 8.0)],
            current,
            button_bg,
            button_active_bg,
            text_color,
            cx,
            |this, value, cx| this.set_stroke_width(value, cx),
        )
    }

    fn render_fill_row(
        &self,
        button_bg: Rgba,
        button_active_bg: Rgba,
        text_color: Rgba,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let current = self.style_state.fill_enabled;
        render_option_row(
            "Fill",
            &[("Off", false), ("On", true)],
            current,
            button_bg,
            button_active_bg,
            text_color,
            cx,
            |this, value, cx| this.set_fill_enabled(value, cx),
        )
    }

    fn render_stroke_style_row(
        &self,
        button_bg: Rgba,
        button_active_bg: Rgba,
        text_color: Rgba,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let current = self.style_state.stroke_style;
        render_option_row(
            "Line",
            &[
                ("Solid", StrokeStyle::Solid),
                ("Dashed", StrokeStyle::Dashed),
                ("Dotted", StrokeStyle::Dotted),
            ],
            current,
            button_bg,
            button_active_bg,
            text_color,
            cx,
            |this, value, cx| this.set_stroke_style(value, cx),
        )
    }

    fn render_arrow_head_row(
        &self,
        button_bg: Rgba,
        button_active_bg: Rgba,
        text_color: Rgba,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let current = self.style_state.arrow_head;
        render_option_row(
            "Arrow",
            &[
                ("End", ArrowHead::End),
                ("Start", ArrowHead::Start),
                ("Both", ArrowHead::Both),
                ("None", ArrowHead::None),
            ],
            current,
            button_bg,
            button_active_bg,
            text_color,
            cx,
            |this, value, cx| this.set_arrow_head(value, cx),
        )
    }

    fn render_font_size_row(
        &self,
        button_bg: Rgba,
        button_active_bg: Rgba,
        text_color: Rgba,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let current = self.style_state.font_size;
        render_option_row(
            "Font",
            &[("S", 16.0_f64), ("M", 24.0), ("L", 32.0)],
            current,
            button_bg,
            button_active_bg,
            text_color,
            cx,
            |this, value, cx| this.set_font_size(value, cx),
        )
    }

    fn render_blur_intensity_row(
        &self,
        button_bg: Rgba,
        button_active_bg: Rgba,
        text_color: Rgba,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let current = self.style_state.blur_intensity;
        render_option_row(
            "Blur",
            &[
                ("Light", BlurIntensity::Light),
                ("Medium", BlurIntensity::Medium),
                ("Heavy", BlurIntensity::Heavy),
                ("Pixelate", BlurIntensity::Pixelate),
            ],
            current,
            button_bg,
            button_active_bg,
            text_color,
            cx,
            |this, value, cx| this.set_blur_intensity(value, cx),
        )
    }

    fn render_opacity_row(
        &self,
        button_bg: Rgba,
        button_active_bg: Rgba,
        text_color: Rgba,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let current = self.style_state.opacity;
        render_option_row(
            "Opacity",
            &[
                ("25%", 0.25_f64),
                ("50%", 0.5),
                ("75%", 0.75),
                ("100%", 1.0),
            ],
            current,
            button_bg,
            button_active_bg,
            text_color,
            cx,
            |this, value, cx| this.set_opacity(value, cx),
        )
    }
}

/// Renders one labeled row of preset-value buttons, highlighting whichever preset
/// matches `current` and dispatching `apply` on click. Shared by every style-option
/// row so each one is a short call instead of hand-rolled button markup.
#[allow(clippy::too_many_arguments)] // shared row builder for 7 style-option rows, kept flat over grouping into structs
fn render_option_row<T: Copy + PartialEq + 'static>(
    label: &'static str,
    options: &[(&'static str, T)],
    current: T,
    button_bg: Rgba,
    button_active_bg: Rgba,
    text_color: Rgba,
    cx: &mut Context<EditorView>,
    apply: impl Fn(&mut EditorView, T, &mut Context<EditorView>) + Clone + 'static,
) -> impl IntoElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap_1()
        .child(
            div()
                .w(px(52.))
                .text_color(text_color)
                .text_size(px(10.))
                .child(label),
        )
        .children(options.iter().map(|(option_label, value)| {
            let value = *value;
            let is_active = value == current;
            let apply = apply.clone();
            div()
                .id(*option_label)
                .flex()
                .items_center()
                .justify_center()
                .h(px(24.))
                .px(px(6.))
                .rounded_md()
                .cursor_pointer()
                .bg(if is_active {
                    button_active_bg
                } else {
                    rgba(0x3d3d3d00)
                })
                .hover(|s| s.bg(button_bg))
                .text_color(text_color)
                .text_size(px(10.))
                .child(*option_label)
                .on_click(cx.listener(move |this, _event, _window, cx| {
                    apply(this, value, cx);
                }))
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_tool_with_no_selection_shows_no_rows() {
        let rows = visible_rows(ToolId::Select, &[]);
        assert_eq!(rows, RowVisibility::default());
    }

    #[test]
    fn rectangle_tool_shows_stroke_width_fill_and_stroke_style() {
        let rows = visible_rows(ToolId::Rectangle, &[]);
        assert!(rows.stroke_width);
        assert!(rows.fill);
        assert!(rows.stroke_style);
        assert!(!rows.arrow_head);
        assert!(!rows.font_size);
        assert!(!rows.blur_intensity);
    }

    #[test]
    fn arrow_tool_shows_stroke_width_and_arrow_head_only() {
        let rows = visible_rows(ToolId::Arrow, &[]);
        assert!(rows.stroke_width);
        assert!(rows.arrow_head);
        assert!(!rows.fill);
        assert!(!rows.stroke_style);
    }

    #[test]
    fn text_tool_shows_font_size_only() {
        let rows = visible_rows(ToolId::Text, &[]);
        assert!(rows.font_size);
        assert!(!rows.stroke_width);
    }

    #[test]
    fn selection_of_box_shows_rows_even_with_select_tool_active() {
        let rows = visible_rows(ToolId::Select, &["box"]);
        assert!(rows.stroke_width);
        assert!(rows.fill);
        assert!(rows.stroke_style);
        assert!(!rows.arrow_head);
    }

    #[test]
    fn selection_of_blur_shows_blur_intensity_row() {
        let rows = visible_rows(ToolId::Select, &["blur"]);
        assert!(rows.blur_intensity);
        assert!(!rows.stroke_width);
    }
}
