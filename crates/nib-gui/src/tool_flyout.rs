//! Shape-tool flyout: groups Rectangle/Ellipse/Line/Pencil/Highlight behind
//! one toolbar button (tldraw-style, reusing the style-popup pattern from
//! `style_panel.rs`), freeing 4 toolbar slots so Eraser/Sticky/Image fit
//! within the toolbar width budget. `app.rs` renders only the trigger
//! button; this module renders the popup body.

use gpui::{
    div, px, rgba, svg, Context, InteractiveElement, IntoElement, ParentElement, Rgba,
    StatefulInteractiveElement, Styled,
};

use crate::app::EditorView;
use crate::toolbar::Tool;

/// The shape tools grouped behind the flyout, in display order.
pub const SHAPE_TOOLS: [Tool; 5] = [
    Tool::Rectangle,
    Tool::Ellipse,
    Tool::Line,
    Tool::Pencil,
    Tool::Highlight,
];

impl EditorView {
    /// Which shape tool's icon the trigger button should show: the active
    /// one if it's a shape tool, otherwise Rectangle as a stable default.
    pub(crate) fn shape_flyout_icon(&self) -> Tool {
        if SHAPE_TOOLS.contains(&self.active_tool) {
            self.active_tool
        } else {
            Tool::Rectangle
        }
    }

    /// Renders the flyout popup body: one button per grouped shape tool.
    /// Selecting one closes the popup, mirroring the style-picker swatches.
    pub(crate) fn render_shape_flyout(
        &self,
        button_bg: Rgba,
        button_active_bg: Rgba,
        text_color: Rgba,
        icon_color: Rgba,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div()
            .absolute()
            .bottom(px(60.))
            .left(px(-28.))
            .flex()
            .flex_row()
            .gap_1()
            .px_2()
            .py_2()
            .bg(rgba(0x2d2d2dee))
            .rounded_lg()
            .border_1()
            .border_color(rgba(0x00000044))
            .shadow_lg()
            .children(SHAPE_TOOLS.iter().map(|tool| {
                let is_active = *tool == self.active_tool;
                let tool_copy = *tool;

                div()
                    .id(tool.name())
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
                        svg()
                            .path(tool.icon_path())
                            .size(px(24.))
                            .text_color(icon_color),
                    )
                    .child(crate::app::render_shortcut_badge(
                        tool.shortcut().to_ascii_uppercase().to_string(),
                        text_color,
                    ))
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        this.select_tool(tool_copy, cx);
                        this.shape_flyout_open = false;
                        cx.notify();
                    }))
            }))
    }
}
