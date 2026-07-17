//! GPUI Application setup
//!
//! This module provides the main GPUI-based graphical interface for Nib.

use gpui::{
    canvas, div, img, point, px, rgb, rgba, size, svg, App, AppContext, Application, AssetSource,
    Bounds, Context, Div, FocusHandle, Focusable, InteractiveElement, IntoElement, KeyDownEvent,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, PathBuilder, Point,
    Render, Result as GpuiResult, ScrollWheelEvent, SharedString, Size, StatefulInteractiveElement,
    Styled, StyledImage, Task, Window, WindowBounds, WindowKind, WindowOptions,
};
use gpui::prelude::FluentBuilder;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use std::borrow::Cow;
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

/// Embedded SVG icons (compile-time included for portable binary)
mod embedded_icons {
    pub static SELECT: &[u8] = include_bytes!("../../../assets/icons/select.svg");
    pub static ARROW: &[u8] = include_bytes!("../../../assets/icons/arrow.svg");
    pub static RECTANGLE: &[u8] = include_bytes!("../../../assets/icons/rectangle.svg");
    pub static ELLIPSE: &[u8] = include_bytes!("../../../assets/icons/ellipse.svg");
    pub static TEXT: &[u8] = include_bytes!("../../../assets/icons/text.svg");
    pub static NUMBER: &[u8] = include_bytes!("../../../assets/icons/number.svg");
    pub static BLUR: &[u8] = include_bytes!("../../../assets/icons/blur.svg");
    pub static HIGHLIGHT: &[u8] = include_bytes!("../../../assets/icons/highlight.svg");
    pub static LINE: &[u8] = include_bytes!("../../../assets/icons/line.svg");
    pub static CROP: &[u8] = include_bytes!("../../../assets/icons/crop.svg");
    pub static PENCIL: &[u8] = include_bytes!("../../../assets/icons/pencil.svg");
    pub static ERASER: &[u8] = include_bytes!("../../../assets/icons/eraser.svg");
    pub static STICKY: &[u8] = include_bytes!("../../../assets/icons/sticky.svg");

    pub fn get(path: &str) -> Option<&'static [u8]> {
        match path {
            "assets/icons/select.svg" => Some(SELECT),
            "assets/icons/arrow.svg" => Some(ARROW),
            "assets/icons/rectangle.svg" => Some(RECTANGLE),
            "assets/icons/ellipse.svg" => Some(ELLIPSE),
            "assets/icons/text.svg" => Some(TEXT),
            "assets/icons/number.svg" => Some(NUMBER),
            "assets/icons/blur.svg" => Some(BLUR),
            "assets/icons/highlight.svg" => Some(HIGHLIGHT),
            "assets/icons/line.svg" => Some(LINE),
            "assets/icons/crop.svg" => Some(CROP),
            "assets/icons/pencil.svg" => Some(PENCIL),
            "assets/icons/eraser.svg" => Some(ERASER),
            "assets/icons/sticky.svg" => Some(STICKY),
            _ => None,
        }
    }
}

/// Asset source for loading SVG icons and other assets
struct Assets {
    base: PathBuf,
}

impl AssetSource for Assets {
    fn load(&self, path: &str) -> GpuiResult<Option<Cow<'static, [u8]>>> {
        // First check embedded assets (for portable binary)
        if let Some(data) = embedded_icons::get(path) {
            return Ok(Some(Cow::Borrowed(data)));
        }
        // Fall back to filesystem
        fs::read(self.base.join(path))
            .map(|data| Some(Cow::Owned(data)))
            .map_err(|err| err.into())
    }

    fn list(&self, path: &str) -> GpuiResult<Vec<SharedString>> {
        let full_path = self.base.join(path);
        if full_path.is_dir() {
            Ok(fs::read_dir(full_path)?
                .filter_map(|entry| entry.ok())
                .map(|entry| SharedString::from(entry.path().to_string_lossy().to_string()))
                .collect())
        } else {
            Ok(vec![])
        }
    }
}

use nib_collab::session::Session;
use nib_collab::types::ClientType;
use nib_core::blur::apply_blur_region;
use nib_core::{
    dash_segments, Annotation, AnnotationId, AnnotationType, ArrowHead, AssetData, Color, Region,
    StrokeStyle,
};
use nib_core::Point as NibPoint;
use crate::canvas::{Canvas, ZOOM_FACTOR};
use crate::toolbar::Tool;
use crate::tools::{
    Modifiers, MouseButton as ToolMouseButton, StyleState, TextTool, ToolContext, ToolEvent,
    ToolId, ToolManager, ToolMode, ToolPreview, ToolResult,
};
use nib_storage::nib_file::NibFile;
use crate::history::{Edit, History};
use crate::tool_flyout;
use crate::zorder;

// Re-export serialization types from nib-serde
pub use nib_serde::{
    AnnotationGeometry, AnnotationsFile, SerializedAnnotation,
    annotations_file_path, deserialize_annotation, serialize_annotation,
    color_to_hex, hex_to_color, ANNOTATIONS_FILE_VERSION,
};

/// Height of the toolbar in pixels (used for coordinate offset)
/// Mouse events are window-relative, so we subtract this to get canvas-relative coords
const TOOLBAR_HEIGHT: f32 = 0.0; // Toolbar floats inside canvas, doesn't offset coordinates

/// Cap on remembered undo entries (oldest dropped once exceeded)
const HISTORY_CAP: usize = 100;

/// Keyboard shortcut for toggling the style-picker popup. Not owned by any `Tool`, so it's
/// defined here as the single source both `handle_key_down` and the toolbar badge read from.
const STYLE_PICKER_SHORTCUT: char = 's';

/// Display labels for the modifier-combo shortcuts, shared between the toolbar button badges
/// and the `command_shortcuts` list used by `toolbar_shortcut_tests` below.
const SEND_SHORTCUT_LABEL: &str = "⌘↵";
const APPROVE_SHORTCUT_LABEL: &str = "⇧⌘A";
const REJECT_SHORTCUT_LABEL: &str = "⇧⌘R";

/// Labels for the keyboard-only commands added in Phase 2 (no toolbar badge --
/// undo/redo/duplicate/z-order don't have toolbar buttons), used only by
/// `command_shortcuts` below so `toolbar_shortcut_tests` covers them too.
#[cfg(test)]
const UNDO_SHORTCUT_LABEL: &str = "⌘Z";
#[cfg(test)]
const REDO_SHORTCUT_LABEL: &str = "⇧⌘Z";
#[cfg(test)]
const DUPLICATE_SHORTCUT_LABEL: &str = "⌘D";
#[cfg(test)]
const FORWARD_SHORTCUT_LABEL: &str = "⌘]";
#[cfg(test)]
const BACKWARD_SHORTCUT_LABEL: &str = "⌘[";
#[cfg(test)]
const GROUP_SHORTCUT_LABEL: &str = "⌘G";
#[cfg(test)]
const UNGROUP_SHORTCUT_LABEL: &str = "⇧⌘G";

/// (label, keystroke) pairs for every toolbar command's shortcut. Tool entries read from
/// `ToolId::shortcut()` — the same source `handle_key_down` dispatches on and the toolbar
/// badges render from — and the modifier-combo entries read from the same label constants
/// the Send/Approve/Reject badges render from. So this list can't silently drift from the
/// actual key bindings; `toolbar_shortcut_tests` uses it to assert no keystroke collides.
#[cfg(test)]
fn command_shortcuts() -> Vec<(&'static str, String)> {
    let mut shortcuts: Vec<(&'static str, String)> = Tool::all()
        .iter()
        .map(|tool| (tool.name(), tool.shortcut().to_ascii_uppercase().to_string()))
        .collect();
    shortcuts.push(("Style", STYLE_PICKER_SHORTCUT.to_ascii_uppercase().to_string()));
    shortcuts.push(("Send", SEND_SHORTCUT_LABEL.to_string()));
    shortcuts.push(("Approve", APPROVE_SHORTCUT_LABEL.to_string()));
    shortcuts.push(("Reject", REJECT_SHORTCUT_LABEL.to_string()));
    shortcuts.push(("Undo", UNDO_SHORTCUT_LABEL.to_string()));
    shortcuts.push(("Redo", REDO_SHORTCUT_LABEL.to_string()));
    shortcuts.push(("Duplicate", DUPLICATE_SHORTCUT_LABEL.to_string()));
    shortcuts.push(("Forward", FORWARD_SHORTCUT_LABEL.to_string()));
    shortcuts.push(("Backward", BACKWARD_SHORTCUT_LABEL.to_string()));
    shortcuts.push(("Group", GROUP_SHORTCUT_LABEL.to_string()));
    shortcuts.push(("Ungroup", UNGROUP_SHORTCUT_LABEL.to_string()));
    shortcuts
}

/// Renders the small keyboard-shortcut badge shown in a toolbar button's top-right corner.
/// Shared by tool buttons, the style-picker trigger, and Send/Approve/Reject so every
/// toolbar command displays its shortcut the same way.
pub(crate) fn render_shortcut_badge(label: impl Into<SharedString>, text_color: impl Into<gpui::Hsla>) -> impl IntoElement {
    div()
        .absolute()
        .top(px(2.))
        .right(px(2.))
        .min_w(px(16.))
        .h(px(16.))
        .px(px(3.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(3.))
        .bg(rgba(0x00000066))
        .border_1()
        .border_color(rgba(0xffffff33))
        .child(
            div()
                .text_color(text_color)
                .text_size(px(10.))
                .child(label.into())
        )
}

/// Map our stored asset format string (see `AssetData::format`) to GPUI's
/// `ImageFormat`, for constructing a renderable `gpui::Image`. Falls back to
/// Png (what the Image tool and export path always write) for anything
/// unrecognized rather than failing to render.
fn image_format_to_gpui(format: &str) -> gpui::ImageFormat {
    match format {
        "jpeg" | "jpg" => gpui::ImageFormat::Jpeg,
        "webp" => gpui::ImageFormat::Webp,
        "gif" => gpui::ImageFormat::Gif,
        "bmp" => gpui::ImageFormat::Bmp,
        "tiff" | "tif" => gpui::ImageFormat::Tiff,
        _ => gpui::ImageFormat::Png,
    }
}

/// Text input state for creating/editing text annotations
#[derive(Debug, Clone)]
pub struct TextInputState {
    /// Screen position where user clicked (for rendering during input)
    pub screen_x: f32,
    pub screen_y: f32,
    /// Current text content being typed
    pub content: String,
    /// If editing an existing annotation, its ID
    pub editing_annotation_id: Option<AnnotationId>,
}

/// Toast message for GUI display
#[derive(Clone)]
struct Toast {
    id: u64,
    message: String,
    created_at: Instant,
    duration: Duration,
}

impl Toast {
    fn new(message: String) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        Self {
            id: COUNTER.fetch_add(1, Ordering::Relaxed),
            message,
            created_at: Instant::now(),
            duration: Duration::from_secs(4),
        }
    }

    fn is_expired(&self) -> bool {
        self.created_at.elapsed() > self.duration
    }
}

/// Main application struct for GPUI
pub struct NibApp {
    file_path: Option<PathBuf>,
}

impl NibApp {
    /// Create a new NibApp instance without a file
    pub fn new() -> Self {
        Self { file_path: None }
    }

    /// Create a new NibApp instance with a file to display
    pub fn with_file(file_path: PathBuf) -> Self {
        Self {
            file_path: Some(file_path),
        }
    }

    /// Launch the GUI application
    pub fn run(self) -> anyhow::Result<()> {
        let file_path = self.file_path.clone();

        // Get the assets base path - try manifest dir first, then executable dir
        let assets_base = std::env::var("CARGO_MANIFEST_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(PathBuf::from))
                    .unwrap_or_else(|| PathBuf::from("."))
            });

        Application::new()
            .with_assets(Assets { base: assets_base })
            .run(move |cx: &mut App| {
                let window_size: Size<gpui::Pixels> = size(px(1200.), px(800.));

                let options = WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds {
                        origin: Point::default(),
                        size: window_size,
                    })),
                    kind: WindowKind::PopUp, // Float on top of all windows
                    ..Default::default()
                };

                cx.open_window(options, |_window, cx| {
                    cx.new(|cx| EditorView::new(file_path.clone(), cx))
                })
                .expect("Failed to open window");

                // Quit the app when the window is closed
                cx.on_window_closed(|_cx| {
                    std::process::exit(0);
                }).detach();
            });

        Ok(())
    }
}

impl Default for NibApp {
    fn default() -> Self {
        Self::new()
    }
}

/// Main editor view that displays the image and annotations
pub struct EditorView {
    /// Path to the image file being edited (for .nib files, this is the extracted temp image)
    file_path: Option<PathBuf>,
    /// List of completed annotations
    pub(crate) annotations: Vec<Annotation>,
    /// Currently selected tool
    pub(crate) active_tool: Tool,
    /// Style option defaults for newly-created annotations (stroke width, fill, stroke
    /// style, arrowhead, font size, blur intensity, opacity) plus the semantic style
    /// preset/custom color. Also fed into every `ToolContext` construction site.
    pub(crate) style_state: StyleState,
    /// GUI-side undo/redo command stack (see `history.rs`)
    pub(crate) history: History,
    /// Out-of-band asset bytes for Image annotations, keyed by content hash
    /// (see `AssetRef`). Populated on paste/load, read by rendering and export.
    pub(crate) asset_cache: std::collections::HashMap<String, AssetData>,
    /// Whether the collapsed style/color picker popup is open
    pub(crate) style_picker_open: bool,
    /// Whether the grouped shape-tools popup (Rectangle/Ellipse/Line/Pencil/
    /// Highlight) is open (see `tool_flyout.rs`)
    pub(crate) shape_flyout_open: bool,
    /// Last modification time of the sidecar annotations file (for file watching)
    last_sidecar_modified: Option<SystemTime>,
    /// Original image width in pixels
    image_width: u32,
    /// Original image height in pixels
    image_height: u32,
    /// Canvas display width (estimated)
    canvas_width: f32,
    /// Canvas display height (estimated)
    canvas_height: f32,
    /// Canvas state for zoom/pan (Figma-like mechanics)
    canvas: Canvas,
    /// Focus handle for keyboard input
    focus_handle: FocusHandle,
    /// Text input state for creating/editing text annotations
    /// NOTE: Content is synced from TextTool after key events. The TextTool is the source
    /// of truth for content; this is kept for screen-space rendering coordinates.
    /// Could be removed in a future refactor by computing screen coords during render.
    text_input_state: Option<TextInputState>,
    /// Tool manager for trait-based tool dispatch
    pub(crate) tool_manager: ToolManager,
    /// NibFile handle for .nib format (SQLite-based storage)
    nib_file: Option<NibFile>,
    /// Original .nib file path (file_path points to extracted temp image for rendering)
    /// Kept for future use (e.g., window title display)
    #[allow(dead_code)]
    nib_path: Option<PathBuf>,
    /// Last annotation modification timestamp in .nib file (for file watching)
    last_nib_modified: Option<i64>,
    /// Cached path to blur-processed image (temp file with blur regions applied)
    blur_preview_path: Option<PathBuf>,
    /// Hash of blur annotation state to detect when regeneration is needed
    blur_annotations_hash: u64,
    /// Pending debounced blur regeneration task (cancelled when replaced)
    blur_regen_task: Option<Task<()>>,
    /// Toast messages to display
    toasts: Vec<Toast>,
    /// Pending messages from .nib file to convert to toasts
    pending_messages: Vec<String>,
    /// Tokio runtime for collab session (kept alive for socket server)
    #[allow(dead_code)]
    collab_runtime: Option<tokio::runtime::Runtime>,
    /// Collab session for real-time sync with CLI
    collab_session: Option<Session>,
    /// IDs of annotations that have been sent to agent (for delta tracking)
    sent_annotation_ids: std::collections::HashSet<u64>,
    /// Question/message from Claude to display to user
    claude_question: Option<String>,
    /// Whether GUI should quit after sending response
    quit_requested: bool,
}

impl EditorView {
    /// Create a new editor view
    pub fn new(file_path: Option<PathBuf>, cx: &mut Context<Self>) -> Self {
        // Check if this is a .nib file
        let is_nib_file = file_path
            .as_ref()
            .map(|p| p.extension().map(|e| e == "nib").unwrap_or(false))
            .unwrap_or(false);

        // For .nib files, we need to extract the image and open the NibFile
        let (actual_file_path, nib_file, nib_path, image_width, image_height) = if is_nib_file {
            if let Some(ref path) = file_path {
                match NibFile::open(path) {
                    Ok(nib) => {
                        match nib.get_image() {
                            Ok((image_data, image_info)) => {
                                // Create a temp file for the extracted image
                                let temp_dir = std::env::temp_dir();
                                let temp_filename = format!(
                                    "nib_extracted_{}.{}",
                                    std::process::id(),
                                    image_info.format
                                );
                                let temp_path = temp_dir.join(temp_filename);

                                // Write image data to temp file
                                if let Err(e) = std::fs::write(&temp_path, &image_data) {
                                    tracing::error!("Failed to write extracted image to temp file: {}", e);
                                    (file_path.clone(), None, None, 1920, 1080)
                                } else {
                                    (
                                        Some(temp_path),
                                        Some(nib),
                                        file_path.clone(),
                                        image_info.width,
                                        image_info.height,
                                    )
                                }
                            }
                            Err(e) => {
                                tracing::error!("Failed to get image from .nib file: {}", e);
                                (file_path.clone(), None, None, 1920, 1080)
                            }
                        }
                    }
                    Err(e) => {
                        tracing::error!("Failed to open .nib file: {}", e);
                        (file_path.clone(), None, None, 1920, 1080)
                    }
                }
            } else {
                (None, None, None, 1920, 1080)
            }
        } else {
            // Standard image file - load dimensions directly
            let (width, height) = if let Some(ref path) = file_path {
                if let Ok((w, h)) = image::image_dimensions(path) {
                    (w, h)
                } else {
                    (1920, 1080) // default fallback
                }
            } else {
                (1920, 1080) // default for no image
            };
            (file_path.clone(), None, None, width, height)
        };

        // Estimate canvas size (window 1200x800 minus toolbar ~44px)
        let canvas_width = 1200.0_f32;
        let canvas_height = 756.0_f32; // 800 - 44

        // Create focus handle for keyboard input
        let focus_handle = cx.focus_handle();

        // Create canvas with image dimensions
        let mut canvas = Canvas::new(image_width, image_height);
        canvas.set_viewport(canvas_width as f64, canvas_height as f64);

        let mut view = Self {
            file_path: actual_file_path,
            annotations: Vec::new(),
            active_tool: Tool::Rectangle,
            style_state: StyleState::default(),
            history: History::new(HISTORY_CAP),
            asset_cache: std::collections::HashMap::new(),
            style_picker_open: false,
            shape_flyout_open: false,
            last_sidecar_modified: None,
            image_width,
            image_height,
            canvas_width,
            canvas_height,
            canvas,
            focus_handle,
            text_input_state: None,
            tool_manager: ToolManager::with_all_tools(),
            nib_file,
            nib_path: nib_path.clone(),
            last_nib_modified: None,
            blur_preview_path: None,
            blur_annotations_hash: 0,
            blur_regen_task: None,
            toasts: Vec::new(),
            pending_messages: Vec::new(),
            collab_runtime: None,
            collab_session: None,
            sent_annotation_ids: std::collections::HashSet::new(),
            claude_question: None,
            quit_requested: false,
        };

        view.load_annotations();
        view.sync_sent_annotations_baseline();
        view.regenerate_blur_preview_sync();
        view.update_sidecar_modified_time();
        if view.nib_file.is_some() {
            view.update_nib_modified_time();
        }

        // Start collab session for .nib files
        if let Some(ref path) = nib_path {
            view.start_collab_session(path.clone());
        }

        view
    }

    /// Start a collab session for the given .nib file path
    ///
    /// Spawns a dedicated background thread for the tokio runtime to avoid
    /// conflicts with GPUI's event loop. The Session is moved back to the
    /// GUI thread via a channel (its internal channels are thread-safe).
    fn start_collab_session(&mut self, nib_path: PathBuf) {
        use std::sync::mpsc;
        use std::time::Duration;

        // Channel to receive the session from the background thread
        let (tx, rx) = mpsc::channel::<Option<Session>>();

        // Spawn a dedicated thread for the tokio runtime
        // This thread stays alive to keep the socket server running
        std::thread::spawn(move || {
            match tokio::runtime::Runtime::new() {
                Ok(rt) => {
                    // Create session using block_on (this also starts socket server)
                    match rt.block_on(Session::open(&nib_path, ClientType::Gui)) {
                        Ok(session) => {
                            tracing::info!(
                                "Started collab session for {} (session_id: {})",
                                nib_path.display(),
                                session.session_id()
                            );
                            // Send session to GUI thread
                            let _ = tx.send(Some(session));
                            // Keep runtime alive by blocking this thread
                            // The socket server runs in a spawned tokio task
                            rt.block_on(async {
                                // Park until the process exits
                                loop {
                                    tokio::time::sleep(Duration::from_secs(3600)).await;
                                }
                            });
                        }
                        Err(e) => {
                            tracing::warn!("Failed to start collab session: {}", e);
                            let _ = tx.send(None);
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("Failed to create tokio runtime for collab: {}", e);
                    let _ = tx.send(None);
                }
            }
        });

        // Wait briefly for the session to be created
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Some(session)) => {
                self.collab_session = Some(session);
                // Note: we don't store collab_runtime anymore since it lives in the background thread
            }
            Ok(None) => {
                tracing::warn!("Collab session creation failed");
            }
            Err(_) => {
                tracing::warn!("Timeout waiting for collab session");
            }
        }
    }


    /// Update the stored modification time of the sidecar file
    fn update_sidecar_modified_time(&mut self) {
        if let Some(ref path) = self.file_path {
            let sidecar_path = annotations_file_path(path);
            if let Ok(metadata) = std::fs::metadata(&sidecar_path) {
                self.last_sidecar_modified = metadata.modified().ok();
            }
        }
    }

    /// Update the stored modification time for .nib file annotations
    fn update_nib_modified_time(&mut self) {
        if let Some(ref nib) = self.nib_file {
            if let Ok(Some(modified_at)) = nib.latest_annotation_modified_at() {
                self.last_nib_modified = Some(modified_at);
            }
        }
    }

    /// Add a toast message to display
    fn add_toast(&mut self, message: String, cx: &mut Context<Self>) {
        self.toasts.push(Toast::new(message));
        cx.notify();
        // Toast cleanup happens in render loop via cleanup_expired_toasts()
    }

    /// Clean up expired toasts (called from render loop)
    fn cleanup_expired_toasts(&mut self) {
        let original_len = self.toasts.len();
        self.toasts.retain(|t| !t.is_expired());
        if self.toasts.len() != original_len {
            // Toasts were removed, notify will happen naturally in render
        }
    }

    /// Render toast messages in top-right corner
    fn render_toasts(&self) -> impl IntoElement {
        div()
            .absolute()
            .top_4()
            .right_4()
            .flex()
            .flex_col()
            .gap_2()
            .children(self.toasts.iter().map(|toast| {
                div()
                    .px_4()
                    .py_2()
                    .bg(rgba(0x000000dd))
                    .rounded_lg()
                    .border_1()
                    .border_color(rgba(0xffffff33))
                    .child(
                        div()
                            .text_color(rgb(0xffffff))
                            .text_size(px(14.))
                            .child(toast.message.clone()),
                    )
            }))
    }

    /// Send annotations to Claude with an explicit decision (writes signal file).
    /// "approve"/"reject" are terminal — a decision always sends (even with an empty
    /// delta) and the process exits once the send succeeds. "comment" preserves the
    /// original Send behavior: skip sending (and only exit) if there's nothing new.
    fn send_decision(&mut self, decision: &str, cx: &mut Context<Self>) {
        let is_terminal_decision = decision != "comment";

        // Compute delta: only human annotations not yet sent
        // Filter out Claude's own annotations (owner == "claude")
        let delta_annotations: Vec<_> = self
            .annotations
            .iter()
            .filter(|a| !self.sent_annotation_ids.contains(&a.id.0) && a.owner != "claude")
            .collect();

        if delta_annotations.is_empty() && !is_terminal_decision {
            self.add_toast("No new annotations to send".to_string(), cx);
            // Still clear question and check quit even if no new annotations
            self.claude_question = None;
            if self.quit_requested {
                std::process::exit(0);
            }
            return;
        }

        // Build JSON payload for delta annotations
        let items = Self::annotation_items_to_json(&delta_annotations);
        let payload = Self::build_send_payload(decision, items);

        // Send via collab session (required)
        match &self.collab_session {
            Some(session) => {
                match session.send_to_agent(payload) {
                    Ok(_) => {
                        for a in &delta_annotations {
                            self.sent_annotation_ids.insert(a.id.0);
                        }
                        self.add_toast(format!("Sent {} annotation(s)", delta_annotations.len()), cx);

                        // Clear question after sending
                        self.claude_question = None;

                        // A decision is terminal: exit once sent, regardless of quit_requested.
                        if is_terminal_decision || self.quit_requested {
                            std::process::exit(0);
                        }
                    }
                    Err(e) => {
                        tracing::error!("Collab send failed: {}", e);
                        self.add_toast(format!("Send failed: {}", e), cx);
                    }
                }
            }
            None => {
                tracing::error!("No collab session - cannot send");
                self.add_toast("Error: No collab session".to_string(), cx);
            }
        }
    }

    /// Send annotations to Claude as a comment (writes signal file)
    fn send_to_claude(&mut self, cx: &mut Context<Self>) {
        self.send_decision("comment", cx);
    }

    /// Send to Claude and request GUI exit
    fn send_to_claude_and_quit(&mut self, cx: &mut Context<Self>) {
        self.quit_requested = true;
        self.send_to_claude(cx);
    }

    /// Approve: send the annotation delta (even if empty) with an "approve" decision and exit.
    fn approve_to_claude(&mut self, cx: &mut Context<Self>) {
        self.send_decision("approve", cx);
    }

    /// Reject: send the annotation delta (even if empty) with a "reject" decision and exit.
    fn reject_to_claude(&mut self, cx: &mut Context<Self>) {
        self.send_decision("reject", cx);
    }

    /// Process incoming collab messages (non-blocking)
    fn process_collab_messages(&mut self, cx: &mut Context<Self>) {
        use nib_collab::types::CollabMessage;
        use nib_collab::operation::data_to_annotation;

        // Collect messages first to avoid borrow conflict
        let messages: Vec<CollabMessage> = {
            let Some(session) = &self.collab_session else {
                return;
            };

            let Some(handle) = session.handle() else {
                return;
            };

            // Collect all pending messages
            let mut msgs = Vec::new();
            while let Ok(msg) = handle.receiver.try_recv() {
                msgs.push(msg);
            }
            msgs
        };

        // Now process messages with full mutable access to self
        let mut needs_blur_regen = false;
        for msg in messages {
            match msg {
                CollabMessage::ShowMessage { message, source } => {
                    tracing::info!("Received message from {}: {}", source, message);
                    self.claude_question = Some(message);
                    cx.notify();
                }
                CollabMessage::Operation(op) => {
                    // Handle AddAnnotations that were converted to Operations
                    use nib_collab::types::AnnotationOp;
                    if let AnnotationOp::Add { id, data } = &op.operation {
                        let annotation = data_to_annotation(*id, data);
                        self.annotations.push(annotation);
                        self.sent_annotation_ids.insert(*id);
                        AnnotationId::bump_to_at_least(id.saturating_add(1));
                        needs_blur_regen = true;
                        cx.notify();
                    }
                }
                CollabMessage::RequestQuit { client_id: _ } => {
                    tracing::info!("Received quit request");
                    self.quit_requested = true;
                    cx.notify();
                }
                _ => {
                    // Other messages handled elsewhere or ignored
                }
            }
        }

        // Regenerate blur preview if any annotations were added
        if needs_blur_regen {
            self.regenerate_blur_preview_sync();
        }
    }

    /// Render Claude question/message banner at top center
    fn render_claude_question(&self) -> impl IntoElement {
        if let Some(ref question) = self.claude_question {
            div()
                .absolute()
                .top_4()
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .child(
                    div()
                        .max_w(px(600.))
                        .px_6()
                        .py_4()
                        .bg(rgba(0x1a365dff)) // Dark blue background
                        .rounded_lg()
                        .border_2()
                        .border_color(rgba(0x3182ceff)) // Blue border
                        .shadow_lg()
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap_2()
                                .child(
                                    div()
                                        .text_color(rgba(0x90cdf4ff)) // Light blue header
                                        .text_size(px(12.))
                                        .font_weight(gpui::FontWeight::BOLD)
                                        .child("Claude asks:"),
                                )
                                .child(
                                    div()
                                        .text_color(rgb(0xffffff))
                                        .text_size(px(16.))
                                        .child(question.clone()),
                                )
                                .child(
                                    div()
                                        .text_color(rgba(0x90cdf4aa)) // Muted hint
                                        .text_size(px(11.))
                                        .child("Press Cmd+Enter to send response"),
                                ),
                        ),
                )
        } else {
            div()
        }
    }

    /// Convert annotations to minimal JSON items for agent consumption
    fn annotation_items_to_json(annotations: &[&Annotation]) -> Vec<serde_json::Value> {
        use serde_json::json;

        annotations
            .iter()
            .map(|a| {
                let (type_name, coords, content) = match &a.annotation_type {
                    AnnotationType::Arrow { start, end, .. } => {
                        ("arrow", json!([start.x, start.y, end.x, end.y]), None)
                    }
                    AnnotationType::Box { region, .. } => {
                        ("rectangle", json!([region.x, region.y, region.width, region.height]), None)
                    }
                    AnnotationType::Text { position, content, .. } => {
                        ("text", json!([position.x, position.y]), Some(content.clone()))
                    }
                    AnnotationType::Number { position, value, .. } => {
                        ("number", json!([position.x, position.y]), Some(value.to_string()))
                    }
                    AnnotationType::Highlight { region, .. } => {
                        ("highlight", json!([region.x, region.y, region.width, region.height]), None)
                    }
                    AnnotationType::Ellipse { center, radius_x, radius_y, .. } => {
                        ("ellipse", json!([center.x, center.y, *radius_x, *radius_y]), None)
                    }
                    AnnotationType::Line { start, end, .. } => {
                        ("line", json!([start.x, start.y, end.x, end.y]), None)
                    }
                    AnnotationType::Blur { region, .. } => {
                        ("blur", json!([region.x, region.y, region.width, region.height]), None)
                    }
                    AnnotationType::Crop { region } => {
                        ("crop", json!([region.x, region.y, region.width, region.height]), None)
                    }
                    AnnotationType::Path { points, .. } => {
                        let coords: Vec<_> = points.iter().map(|p| [p.x, p.y]).collect();
                        ("path", json!(coords), None)
                    }
                    AnnotationType::Image { region, .. } => {
                        ("image", json!([region.x, region.y, region.width, region.height]), None)
                    }
                };

                let mut obj = json!({
                    "id": format!("a{}", a.id.0),
                    "type": type_name,
                    "at": coords,
                });

                if let Some(c) = content {
                    obj["content"] = json!(c);
                }

                obj
            })
            .collect()
    }

    /// Build the one-shot feedback payload: an explicit human decision plus the annotation delta.
    fn build_send_payload(decision: &str, items: Vec<serde_json::Value>) -> String {
        serde_json::json!({ "decision": decision, "annotations": items }).to_string()
    }

    /// Calculate the scale factor and offset for rendering annotations
    /// Returns (scale, offset_x, offset_y) from the Canvas zoom/pan state
    fn calculate_scale_and_offset(&self) -> (f32, f32, f32) {
        let scale = self.canvas.scale();
        let (offset_x, offset_y) = self.canvas.offset_tuple();
        (scale, offset_x, offset_y)
    }

    /// Get the effective color based on current style
    /// Returns custom_color if style is Custom, otherwise the style's default color
    fn effective_color(&self) -> Color {
        self.style_state.effective_color()
    }

    /// Scale image coordinates to canvas coordinates for rendering
    /// Takes (x, y, w, h) in image pixels and returns (sx, sy, sw, sh) in canvas pixels
    /// Coordinates are canvas-relative (canvas div is already below toolbar)
    fn scale_coords(&self, x: f64, y: f64, w: f64, h: f64) -> (f32, f32, f32, f32) {
        let (scale, offset_x, offset_y) = self.calculate_scale_and_offset();

        (
            (x as f32 * scale) + offset_x,
            (y as f32 * scale) + offset_y,
            w as f32 * scale,
            h as f32 * scale,
        )
    }

    /// Scale a single point from image coordinates to canvas coordinates
    fn scale_point(&self, x: f64, y: f64) -> (f32, f32) {
        let (scale, offset_x, offset_y) = self.calculate_scale_and_offset();
        (
            (x as f32 * scale) + offset_x,
            (y as f32 * scale) + offset_y,
        )
    }

    /// Render text with an all-around outline for better readability
    /// Creates shadow text at 8 positions around the main text
    fn render_text_with_outline(
        content: String,
        x: f32,
        y: f32,
        font_size: f32,
        text_color: gpui::Hsla,
    ) -> impl IntoElement {
        // Outline offset scales with font size for consistent appearance
        let outline_offset = (font_size * 0.08).max(1.5);
        let outline_color = rgba(0x000000cc); // Black with high opacity

        // 8 positions around the text for full outline coverage
        let offsets: [(f32, f32); 8] = [
            (-outline_offset, -outline_offset), // NW
            (0.0, -outline_offset),             // N
            (outline_offset, -outline_offset),  // NE
            (-outline_offset, 0.0),             // W
            (outline_offset, 0.0),              // E
            (-outline_offset, outline_offset),  // SW
            (0.0, outline_offset),              // S
            (outline_offset, outline_offset),   // SE
        ];

        let content_clone = content.clone();

        div()
            .absolute()
            .left(px(x))
            .top(px(y))
            // Shadow layers (rendered first, behind main text)
            .children(offsets.iter().map(|(dx, dy)| {
                div()
                    .absolute()
                    .left(px(*dx))
                    .top(px(*dy))
                    .text_color(outline_color)
                    .text_size(px(font_size))
                    .child(content.clone())
            }))
            // Main text on top
            .child(
                div()
                    .text_color(text_color)
                    .text_size(px(font_size))
                    .child(content_clone)
            )
    }

    /// Render a sticky note: an opaque rounded background rect sized to the
    /// (wrapped) text, with plain text on top. Unlike `render_text_with_outline`,
    /// there's no shadow/outline -- the opaque background already guarantees
    /// legibility, and doubling up would look muddy.
    #[allow(clippy::too_many_arguments)] // screen-space draw params, splitting them adds no clarity
    fn render_sticky_note(
        content: String,
        x: f32,
        y: f32,
        font_size: f32,
        max_width: Option<f32>,
        text_color: gpui::Hsla,
        background: Color,
    ) -> impl IntoElement {
        let lines = crate::elements::text::wrap_text(&content, font_size as f64, max_width.map(|w| w as f64));
        let padding = (font_size * 0.25).max(4.0);
        let line_height = font_size * 1.2;

        let longest_line_chars = lines.iter().map(|l| l.chars().count()).max().unwrap_or(0);
        let natural_width = longest_line_chars as f32 * font_size * 0.6;
        let box_width = max_width.unwrap_or(natural_width);
        let box_height = (lines.len().max(1)) as f32 * line_height;

        let gpui_background = rgb(
            background.r as u32 * 0x10000 + background.g as u32 * 0x100 + background.b as u32,
        );

        div()
            .absolute()
            .left(px(x))
            .top(px(y))
            .w(px(box_width + padding * 2.0))
            .h(px(box_height + padding * 2.0))
            .bg(gpui_background)
            .rounded_md()
            .p(px(padding))
            .flex()
            .flex_col()
            .children(lines.into_iter().map(move |line| {
                div()
                    .text_color(text_color)
                    .text_size(px(font_size))
                    .child(line)
            }))
    }

    /// Create a line element using paint_path with proper bounds adjustment
    /// paint_path uses window coordinates, so we adjust by bounds origin
    #[allow(clippy::too_many_arguments)] // screen-space draw params, splitting them adds no clarity
    fn render_line_element(
        start_sx: f32,
        start_sy: f32,
        end_sx: f32,
        end_sy: f32,
        stroke_width: f32,
        stroke_style: StrokeStyle,
        color: gpui::Hsla,
    ) -> impl IntoElement {
        canvas(
            move |bounds, _window, _cx| {
                let origin_x: f32 = bounds.origin.x.into();
                let origin_y: f32 = bounds.origin.y.into();
                let start = NibPoint::new((start_sx + origin_x) as f64, (start_sy + origin_y) as f64);
                let end = NibPoint::new((end_sx + origin_x) as f64, (end_sy + origin_y) as f64);
                dash_segments(start, end, stroke_style, stroke_width as f64)
                    .into_iter()
                    .map(|(s, e)| (point(px(s.x as f32), px(s.y as f32)), point(px(e.x as f32), px(e.y as f32))))
                    .collect::<Vec<_>>()
            },
            move |_bounds, segments, window, _cx| {
                for (p_start, p_end) in segments {
                    let mut builder = PathBuilder::stroke(px(stroke_width));
                    builder.move_to(p_start);
                    builder.line_to(p_end);
                    if let Ok(path) = builder.build() {
                        window.paint_path(path, color);
                    }
                }
            },
        )
        .absolute()
        .size_full()
    }

    /// Create a freeform path element using paint_path
    fn render_path_element(
        points: Vec<(f32, f32)>,
        stroke_width: f32,
        stroke_style: StrokeStyle,
        color: gpui::Hsla,
    ) -> impl IntoElement {
        canvas(
            move |bounds, _window, _cx| {
                let origin_x: f32 = bounds.origin.x.into();
                let origin_y: f32 = bounds.origin.y.into();
                let adjusted: Vec<(f32, f32)> = points
                    .iter()
                    .map(|(x, y)| (*x + origin_x, *y + origin_y))
                    .collect();

                let mut segments = Vec::new();
                for pair in adjusted.windows(2) {
                    let start = NibPoint::new(pair[0].0 as f64, pair[0].1 as f64);
                    let end = NibPoint::new(pair[1].0 as f64, pair[1].1 as f64);
                    for (s, e) in dash_segments(start, end, stroke_style, stroke_width as f64) {
                        segments.push((
                            point(px(s.x as f32), px(s.y as f32)),
                            point(px(e.x as f32), px(e.y as f32)),
                        ));
                    }
                }
                segments
            },
            move |_bounds, segments, window, _cx| {
                for (p_start, p_end) in segments {
                    let mut builder = PathBuilder::stroke(px(stroke_width));
                    builder.move_to(p_start);
                    builder.line_to(p_end);
                    if let Ok(path) = builder.build() {
                        window.paint_path(path, color);
                    }
                }
            },
        )
        .absolute()
        .size_full()
    }

    /// Create an arrow element using paint_path with proper bounds adjustment
    #[allow(clippy::too_many_arguments)] // screen-space draw params, splitting them adds no clarity
    fn render_arrow_element(
        start_sx: f32,
        start_sy: f32,
        end_sx: f32,
        end_sy: f32,
        stroke_width: f32,
        head: ArrowHead,
        color: gpui::Hsla,
    ) -> impl IntoElement {
        // Calculate arrowhead geometry
        let dx = end_sx - start_sx;
        let dy = end_sy - start_sy;
        let angle = dy.atan2(dx);
        let arrow_size: f32 = 12.0;
        let arrow_angle: f32 = 0.5; // ~28 degrees

        // Wings for a head drawn at the `end` point, pointing back along `angle`
        let ax1_offset = -arrow_size * (angle + arrow_angle).cos();
        let ay1_offset = -arrow_size * (angle + arrow_angle).sin();
        let ax2_offset = -arrow_size * (angle - arrow_angle).cos();
        let ay2_offset = -arrow_size * (angle - arrow_angle).sin();

        // Wings for a head drawn at the `start` point, pointing back the other way
        let start_angle = angle + std::f32::consts::PI;
        let bx1_offset = -arrow_size * (start_angle + arrow_angle).cos();
        let by1_offset = -arrow_size * (start_angle + arrow_angle).sin();
        let bx2_offset = -arrow_size * (start_angle - arrow_angle).cos();
        let by2_offset = -arrow_size * (start_angle - arrow_angle).sin();

        let draw_end = matches!(head, ArrowHead::End | ArrowHead::Both);
        let draw_start = matches!(head, ArrowHead::Start | ArrowHead::Both);

        canvas(
            move |bounds, _window, _cx| {
                let origin_x: f32 = bounds.origin.x.into();
                let origin_y: f32 = bounds.origin.y.into();
                let start_wx = start_sx + origin_x;
                let start_wy = start_sy + origin_y;
                let end_wx = end_sx + origin_x;
                let end_wy = end_sy + origin_y;
                (
                    point(px(start_wx), px(start_wy)),
                    point(px(end_wx), px(end_wy)),
                    point(px(end_wx + ax1_offset), px(end_wy + ay1_offset)),
                    point(px(end_wx + ax2_offset), px(end_wy + ay2_offset)),
                    point(px(start_wx + bx1_offset), px(start_wy + by1_offset)),
                    point(px(start_wx + bx2_offset), px(start_wy + by2_offset)),
                )
            },
            move |_bounds, (p_start, p_end, p_arrow1, p_arrow2, p_arrow3, p_arrow4), window, _cx| {
                // Draw main line (Arrow has no stroke_style field, so this stays solid)
                let mut builder = PathBuilder::stroke(px(stroke_width));
                builder.move_to(p_start);
                builder.line_to(p_end);
                if let Ok(path) = builder.build() {
                    window.paint_path(path, color);
                }

                if draw_end {
                    for wing in [p_arrow1, p_arrow2] {
                        let mut b = PathBuilder::stroke(px(stroke_width));
                        b.move_to(p_end);
                        b.line_to(wing);
                        if let Ok(path) = b.build() {
                            window.paint_path(path, color);
                        }
                    }
                }

                if draw_start {
                    for wing in [p_arrow3, p_arrow4] {
                        let mut b = PathBuilder::stroke(px(stroke_width));
                        b.move_to(p_start);
                        b.line_to(wing);
                        if let Ok(path) = b.build() {
                            window.paint_path(path, color);
                        }
                    }
                }
            },
        )
        .absolute()
        .size_full()
    }

    /// Convert window coordinates to image coordinates for annotation creation
    /// Mouse events are window-relative, so we subtract toolbar height first
    fn screen_to_image_coords(&self, window_x: f32, window_y: f32) -> (f64, f64) {
        // Window coords -> canvas coords (subtract toolbar)
        let canvas_y = window_y - TOOLBAR_HEIGHT;
        self.canvas.screen_to_image(window_x, canvas_y)
    }

    /// Build a ToolContext for tool event handling
    fn build_tool_context(&self) -> ToolContext<'_> {
        let (scale, offset_x, offset_y) = self.calculate_scale_and_offset();
        self.style_state.tool_context(
            (self.image_width, self.image_height),
            scale,
            (offset_x, offset_y),
            &self.annotations,
            5.0,
        )
    }

    /// Process a ToolResult and update EditorView state accordingly
    fn process_tool_result(&mut self, result: ToolResult, cx: &mut Context<Self>) {
        match result {
            ToolResult::Created(annotation) => {
                // Log with full content for text annotations
                let details = match &annotation.annotation_type {
                    AnnotationType::Text { content, position, .. } => {
                        format!("text \"{}\" at ({}, {})", content, position.x as i32, position.y as i32)
                    }
                    AnnotationType::Number { value, position, .. } => {
                        format!("number {} at ({}, {})", value, position.x as i32, position.y as i32)
                    }
                    AnnotationType::Arrow { start, end, .. } => {
                        format!("arrow ({}, {}) -> ({}, {})",
                            start.x as i32, start.y as i32, end.x as i32, end.y as i32)
                    }
                    AnnotationType::Box { region, .. } => {
                        format!("box at ({}, {}) {}x{}",
                            region.x as i32, region.y as i32, region.width as i32, region.height as i32)
                    }
                    other => other.type_name().to_string(),
                };
                tracing::info!("human created a{} {}", annotation.id.0, details);
                self.record_edit(Edit::Added(annotation.clone()));
                self.annotations.push(annotation);
                self.save_annotations(cx);
                cx.notify();
            }
            ToolResult::CreatedWithAsset { annotation, asset_hash, asset } => {
                tracing::info!("human created a{} image ({}x{})", annotation.id.0, asset.width, asset.height);
                self.asset_cache.insert(asset_hash, asset);
                self.record_edit(Edit::Added(annotation.clone()));
                self.annotations.push(annotation);
                self.save_annotations(cx);
                cx.notify();
            }
            ToolResult::Updated(id) => {
                // Simple update without content - tool should handle internally
                tracing::debug!("Annotation {:?} updated", id);
                cx.notify();
            }
            ToolResult::UpdatedText(id, new_content) => {
                // Update text annotation content
                let edit = if let Some(ann) = self.annotations.iter_mut().find(|a| a.id == id) {
                    let before = ann.clone();
                    if let AnnotationType::Text { ref mut content, .. } = ann.annotation_type {
                        *content = new_content;
                    }
                    ann.touch();
                    Some(Edit::Replaced { before, after: ann.clone() })
                } else {
                    None
                };
                if let Some(edit) = edit {
                    self.record_edit(edit);
                }
                self.save_annotations(cx);
                cx.notify();
            }
            ToolResult::Deleted(id) => {
                if let Some(pos) = self.annotations.iter().position(|a| a.id == id) {
                    let removed = self.annotations.remove(pos);
                    tracing::info!("human deleted a{} {}", id.0, removed.annotation_type.type_name());
                    self.record_edit(Edit::Removed(removed));
                }
                self.save_annotations(cx);
                cx.notify();
            }
            ToolResult::EnterMode(mode) => {
                match mode {
                    ToolMode::TextInput { position, initial_content, editing_annotation_id, sticky_style } => {
                        // Sticky tool hands off to the Text tool's existing typing/confirm
                        // flow: switch the active tool so KeyDown routes to TextTool, then
                        // seed it with the sticky background/text color/max_width.
                        if let Some(style) = sticky_style {
                            self.select_tool(ToolId::Text, cx);
                            if let Some(text_tool) = self.tool_manager.get_tool_as_mut::<TextTool>(ToolId::Text) {
                                text_tool.begin_sticky(position, style);
                            }
                        }
                        // Convert image position to screen position
                        let (screen_x, screen_y) = self.scale_point(position.x, position.y);
                        // Adjust for font height (text is drawn with baseline at position)
                        let (scale, _, _) = self.calculate_scale_and_offset();
                        let adjusted_screen_y = screen_y + (self.style_state.font_size as f32 * scale);
                        self.text_input_state = Some(TextInputState {
                            screen_x,
                            screen_y: adjusted_screen_y,
                            content: initial_content,
                            editing_annotation_id,
                        });
                    }
                }
                cx.notify();
            }
            ToolResult::ExitMode => {
                self.text_input_state = None;
                cx.notify();
            }
            ToolResult::Batch(results) => {
                for r in results {
                    self.process_tool_result(r, cx);
                }
            }
            ToolResult::Moved {
                ids,
                delta_x,
                delta_y,
            } => {
                // Move all specified annotations by the delta
                let mut edits = Vec::new();
                for id in &ids {
                    if let Some(ann) = self.annotations.iter_mut().find(|a| a.id == *id) {
                        let before = ann.clone();
                        Self::move_annotation_type(&mut ann.annotation_type, delta_x, delta_y);
                        ann.touch();
                        edits.push(Edit::Replaced { before, after: ann.clone() });
                    }
                }
                self.record_edit(Edit::Batch(edits));
                tracing::info!("human moved {}", ids.iter()
                    .filter_map(|id| self.annotations.iter().find(|a| a.id == *id))
                    .map(|a| format!("a{} {}", a.id.0, a.annotation_type.type_name()))
                    .collect::<Vec<_>>().join(", "));
                self.save_annotations(cx);
                cx.notify();
            }
            ToolResult::Resized { id, new_bounds } => {
                // Resize the specified annotation to new bounds
                let outcome = if let Some(ann) = self.annotations.iter_mut().find(|a| a.id == id) {
                    let before = ann.clone();
                    Self::resize_annotation_type(&mut ann.annotation_type, new_bounds);
                    ann.touch();
                    Some((Edit::Replaced { before, after: ann.clone() }, ann.annotation_type.type_name()))
                } else {
                    None
                };
                let type_name = match outcome {
                    Some((edit, type_name)) => {
                        self.record_edit(edit);
                        type_name
                    }
                    None => "unknown",
                };
                tracing::info!("human resized a{} {}", id.0, type_name);
                self.save_annotations(cx);
                cx.notify();
            }
            ToolResult::Handled => {
                cx.notify();
            }
            ToolResult::Ignored => {
                // Nothing to do
            }
        }
    }

    /// Resize an annotation type to new bounds
    fn resize_annotation_type(annotation_type: &mut AnnotationType, new_bounds: Region) {
        match annotation_type {
            AnnotationType::Box { region, .. }
            | AnnotationType::Blur { region, .. }
            | AnnotationType::Highlight { region, .. }
            | AnnotationType::Image { region, .. }
            | AnnotationType::Crop { region } => {
                *region = new_bounds;
            }
            AnnotationType::Ellipse {
                center,
                radius_x,
                radius_y,
                ..
            } => {
                *center = new_bounds.center();
                *radius_x = new_bounds.width / 2.0;
                *radius_y = new_bounds.height / 2.0;
            }
            // For line-based types, map bounds corners to start/end
            AnnotationType::Arrow { start, end, .. }
            | AnnotationType::Line { start, end, .. } => {
                *start = NibPoint::new(new_bounds.x, new_bounds.y);
                *end = NibPoint::new(
                    new_bounds.x + new_bounds.width,
                    new_bounds.y + new_bounds.height,
                );
            }
            // Text/Number: just update position (cannot resize content)
            AnnotationType::Text { position, .. } | AnnotationType::Number { position, .. } => {
                *position = NibPoint::new(new_bounds.x, new_bounds.y);
            }
            // Path: scale all points to fit new bounds
            AnnotationType::Path { points, .. } => {
                if let (Some(min_x), Some(max_x), Some(min_y), Some(max_y)) = (
                    points.iter().map(|p| p.x).fold(None, |m, x| Some(m.map_or(x, |v: f64| v.min(x)))),
                    points.iter().map(|p| p.x).fold(None, |m, x| Some(m.map_or(x, |v: f64| v.max(x)))),
                    points.iter().map(|p| p.y).fold(None, |m, y| Some(m.map_or(y, |v: f64| v.min(y)))),
                    points.iter().map(|p| p.y).fold(None, |m, y| Some(m.map_or(y, |v: f64| v.max(y)))),
                ) {
                    let old_width = (max_x - min_x).max(1.0);
                    let old_height = (max_y - min_y).max(1.0);
                    for point in points.iter_mut() {
                        point.x = new_bounds.x + (point.x - min_x) / old_width * new_bounds.width;
                        point.y = new_bounds.y + (point.y - min_y) / old_height * new_bounds.height;
                    }
                }
            }
        }
    }

    /// Move an annotation type by the given delta
    pub(crate) fn move_annotation_type(annotation_type: &mut AnnotationType, delta_x: f64, delta_y: f64) {
        match annotation_type {
            AnnotationType::Arrow {
                ref mut start,
                ref mut end,
                ..
            } => {
                start.x += delta_x;
                start.y += delta_y;
                end.x += delta_x;
                end.y += delta_y;
            }
            AnnotationType::Box { ref mut region, .. } => {
                region.x += delta_x;
                region.y += delta_y;
            }
            AnnotationType::Text {
                ref mut position, ..
            } => {
                position.x += delta_x;
                position.y += delta_y;
            }
            AnnotationType::Number {
                ref mut position, ..
            } => {
                position.x += delta_x;
                position.y += delta_y;
            }
            AnnotationType::Blur { ref mut region, .. } => {
                region.x += delta_x;
                region.y += delta_y;
            }
            AnnotationType::Highlight { ref mut region, .. } => {
                region.x += delta_x;
                region.y += delta_y;
            }
            AnnotationType::Line {
                ref mut start,
                ref mut end,
                ..
            } => {
                start.x += delta_x;
                start.y += delta_y;
                end.x += delta_x;
                end.y += delta_y;
            }
            AnnotationType::Ellipse {
                ref mut center, ..
            } => {
                center.x += delta_x;
                center.y += delta_y;
            }
            AnnotationType::Crop { ref mut region } => {
                region.x += delta_x;
                region.y += delta_y;
            }
            AnnotationType::Path {
                ref mut points, ..
            } => {
                for point in points.iter_mut() {
                    point.x += delta_x;
                    point.y += delta_y;
                }
            }
            AnnotationType::Image { ref mut region, .. } => {
                region.x += delta_x;
                region.y += delta_y;
            }
        }
    }

    /// Check if the sidecar file or .nib file has been modified and reload annotations if needed
    ///
    /// NOTE: This is called on every render frame. For fast agent response, the GUI must be
    /// receiving user input (mouse movement, etc.) to trigger renders. When idle, external
    /// changes won't be detected until the next user interaction.
    fn check_and_reload_annotations(&mut self) {
        let t0 = std::time::Instant::now();

        // For .nib files, check the annotation modification timestamp and messages
        if let Some(ref nib) = self.nib_file {
            // Check for new messages from CLI
            if let Ok(messages) = nib.get_and_mark_messages_read() {
                for (_id, content, _source, _created) in messages {
                    self.pending_messages.push(content);
                }
            }

            match nib.latest_annotation_modified_at() {
                Ok(Some(current_modified)) => {
                    if self.last_nib_modified != Some(current_modified) {
                        let before_count = self.annotations.len();
                        self.load_annotations();
                        let after_count = self.annotations.len();
                        self.last_nib_modified = Some(current_modified);
                        tracing::info!("human detected external change ({} -> {} annotations)",
                            before_count, after_count);

                        // Show toast for new annotations added externally (by Claude)
                        if after_count > before_count {
                            let new_count = after_count - before_count;
                            self.pending_messages.push(format!("Claude added {} annotation{}",
                                new_count, if new_count > 1 { "s" } else { "" }));
                        }
                    }
                }
                Ok(None) => {
                    // No annotations yet, nothing to reload
                }
                Err(e) => {
                    tracing::warn!("Failed to check .nib modification time: {}", e);
                }
            }
            let elapsed = t0.elapsed();
            if elapsed.as_millis() > 5 {
                eprintln!("[PERF] check_and_reload_annotations (nib): {:?}", elapsed);
            }
            return;
        }

        // For regular image files, check sidecar modification time
        let Some(ref path) = self.file_path else {
            return;
        };

        let sidecar_path = annotations_file_path(path);

        // Check if file exists and get modification time
        let Ok(metadata) = std::fs::metadata(&sidecar_path) else {
            return;
        };

        let Ok(current_modified) = metadata.modified() else {
            return;
        };

        // Compare with stored modification time
        if self.last_sidecar_modified != Some(current_modified) {
            let before_count = self.annotations.len();
            self.load_annotations();
            self.last_sidecar_modified = Some(current_modified);
            tracing::info!("human detected external change ({} -> {} annotations)",
                before_count, self.annotations.len());
        }

        let elapsed = t0.elapsed();
        if elapsed.as_millis() > 5 {
            eprintln!("[PERF] check_and_reload_annotations (json): {:?}", elapsed);
        }
    }

    /// Save annotations to a sidecar JSON file or .nib file
    pub(crate) fn save_annotations(&mut self, cx: &mut Context<Self>) {
        let t0 = std::time::Instant::now();

        // For .nib files, save to NibFile
        if let Some(ref nib) = self.nib_file {
            // Strategy: delete all existing annotations, then add all current ones
            // This is simpler than tracking individual changes and ensures consistency

            // First, get existing annotation IDs and delete them
            match nib.list_annotations() {
                Ok(existing) => {
                    for ann in existing {
                        let id = format!("a{}", ann.id.0);
                        if let Err(e) = nib.delete_annotation(&id) {
                            tracing::warn!("Failed to delete annotation {}: {}", id, e);
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("Failed to list existing annotations: {}", e);
                }
            }

            // Now add all current annotations
            for annotation in &self.annotations {
                if let Err(e) = nib.add_annotation(annotation) {
                    tracing::warn!("Failed to add annotation: {}", e);
                }
            }

            // Flush changes to disk
            if let Err(e) = nib.save() {
                tracing::warn!("Failed to save .nib file: {}", e);
            } else {
                tracing::debug!("Saved {} annotations to .nib file", self.annotations.len());
                // Update modification time to avoid reloading our own changes
                self.update_nib_modified_time();
            }
            return;
        }

        // For regular image files, save to sidecar JSON
        let Some(ref image_path) = self.file_path else {
            return;
        };

        let annotations_path = annotations_file_path(image_path);
        let serialized: Vec<SerializedAnnotation> = self.annotations
            .iter()
            .map(serialize_annotation)
            .collect();

        let file = AnnotationsFile::new(
            &image_path.to_string_lossy(),
            serialized,
        );

        match serde_json::to_string_pretty(&file) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&annotations_path, json) {
                    tracing::warn!("Failed to save annotations to {:?}: {}", annotations_path, e);
                } else {
                    tracing::debug!("Saved {} annotations to {:?}", self.annotations.len(), annotations_path);
                    // Update modification time to avoid reloading our own changes
                    self.update_sidecar_modified_time();
                }
            }
            Err(e) => {
                tracing::warn!("Failed to serialize annotations: {}", e);
            }
        }

        // Schedule debounced blur preview regeneration if blur annotations changed
        self.schedule_blur_regeneration(cx);

        let elapsed = t0.elapsed();
        if elapsed.as_millis() > 10 {
            eprintln!("[PERF] save_annotations: {:?}", elapsed);
        }
    }

    /// Compute a hash of blur annotation state to detect changes
    fn compute_blur_hash(&self) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        for annotation in &self.annotations {
            if let AnnotationType::Blur { region, intensity } = &annotation.annotation_type {
                // Hash the blur region parameters
                region.x.to_bits().hash(&mut hasher);
                region.y.to_bits().hash(&mut hasher);
                region.width.to_bits().hash(&mut hasher);
                region.height.to_bits().hash(&mut hasher);
                intensity.radius().hash(&mut hasher);
            }
        }
        hasher.finish()
    }

    /// Schedule debounced blur preview regeneration (500ms delay)
    /// Cancels any pending regeneration task when called, implementing trailing-edge debounce
    fn schedule_blur_regeneration(&mut self, cx: &mut Context<Self>) {
        let new_hash = self.compute_blur_hash();

        // Check if blur annotations changed
        if new_hash == self.blur_annotations_hash {
            return;
        }

        // Update hash immediately to track the change
        self.blur_annotations_hash = new_hash;

        // Handle immediate clear case (no blur annotations) synchronously
        let has_blur = self.annotations.iter().any(|a| matches!(a.annotation_type, AnnotationType::Blur { .. }));
        if !has_blur {
            if let Some(ref path) = self.blur_preview_path {
                let _ = std::fs::remove_file(path);
            }
            self.blur_preview_path = None;
            self.blur_regen_task = None;
            return;
        }

        // Collect blur regions and image path for the async task
        let blur_regions: Vec<_> = self.annotations.iter()
            .filter_map(|a| {
                if let AnnotationType::Blur { region, intensity } = &a.annotation_type {
                    Some((*region, intensity.radius()))
                } else {
                    None
                }
            })
            .collect();

        let Some(image_path) = self.file_path.clone() else {
            return;
        };

        // Cancel any pending task by replacing it (old task is dropped and cancelled)
        // Get executor before async boundary
        let executor = cx.background_executor().clone();

        // Prepare the expected output path
        let temp_dir = std::env::temp_dir();
        let temp_filename = format!("nib_blur_preview_{}.png", std::process::id());
        let temp_path = temp_dir.join(&temp_filename);

        // Set the preview path immediately so renders can use it once ready
        self.blur_preview_path = Some(temp_path.clone());

        // Spawn debounced background task for blur processing
        // The Task handle allows cancellation when a new blur change occurs
        let executor_for_timer = executor.clone();
        let task = executor.spawn(async move {
            // Wait 500ms (debounce delay)
            executor_for_timer.timer(Duration::from_millis(500)).await;

            // Perform blur processing
            let img = match image::open(&image_path) {
                Ok(img) => img.to_rgba8(),
                Err(e) => {
                    tracing::warn!("Failed to load image for blur preview: {}", e);
                    return;
                }
            };

            let mut processed = img;
            for (region, radius) in &blur_regions {
                apply_blur_region(&mut processed, region, *radius);
            }

            match processed.save(&temp_path) {
                Ok(()) => {
                    tracing::debug!("Generated blur preview at {:?}", temp_path);
                }
                Err(e) => {
                    tracing::warn!("Failed to save blur preview: {}", e);
                }
            }
        });

        self.blur_regen_task = Some(task);
    }

    /// Regenerate blur preview synchronously (used at startup)
    fn regenerate_blur_preview_sync(&mut self) {
        let t0 = std::time::Instant::now();

        let new_hash = self.compute_blur_hash();

        if new_hash == self.blur_annotations_hash {
            return;
        }
        self.blur_annotations_hash = new_hash;

        let blur_regions: Vec<_> = self.annotations.iter()
            .filter_map(|a| {
                if let AnnotationType::Blur { region, intensity } = &a.annotation_type {
                    Some((*region, intensity.radius()))
                } else {
                    None
                }
            })
            .collect();

        if blur_regions.is_empty() {
            if let Some(ref path) = self.blur_preview_path {
                let _ = std::fs::remove_file(path);
            }
            self.blur_preview_path = None;
            return;
        }

        let Some(ref image_path) = self.file_path else {
            return;
        };

        let img = match image::open(image_path) {
            Ok(img) => img.to_rgba8(),
            Err(e) => {
                tracing::warn!("Failed to load image for blur preview: {}", e);
                return;
            }
        };

        let mut processed = img;
        for (region, radius) in &blur_regions {
            apply_blur_region(&mut processed, region, *radius);
        }

        let temp_dir = std::env::temp_dir();
        let temp_filename = format!("nib_blur_preview_{}.png", std::process::id());
        let temp_path = temp_dir.join(temp_filename);

        match processed.save(&temp_path) {
            Ok(()) => {
                tracing::debug!("Generated blur preview at {:?}", temp_path);
                self.blur_preview_path = Some(temp_path);
            }
            Err(e) => {
                tracing::warn!("Failed to save blur preview: {}", e);
            }
        }

        let elapsed = t0.elapsed();
        if elapsed.as_millis() > 10 {
            eprintln!("[PERF] regenerate_blur_preview_sync: {:?}", elapsed);
        }
    }

    /// Load annotations from a sidecar JSON file or .nib file
    fn load_annotations(&mut self) {
        let t0 = std::time::Instant::now();

        // For .nib files, load from NibFile
        if let Some(ref nib) = self.nib_file {
            match nib.list_annotations() {
                Ok(annotations) => {
                    self.annotations = annotations;
                    tracing::info!("Loaded {} annotations from .nib file", self.annotations.len());
                }
                Err(e) => {
                    tracing::warn!("Failed to load annotations from .nib file: {}", e);
                }
            }
            let elapsed = t0.elapsed();
            if elapsed.as_millis() > 10 {
                eprintln!("[PERF] load_annotations (nib): {:?}", elapsed);
            }
            return;
        }

        // For regular image files, load from sidecar JSON
        let Some(ref image_path) = self.file_path else {
            return;
        };

        let annotations_path = annotations_file_path(image_path);
        if !annotations_path.exists() {
            return;
        }

        match std::fs::read_to_string(&annotations_path) {
            Ok(json) => {
                match serde_json::from_str::<AnnotationsFile>(&json) {
                    Ok(file) => {
                        self.annotations = file.annotations
                            .iter()
                            .filter_map(deserialize_annotation)
                            .collect();
                        tracing::info!("Loaded {} annotations from {:?}", self.annotations.len(), annotations_path);
                    }
                    Err(e) => {
                        tracing::warn!("Failed to parse annotations file {:?}: {}", annotations_path, e);
                    }
                }
            }
            Err(e) => {
                tracing::warn!("Failed to read annotations file {:?}: {}", annotations_path, e);
            }
        }

        let elapsed = t0.elapsed();
        if elapsed.as_millis() > 10 {
            eprintln!("[PERF] load_annotations (json): {:?}", elapsed);
        }
    }

    fn sync_sent_annotations_baseline(&mut self) {
        let mut max_id = 0;
        for annotation in &self.annotations {
            let id = annotation.id.0;
            if id > max_id {
                max_id = id;
            }
            self.sent_annotation_ids.insert(id);
        }
        AnnotationId::bump_to_at_least(max_id.saturating_add(1));
    }

    /// Handle tool selection from toolbar
    pub(crate) fn select_tool(&mut self, tool: ToolId, cx: &mut Context<Self>) {
        // Set the active tool in the tool manager, which handles:
        // - Deactivating the old tool (may produce pending results)
        // - Activating the new tool
        // We inline context building to enable split borrows (annotations vs tool_manager)
        let deactivation_result = {
            let scale = self.canvas.scale();
            let offset = self.canvas.offset_tuple();
            let ctx = self.style_state.tool_context(
                (self.image_width, self.image_height),
                scale,
                offset,
                &self.annotations,
                5.0,
            );
            self.tool_manager.set_active_tool(tool, &ctx)
        };

        // Process any result from deactivating the old tool (e.g., pending text)
        if let Some(result) = deactivation_result {
            self.process_tool_result(result, cx);
        }

        // Update UI state
        self.active_tool = tool;
        cx.notify();
    }

    /// Handle mouse down event on canvas
    fn handle_mouse_down(&mut self, event: &MouseDownEvent, cx: &mut Context<Self>) {
        // If in text input mode, clicking away confirms the text (Figma behavior)
        if self.text_input_state.is_some() {
            self.confirm_text_input(cx);
            // Don't start a new action on this click - just finish the text
            return;
        }

        // Convert screen coordinates to image coordinates
        let position = event.position;
        let screen_x: f32 = position.x.into();
        let screen_y: f32 = position.y.into();
        let (img_x, img_y) = self.screen_to_image_coords(screen_x, screen_y);

        // Map GPUI mouse button to tool mouse button
        let button = match event.button {
            MouseButton::Left => ToolMouseButton::Left,
            MouseButton::Right => ToolMouseButton::Right,
            MouseButton::Middle => ToolMouseButton::Middle,
            MouseButton::Navigate(_) => ToolMouseButton::Left, // Fallback
        };

        // Build tool event
        let tool_event = ToolEvent::MouseDown {
            position: NibPoint::new(img_x, img_y),
            button,
            modifiers: Modifiers::default(),
        };

        // Dispatch to tool manager
        // We inline context building to enable split borrows (annotations vs tool_manager)
        let result = {
            let scale = self.canvas.scale();
            let offset = self.canvas.offset_tuple();
            let ctx = self.style_state.tool_context(
                (self.image_width, self.image_height),
                scale,
                offset,
                &self.annotations,
                5.0,
            );
            self.tool_manager.handle_event(tool_event, &ctx)
        };
        self.process_tool_result(result, cx);
    }

    /// Handle mouse move event on canvas
    fn handle_mouse_move(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        // Convert screen coordinates to image coordinates
        let position = event.position;
        let screen_x: f32 = position.x.into();
        let screen_y: f32 = position.y.into();
        let (img_x, img_y) = self.screen_to_image_coords(screen_x, screen_y);

        // Build tool event
        let tool_event = ToolEvent::MouseMove {
            position: NibPoint::new(img_x, img_y),
            modifiers: Modifiers::default(),
        };

        // Dispatch to tool manager
        // We inline context building to enable split borrows (annotations vs tool_manager)
        let result = {
            let scale = self.canvas.scale();
            let offset = self.canvas.offset_tuple();
            let ctx = self.style_state.tool_context(
                (self.image_width, self.image_height),
                scale,
                offset,
                &self.annotations,
                5.0,
            );
            self.tool_manager.handle_event(tool_event, &ctx)
        };
        self.process_tool_result(result, cx);
    }

    /// Handle mouse up event on canvas
    fn handle_mouse_up(&mut self, event: &MouseUpEvent, cx: &mut Context<Self>) {
        // Convert screen coordinates to image coordinates
        let position = event.position;
        let screen_x: f32 = position.x.into();
        let screen_y: f32 = position.y.into();
        let (img_x, img_y) = self.screen_to_image_coords(screen_x, screen_y);

        // Map GPUI mouse button to tool mouse button
        let button = match event.button {
            MouseButton::Left => ToolMouseButton::Left,
            MouseButton::Right => ToolMouseButton::Right,
            MouseButton::Middle => ToolMouseButton::Middle,
            MouseButton::Navigate(_) => ToolMouseButton::Left, // Fallback
        };

        // Build tool event
        let tool_event = ToolEvent::MouseUp {
            position: NibPoint::new(img_x, img_y),
            button,
        };

        // Dispatch to tool manager
        // We inline context building to enable split borrows (annotations vs tool_manager)
        let result = {
            let scale = self.canvas.scale();
            let offset = self.canvas.offset_tuple();
            let ctx = self.style_state.tool_context(
                (self.image_width, self.image_height),
                scale,
                offset,
                &self.annotations,
                5.0,
            );
            self.tool_manager.handle_event(tool_event, &ctx)
        };
        self.process_tool_result(result, cx);
    }

    /// Handle scroll wheel event for zoom (Figma-like: Cmd/Ctrl+scroll = zoom to cursor)
    fn handle_scroll_wheel(&mut self, event: &ScrollWheelEvent, cx: &mut Context<Self>) {
        let position = event.position;
        let screen_x: f32 = position.x.into();
        let screen_y: f32 = position.y.into();

        // Get scroll delta - convert to pixels if needed
        let delta = event.delta.pixel_delta(px(20.0));
        let delta_y: f32 = delta.y.into();

        // Cmd/Ctrl + scroll = zoom, otherwise pan
        if event.modifiers.secondary() {
            // Zoom mode: zoom in/out centered on cursor
            // Positive delta_y = scroll up = zoom in
            let zoom_factor = if delta_y > 0.0 {
                ZOOM_FACTOR
            } else if delta_y < 0.0 {
                1.0 / ZOOM_FACTOR
            } else {
                return;
            };

            self.canvas.zoom_at(screen_x, screen_y, zoom_factor);
            cx.notify();
        } else {
            // Pan mode: scroll to pan the canvas
            let delta_x: f32 = delta.x.into();
            self.canvas.pan(delta_x as f64, delta_y as f64);
            cx.notify();
        }
    }

    /// Render the toolbar
    fn render_toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        // Rectangle/Ellipse/Line/Pencil/Highlight live behind the shape
        // flyout (see tool_flyout.rs) instead of individual toolbar slots.
        let tools_before_shapes = [Tool::Select, Tool::Arrow];
        let tools_after_shapes = [Tool::Text, Tool::Number, Tool::Blur, Tool::Eraser, Tool::Image];

        let button_bg = rgb(0x3d3d3d);
        let button_active_bg = rgb(0x0078d4);
        let text_color = rgb(0xcccccc);
        let icon_color = rgb(0xffffff);

        // Outer wrapper for centering at bottom
        div()
            .absolute()
            .bottom_4()
            .left_0()
            .right_0()
            .flex()
            .justify_center()
            .child(
                // Actual toolbar container
                div()
                    .flex()
                    .flex_row()
                    .h(px(64.))
                    .bg(rgba(0x2d2d2dee)) // Semi-transparent background
                    .rounded_xl()
                    .border_1()
                    .border_color(rgba(0x00000044))
                    .px_3()
                    .gap_1()
                    .items_center()
                    .children(tools_before_shapes.iter().map(|tool| {
                let is_active = *tool == self.active_tool;
                let tool_copy = *tool;

                div()
                    .id(tool.name())
                    .relative()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .w(px(56.))
                    .h(px(56.))
                    .rounded_md()
                    .cursor_pointer()
                    .bg(if is_active { button_active_bg } else { rgba(0x3d3d3d00) })
                    .hover(|style| style.bg(button_bg))
                    .child(
                        svg()
                            .path(tool.icon_path())
                            .size(px(28.))
                            .text_color(icon_color)
                    )
                    // Keyboard shortcut badge on top-right
                    .child(render_shortcut_badge(
                        tool.shortcut().to_ascii_uppercase().to_string(),
                        text_color,
                    ))
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        this.select_tool(tool_copy, cx);
                    }))
            }))
                    // Shape tools (Rectangle/Ellipse/Line/Pencil/Highlight) collapsed into
                    // one flyout button (see tool_flyout.rs and toolbar_layout_tests for
                    // the width accounting this collapse relies on).
                    .child({
                        let current_icon = self.shape_flyout_icon();
                        let is_group_active = tool_flyout::SHAPE_TOOLS.contains(&self.active_tool);
                        let flyout_open = self.shape_flyout_open;

                        div()
                            .id("shape-flyout-button")
                            .relative()
                            .flex()
                            .flex_col()
                            .items_center()
                            .justify_center()
                            .w(px(56.))
                            .h(px(56.))
                            .rounded_md()
                            .cursor_pointer()
                            .bg(if is_group_active || flyout_open { button_active_bg } else { rgba(0x3d3d3d00) })
                            .hover(|style| style.bg(button_bg))
                            .child(
                                svg()
                                    .path(current_icon.icon_path())
                                    .size(px(28.))
                                    .text_color(icon_color)
                            )
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.shape_flyout_open = !this.shape_flyout_open;
                                cx.notify();
                            }))
                            .when(flyout_open, |el| {
                                el.child(self.render_shape_flyout(button_bg, button_active_bg, text_color, icon_color, cx))
                            })
                    })
                    .children(tools_after_shapes.iter().map(|tool| {
                let is_active = *tool == self.active_tool;
                let tool_copy = *tool;

                div()
                    .id(tool.name())
                    .relative()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .w(px(56.))
                    .h(px(56.))
                    .rounded_md()
                    .cursor_pointer()
                    .bg(if is_active { button_active_bg } else { rgba(0x3d3d3d00) })
                    .hover(|style| style.bg(button_bg))
                    .child(
                        svg()
                            .path(tool.icon_path())
                            .size(px(28.))
                            .text_color(icon_color)
                    )
                    // Keyboard shortcut badge on top-right
                    .child(render_shortcut_badge(
                        tool.shortcut().to_ascii_uppercase().to_string(),
                        text_color,
                    ))
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        this.select_tool(tool_copy, cx);
                    }))
            }))
                    // Separator
                    .child(
                        div()
                            .w(px(1.))
                            .h(px(40.))
                            .mx_2()
                            .bg(rgba(0xffffff33))
                    )
                    // Style selector: collapsed into one swatch button that toggles a popup
                    // (see toolbar_layout_tests::toolbar_fits_default_window_with_margin for the
                    // width accounting this collapse relies on to keep the default 1200x800
                    // window uncropped)
                    .child({
                        let selected_color = self.style_state.effective_color();
                        let gpui_selected_color = rgb(
                            selected_color.r as u32 * 0x10000 +
                            selected_color.g as u32 * 0x100 +
                            selected_color.b as u32
                        );
                        let picker_open = self.style_picker_open;

                        div()
                            .id("style-picker-button")
                            .relative()
                            .flex()
                            .flex_col()
                            .items_center()
                            .justify_center()
                            .w(px(48.))
                            .h(px(48.))
                            .rounded_md()
                            .cursor_pointer()
                            .bg(if picker_open { button_active_bg } else { rgba(0x3d3d3d00) })
                            .hover(|s| s.bg(button_bg))
                            // Keyboard shortcut badge on top-right
                            .child(render_shortcut_badge(
                                STYLE_PICKER_SHORTCUT.to_ascii_uppercase().to_string(),
                                text_color,
                            ))
                            // Selected color indicator circle
                            .child(
                                div()
                                    .w(px(20.))
                                    .h(px(20.))
                                    .rounded_full()
                                    .bg(gpui_selected_color)
                                    .border_2()
                                    .border_color(rgb(0xffffff))
                            )
                            // Selected style name
                            .child(
                                div()
                                    .text_color(text_color)
                                    .text_size(px(9.))
                                    .mt(px(2.))
                                    .child(self.style_state.style.label())
                            )
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.style_picker_open = !this.style_picker_open;
                                cx.notify();
                            }))
                            // Popup flyout body: style/color swatches + contextual style
                            // rows (stroke width, fill, stroke style, arrowhead, font size,
                            // blur intensity, opacity), rendered by style_panel.rs
                            .when(picker_open, |el| {
                                el.child(self.render_style_flyout(button_bg, button_active_bg, text_color, cx))
                            })
                    })
                    // Separator before Send button
                    .child(
                        div()
                            .w(px(1.))
                            .h(px(40.))
                            .mx_2()
                            .bg(rgba(0xffffff33))
                    )
                    // Send button
                    .child(
                        div()
                            .id("send-button")
                            .relative()
                            .flex()
                            .items_center()
                            .justify_center()
                            .w(px(80.))  // Explicit width for click target
                            .h(px(44.))
                            .rounded_md()
                            .cursor_pointer()
                            .bg(rgb(0x0078d4))  // Blue
                            .hover(|s| s.bg(rgb(0x1084d8)))
                            .child(render_shortcut_badge(SEND_SHORTCUT_LABEL, text_color))
                            .child(
                                div()
                                    .text_color(rgb(0xffffff))
                                    .text_size(px(14.))
                                    .font_weight(gpui::FontWeight::MEDIUM)
                                    .child("Send")
                            )
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.send_to_claude(cx);
                            }))
                    )
                    // Approve button
                    .child(
                        div()
                            .id("approve-button")
                            .relative()
                            .flex()
                            .items_center()
                            .justify_center()
                            .w(px(110.))  // Explicit width for click target
                            .h(px(44.))
                            .ml_2()
                            .rounded_md()
                            .cursor_pointer()
                            .bg(rgb(0x2e7d32))  // Green
                            .hover(|s| s.bg(rgb(0x388e3c)))
                            .child(render_shortcut_badge(APPROVE_SHORTCUT_LABEL, text_color))
                            .child(
                                div()
                                    .text_color(rgb(0xffffff))
                                    .text_size(px(14.))
                                    .font_weight(gpui::FontWeight::MEDIUM)
                                    .child("✓ Approve")
                            )
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.approve_to_claude(cx);
                            }))
                    )
                    // Reject button
                    .child(
                        div()
                            .id("reject-button")
                            .relative()
                            .flex()
                            .items_center()
                            .justify_center()
                            .w(px(100.))  // Explicit width for click target
                            .h(px(44.))
                            .ml_2()
                            .rounded_md()
                            .cursor_pointer()
                            .bg(rgb(0xc62828))  // Red
                            .hover(|s| s.bg(rgb(0xd32f2f)))
                            .child(render_shortcut_badge(REJECT_SHORTCUT_LABEL, text_color))
                            .child(
                                div()
                                    .text_color(rgb(0xffffff))
                                    .text_size(px(14.))
                                    .font_weight(gpui::FontWeight::MEDIUM)
                                    .child("✗ Reject")
                            )
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.reject_to_claude(cx);
                            }))
                    ),
            ) // Close inner toolbar container
    }

    /// Render a single annotation as an overlay element
    fn render_annotation(&self, annotation: &Annotation) -> impl IntoElement {
        let color = annotation.color;
        let gpui_color = rgba(
            color.r as u32 * 0x1000000 +
            color.g as u32 * 0x10000 +
            color.b as u32 * 0x100 +
            color.a as u32
        );
        let border_color = rgb(
            color.r as u32 * 0x10000 +
            color.g as u32 * 0x100 +
            color.b as u32
        );

        // Get scale factor for stroke width scaling
        let (scale, _, _) = self.calculate_scale_and_offset();

        match &annotation.annotation_type {
            AnnotationType::Box { region, stroke_width, stroke_style, filled, corner_radius } => {
                // Scale coordinates from image space to screen space
                let (sx, sy, sw, sh) = self.scale_coords(region.x, region.y, region.width, region.height);
                let mut element = div()
                    .absolute()
                    .left(px(sx))
                    .top(px(sy))
                    .w(px(sw))
                    .h(px(sh))
                    .border_color(border_color);
                element = Self::apply_border_width(element, *stroke_width);
                if *stroke_style != StrokeStyle::Solid {
                    element = element.border_dashed();
                }

                if *corner_radius > 0.0 {
                    element = element.rounded_md();
                }

                if *filled {
                    element = element.bg(gpui_color);
                }

                element.into_any_element()
            }
            AnnotationType::Arrow { start, end, head, stroke_width } => {
                let (start_sx, start_sy) = self.scale_point(start.x, start.y);
                let (end_sx, end_sy) = self.scale_point(end.x, end.y);
                let stroke = *stroke_width as f32 * scale;
                Self::render_arrow_element(start_sx, start_sy, end_sx, end_sy, stroke, *head, border_color.into())
                    .into_any_element()
            }
            AnnotationType::Line { start, end, stroke_width, stroke_style } => {
                let (start_sx, start_sy) = self.scale_point(start.x, start.y);
                let (end_sx, end_sy) = self.scale_point(end.x, end.y);
                let stroke = *stroke_width as f32 * scale;
                Self::render_line_element(start_sx, start_sy, end_sx, end_sy, stroke, *stroke_style, border_color.into())
                    .into_any_element()
            }
            AnnotationType::Ellipse { center, radius_x, radius_y, stroke_width, filled } => {
                // Scale center and radii
                let (center_sx, center_sy) = self.scale_point(center.x, center.y);
                let scaled_radius_x = *radius_x as f32 * scale;
                let scaled_radius_y = *radius_y as f32 * scale;

                let mut element = div()
                    .absolute()
                    .left(px(center_sx - scaled_radius_x))
                    .top(px(center_sy - scaled_radius_y))
                    .w(px(scaled_radius_x * 2.0))
                    .h(px(scaled_radius_y * 2.0))
                    .border_color(border_color)
                    .rounded_full();
                element = Self::apply_border_width(element, *stroke_width);

                if *filled {
                    element = element.bg(gpui_color);
                }

                element.into_any_element()
            }
            AnnotationType::Text { position, content, font_size, background, max_width, .. } => {
                // Scale position and font size
                let (sx, sy) = self.scale_point(position.x, position.y);
                let scaled_font_size = *font_size as f32 * scale;

                match background {
                    // Sticky note: opaque background rect, wrapped plain text, no outline
                    Some(bg) => {
                        let scaled_max_width = max_width.map(|w| w as f32 * scale);
                        Self::render_sticky_note(
                            content.clone(),
                            sx,
                            sy,
                            scaled_font_size,
                            scaled_max_width,
                            border_color.into(),
                            *bg,
                        )
                        .into_any_element()
                    }
                    // Ordinary text: outlined for legibility over an arbitrary image
                    None => Self::render_text_with_outline(
                        content.clone(),
                        sx,
                        sy,
                        scaled_font_size,
                        border_color.into(),
                    )
                    .into_any_element(),
                }
            }
            AnnotationType::Number { position, value, radius } => {
                // Scale position and radius
                let (sx, sy) = self.scale_point(position.x, position.y);
                let scaled_radius = *radius as f32 * scale;

                div()
                    .absolute()
                    .left(px(sx - scaled_radius))
                    .top(px(sy - scaled_radius))
                    .w(px(scaled_radius * 2.0))
                    .h(px(scaled_radius * 2.0))
                    .rounded_full()
                    .bg(border_color)
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(rgb(0xffffff))
                    .text_sm()
                    .child(value.to_string())
                    .into_any_element()
            }
            AnnotationType::Highlight { region, .. } => {
                let highlight_color = rgba(
                    color.r as u32 * 0x1000000 +
                    color.g as u32 * 0x10000 +
                    color.b as u32 * 0x100 +
                    0x60  // Semi-transparent
                );

                // Scale coordinates
                let (sx, sy, sw, sh) = self.scale_coords(region.x, region.y, region.width, region.height);

                div()
                    .absolute()
                    .left(px(sx))
                    .top(px(sy))
                    .w(px(sw))
                    .h(px(sh))
                    .bg(highlight_color)
                    .into_any_element()
            }
            AnnotationType::Blur { region, .. } => {
                // Scale coordinates
                let (sx, sy, sw, sh) = self.scale_coords(region.x, region.y, region.width, region.height);

                // Blur is rendered in the preview image, no overlay needed
                div()
                    .absolute()
                    .left(px(sx))
                    .top(px(sy))
                    .w(px(sw))
                    .h(px(sh))
                    .into_any_element()
            }
            AnnotationType::Crop { region } => {
                // Scale coordinates
                let (sx, sy, sw, sh) = self.scale_coords(region.x, region.y, region.width, region.height);

                // Crop region shown as dashed border
                div()
                    .absolute()
                    .left(px(sx))
                    .top(px(sy))
                    .w(px(sw))
                    .h(px(sh))
                    .border_2()
                    .border_color(rgb(0x00ff00))
                    .into_any_element()
            }
            AnnotationType::Path { points, stroke_width, stroke_style } => {
                if points.len() < 2 {
                    return div().into_any_element();
                }

                // Scale all points to screen coordinates
                let scaled_points: Vec<(f32, f32)> = points
                    .iter()
                    .map(|p| self.scale_point(p.x, p.y))
                    .collect();

                let stroke = *stroke_width as f32 * scale;

                Self::render_path_element(scaled_points, stroke, *stroke_style, border_color.into())
                    .into_any_element()
            }
            AnnotationType::Image { region, asset, opacity } => {
                let (sx, sy, sw, sh) = self.scale_coords(region.x, region.y, region.width, region.height);

                match self.asset_cache.get(&asset.0) {
                    Some(asset_data) => {
                        let gpui_image = std::sync::Arc::new(gpui::Image::from_bytes(
                            image_format_to_gpui(&asset_data.format),
                            asset_data.bytes.clone(),
                        ));
                        div()
                            .absolute()
                            .left(px(sx))
                            .top(px(sy))
                            .w(px(sw))
                            .h(px(sh))
                            .opacity(*opacity as f32)
                            .child(img(gpui_image).w(px(sw)).h(px(sh)))
                            .into_any_element()
                    }
                    // No bytes cached for this hash (e.g. a sidecar-only load with
                    // no asset_base64) -- show a placeholder instead of nothing.
                    None => div()
                        .absolute()
                        .left(px(sx))
                        .top(px(sy))
                        .w(px(sw))
                        .h(px(sh))
                        .bg(rgba(0x88888866))
                        .border_1()
                        .border_color(rgb(0x888888))
                        .into_any_element(),
                }
            }
        }
    }

    /// Map a stroke width to the closest of GPUI's fixed border-width presets
    /// (it only ships `border_1`..`border_8`, no arbitrary-width border). The style
    /// panel only offers S/M/L = 2/4/8, so this covers those exactly and snaps any
    /// other value (e.g. from older sidecars) to the nearest preset.
    fn apply_border_width(element: Div, stroke_width: f64) -> Div {
        if stroke_width <= 3.0 {
            element.border_2()
        } else if stroke_width <= 6.0 {
            element.border_4()
        } else {
            element.border_8()
        }
    }

    /// Render the tool preview from the tool manager
    fn render_tool_preview(&self) -> Option<impl IntoElement> {
        let ctx = self.build_tool_context();
        let preview = self.tool_manager.preview(&ctx);

        match preview {
            ToolPreview::None => None,
            ToolPreview::Rectangle { region, color } => {
                let preview_color = rgb(
                    color.r as u32 * 0x10000 + color.g as u32 * 0x100 + color.b as u32,
                );
                let preview_bg = rgba(
                    color.r as u32 * 0x1000000
                        + color.g as u32 * 0x10000
                        + color.b as u32 * 0x100
                        + 0x40, // Semi-transparent
                );

                // Scale region to screen coordinates
                let (sx, sy, sw, sh) =
                    self.scale_coords(region.x, region.y, region.width, region.height);

                Some(
                    div()
                        .absolute()
                        .left(px(sx))
                        .top(px(sy))
                        .w(px(sw))
                        .h(px(sh))
                        .border_2()
                        .border_color(preview_color)
                        .bg(preview_bg)
                        .into_any_element(),
                )
            }
            ToolPreview::Line { start, end, color } => {
                let preview_color = rgb(
                    color.r as u32 * 0x10000 + color.g as u32 * 0x100 + color.b as u32,
                );
                let (start_sx, start_sy) = self.scale_point(start.x, start.y);
                let (end_sx, end_sy) = self.scale_point(end.x, end.y);

                Some(
                    Self::render_line_element(start_sx, start_sy, end_sx, end_sy, 2.0, StrokeStyle::Solid, preview_color.into())
                        .into_any_element(),
                )
            }
            ToolPreview::Ellipse {
                center,
                radius_x,
                radius_y,
                color,
            } => {
                let preview_color = rgb(
                    color.r as u32 * 0x10000 + color.g as u32 * 0x100 + color.b as u32,
                );

                // Scale to screen coordinates
                let (center_sx, center_sy) = self.scale_point(center.x, center.y);
                let (scale, _, _) = self.calculate_scale_and_offset();
                let scaled_radius_x = radius_x as f32 * scale;
                let scaled_radius_y = radius_y as f32 * scale;

                Some(
                    div()
                        .absolute()
                        .left(px(center_sx - scaled_radius_x))
                        .top(px(center_sy - scaled_radius_y))
                        .w(px(scaled_radius_x * 2.0))
                        .h(px(scaled_radius_y * 2.0))
                        .border_2()
                        .border_color(preview_color)
                        .rounded_full()
                        .into_any_element(),
                )
            }
            ToolPreview::Selection { bounds, handles, guides } => {
                // Render selection bounds with optional resize handles
                if bounds.is_empty() {
                    return None;
                }

                let selection_color = rgb(0x3b82f6); // Blue selection color
                let handle_color = rgb(0xffffff); // White handles
                let handle_size = 8.0_f32;

                // For now, render only the first bound (single selection case)
                // Multi-selection rendering can be enhanced later
                let region = &bounds[0];
                let (sx, sy, sw, sh) =
                    self.scale_coords(region.x, region.y, region.width, region.height);

                let mut container = div()
                    .absolute()
                    .left(px(sx))
                    .top(px(sy))
                    .w(px(sw))
                    .h(px(sh))
                    .border_1()
                    .border_color(selection_color);

                // Render resize handles if provided
                if let Some(handle_positions) = handles {
                    let mut handles_container = div().absolute().left(px(0.0)).top(px(0.0));

                    for (point, _handle_type) in handle_positions {
                        let (hx, hy) = self.scale_point(point.x, point.y);
                        handles_container = handles_container.child(
                            div()
                                .absolute()
                                .left(px(hx - handle_size / 2.0))
                                .top(px(hy - handle_size / 2.0))
                                .w(px(handle_size))
                                .h(px(handle_size))
                                .bg(handle_color)
                                .border_1()
                                .border_color(selection_color),
                        );
                    }

                    container = container.child(handles_container);
                }

                if guides.is_empty() {
                    return Some(container.into_any_element());
                }

                // Guides span the whole canvas, not just the selection's local
                // bounds, so they're siblings of `container` rather than its
                // children (reusing the same absolute-positioning context).
                let guide_color = rgb(0xff00ff); // Magenta, distinct from the blue selection outline
                let (canvas_sx, canvas_sy, canvas_sw, canvas_sh) =
                    self.scale_coords(0.0, 0.0, self.canvas.image_width, self.canvas.image_height);
                let mut guides_container = div().absolute().left(px(0.0)).top(px(0.0));
                for guide in guides {
                    guides_container = match guide {
                        crate::layout::Guide::Vertical(x) => {
                            let (gx, _) = self.scale_point(x, 0.0);
                            guides_container.child(
                                div()
                                    .absolute()
                                    .left(px(gx))
                                    .top(px(canvas_sy))
                                    .w(px(1.0))
                                    .h(px(canvas_sh))
                                    .bg(guide_color),
                            )
                        }
                        crate::layout::Guide::Horizontal(y) => {
                            let (_, gy) = self.scale_point(0.0, y);
                            guides_container.child(
                                div()
                                    .absolute()
                                    .left(px(canvas_sx))
                                    .top(px(gy))
                                    .w(px(canvas_sw))
                                    .h(px(1.0))
                                    .bg(guide_color),
                            )
                        }
                    };
                }

                Some(div().child(container).child(guides_container).into_any_element())
            }
            ToolPreview::Marquee { region } => {
                // Render marquee selection rectangle (dashed border effect)
                let marquee_color = rgb(0x3b82f6); // Blue
                let (sx, sy, sw, sh) =
                    self.scale_coords(region.x, region.y, region.width, region.height);

                Some(
                    div()
                        .absolute()
                        .left(px(sx))
                        .top(px(sy))
                        .w(px(sw))
                        .h(px(sh))
                        .border_1()
                        .border_color(marquee_color)
                        .into_any_element(),
                )
            }
            ToolPreview::Path {
                points,
                color,
                stroke_width,
            } => {
                if points.len() < 2 {
                    return None;
                }

                let preview_color = rgb(
                    color.r as u32 * 0x10000 + color.g as u32 * 0x100 + color.b as u32,
                );

                // Scale all points to screen coordinates
                let scaled_points: Vec<(f32, f32)> = points
                    .iter()
                    .map(|p| self.scale_point(p.x, p.y))
                    .collect();

                let stroke = stroke_width as f32 * self.calculate_scale_and_offset().0;

                Some(
                    Self::render_path_element(scaled_points, stroke, StrokeStyle::Solid, preview_color.into())
                        .into_any_element(),
                )
            }
        }
    }

    /// Render the canvas area with image and annotations
    fn render_canvas(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let background_color = rgb(0x1e1e1e);
        let text_color = rgb(0xcccccc);

        let mut canvas = div()
            .id("canvas")
            .size_full()
            .bg(background_color)
            .relative()
            .overflow_hidden()
            .track_focus(&self.focus_handle)
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                this.handle_key_down(event, window, cx);
            }))
            .on_mouse_down(MouseButton::Left, cx.listener(|this, event, window, cx| {
                // Grab focus so keyboard shortcuts work
                this.focus_handle.focus(window);
                this.handle_mouse_down(event, cx);
            }))
            .on_mouse_move(cx.listener(|this, event, _window, cx| {
                this.handle_mouse_move(event, cx);
            }))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, event, _window, cx| {
                this.handle_mouse_up(event, cx);
            }))
            .on_scroll_wheel(cx.listener(|this, event, _window, cx| {
                this.handle_scroll_wheel(event, cx);
            }));

        // Add image if we have one - use explicit positioning to match annotation coordinates
        if let Some(path) = &self.file_path {
            let (scale, offset_x, offset_y) = self.calculate_scale_and_offset();
            let scaled_width = self.image_width as f32 * scale;
            let scaled_height = self.image_height as f32 * scale;

            // Use blur preview if available, otherwise original image
            let display_path = self.blur_preview_path.as_ref().unwrap_or(path);

            canvas = canvas.child(
                div()
                    .absolute()
                    .left(px(offset_x))
                    .top(px(offset_y))
                    .w(px(scaled_width))
                    .h(px(scaled_height))
                    .child(
                        img(display_path.clone())
                            .size_full()
                            .with_fallback(move || {
                                div()
                                    .text_color(rgb(0xff6666))
                                    .child("Failed to load image")
                                    .into_any_element()
                            }),
                    ),
            );
        } else {
            canvas = canvas.child(
                div()
                    .size_full()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap_4()
                    .child(
                        div()
                            .text_color(text_color)
                            .text_xl()
                            .child("Nib Screenshot Annotator"),
                    )
                    .child(
                        div()
                            .text_color(rgb(0x888888))
                            .child("No image loaded. Use: nib gui <file>"),
                    ),
            );
        }

        // Add annotation overlays (skip text annotation being edited), painted in
        // z_index order (ascending) so later/higher z_index annotations render on
        // top -- required for ⌘]/⌘[ z-order to have any visible effect.
        let mut z_ordered: Vec<&Annotation> = self.annotations.iter().collect();
        z_ordered.sort_by_key(|a| a.z_index);
        for annotation in z_ordered {
            // If we're editing this annotation, skip rendering it - we'll render the editable version
            let is_being_edited = self.text_input_state.as_ref()
                .and_then(|state| state.editing_annotation_id)
                .map(|id| id == annotation.id)
                .unwrap_or(false);

            if !is_being_edited {
                canvas = canvas.child(self.render_annotation(annotation));
            }
        }

        // Add tool preview if actively drawing
        if let Some(preview) = self.render_tool_preview() {
            canvas = canvas.child(preview);
        }

        // Add inline text editing if in text input mode (Figma-style, directly on canvas)
        if let Some(ref input_state) = self.text_input_state {
            canvas = canvas.child(self.render_inline_text_editing(input_state));
        }

        canvas
    }

    /// Handle keyboard input
    fn handle_key_down(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let keystroke = &event.keystroke;

        // Handle Shift+Cmd+Enter to send to Claude and quit
        if keystroke.modifiers.shift && keystroke.modifiers.platform && keystroke.key.as_str() == "enter" {
            self.send_to_claude_and_quit(cx);
            return;
        }

        // Handle Cmd+Enter to send to Claude
        if keystroke.modifiers.platform && keystroke.key.as_str() == "enter" {
            self.send_to_claude(cx);
            return;
        }

        // Handle Cmd+Shift+A to approve
        if keystroke.modifiers.platform && keystroke.modifiers.shift && keystroke.key.as_str() == "a" {
            self.approve_to_claude(cx);
            return;
        }

        // Handle Cmd+Shift+R to reject
        if keystroke.modifiers.platform && keystroke.modifiers.shift && keystroke.key.as_str() == "r" {
            self.reject_to_claude(cx);
            return;
        }

        // Handle zoom/undo/redo/duplicate/z-order keyboard shortcuts (Cmd/Ctrl + key)
        // Skip if in text input mode
        if keystroke.modifiers.platform && self.text_input_state.is_none() {
            let key = keystroke.key.as_str();
            match key {
                // Cmd/Ctrl + Plus or Cmd/Ctrl + = : Zoom in
                "+" | "=" => {
                    self.canvas.zoom_center(ZOOM_FACTOR);
                    cx.notify();
                    return;
                }
                // Cmd/Ctrl + Minus : Zoom out
                "-" => {
                    self.canvas.zoom_center(1.0 / ZOOM_FACTOR);
                    cx.notify();
                    return;
                }
                // Cmd/Ctrl + 0 : Fit to view
                "0" => {
                    self.canvas.fit_to_view();
                    cx.notify();
                    return;
                }
                // Cmd/Ctrl + 1 : 100% zoom
                "1" => {
                    self.canvas.reset_zoom();
                    cx.notify();
                    return;
                }
                // Cmd/Ctrl + Shift + Z : Redo. Cmd/Ctrl + Z : Undo.
                "z" => {
                    if keystroke.modifiers.shift {
                        self.redo(cx);
                    } else {
                        self.undo(cx);
                    }
                    return;
                }
                // Cmd/Ctrl + D : Duplicate selection
                "d" => {
                    self.duplicate_selection(cx);
                    return;
                }
                // Cmd/Ctrl + Shift + G : Ungroup. Cmd/Ctrl + G : Group selection.
                "g" => {
                    if keystroke.modifiers.shift {
                        self.ungroup_selected(cx);
                    } else {
                        self.group_selected(cx);
                    }
                    return;
                }
                // Cmd/Ctrl + ] : Bring selected annotation forward one z-order step
                "]" => {
                    self.reorder_selected(zorder::Direction::Forward, cx);
                    return;
                }
                // Cmd/Ctrl + [ : Send selected annotation backward one z-order step
                "[" => {
                    self.reorder_selected(zorder::Direction::Backward, cx);
                    return;
                }
                _ => {}
            }
        }

        // Check for tool shortcuts (single letter, no modifiers, not in text input mode)
        if !keystroke.modifiers.shift
            && !keystroke.modifiers.control
            && !keystroke.modifiers.alt
            && !keystroke.modifiers.platform
            && self.text_input_state.is_none()
        {
            if let Some(key_char) = keystroke.key_char.as_ref().and_then(|s| s.chars().next()) {
                for &tool_id in Tool::all() {
                    if tool_id.shortcut() == key_char {
                        self.select_tool(tool_id, cx);
                        return;
                    }
                }

                // Style-picker popup toggle (not a Tool, so not covered by the loop above)
                if key_char == STYLE_PICKER_SHORTCUT {
                    self.style_picker_open = !self.style_picker_open;
                    cx.notify();
                    return;
                }
            }
        }

        // Extract modifier keys from the keystroke
        let modifiers = Modifiers {
            shift: keystroke.modifiers.shift,
            ctrl: keystroke.modifiers.control,
            alt: keystroke.modifiers.alt,
            cmd: keystroke.modifiers.platform,
        };

        // Build ToolEvent::KeyDown
        let tool_event = ToolEvent::KeyDown {
            key: keystroke.key.clone(),
            key_char: keystroke.key_char.as_ref().and_then(|s| s.chars().next()),
            modifiers,
        };

        // Dispatch to tool manager
        // We inline context building to enable split borrows (annotations vs tool_manager)
        let result = {
            let scale = self.canvas.scale();
            let offset = self.canvas.offset_tuple();
            let ctx = self.style_state.tool_context(
                (self.image_width, self.image_height),
                scale,
                offset,
                &self.annotations,
                5.0,
            );
            self.tool_manager.handle_event(tool_event, &ctx)
        };

        // Process the result
        self.process_tool_result(result, cx);

        // Sync content from TextTool to EditorView's text_input_state for rendering
        // (TextTool is the source of truth for content)
        if let Some(ref mut state) = self.text_input_state {
            if let Some(text_tool) = self.tool_manager.get_tool_as::<TextTool>(ToolId::Text) {
                state.content = text_tool.text_state().content.clone();
            }
        }
    }

    /// Confirm text input and create/update the annotation
    /// Delegates to TextTool to avoid duplicating annotation creation logic
    fn confirm_text_input(&mut self, cx: &mut Context<Self>) {
        if self.text_input_state.is_none() {
            return;
        }

        // Delegate to TextTool - it owns the text content and position
        // Build context inline to avoid borrow conflicts with tool_manager
        let (scale, offset_x, offset_y) = self.calculate_scale_and_offset();
        let result = {
            let ctx = self.style_state.tool_context(
                (self.image_width, self.image_height),
                scale,
                (offset_x, offset_y),
                &self.annotations,
                5.0,
            );
            if let Some(text_tool) = self.tool_manager.get_tool_as_mut::<TextTool>(ToolId::Text) {
                text_tool.confirm_text(&ctx)
            } else {
                ToolResult::Ignored
            }
        };

        // Clear EditorView's render state
        self.text_input_state = None;

        // Process the result through normal flow
        self.process_tool_result(result, cx);
    }

    /// Render inline text editing directly on canvas (Figma-style)
    /// Text renders just above the click position with a cursor, no overlay box
    fn render_inline_text_editing(&self, input_state: &TextInputState) -> impl IntoElement {
        // Window coords -> canvas coords (subtract toolbar height)
        let canvas_x = input_state.screen_x;
        let canvas_y = input_state.screen_y - TOOLBAR_HEIGHT;

        // Get scale for font sizing
        let (scale, _, _) = self.calculate_scale_and_offset();
        let font_size = self.style_state.font_size as f32;
        let scaled_font_size = font_size * scale;

        // Offset text up so it appears above the click point
        let text_y = canvas_y - scaled_font_size;

        // Use the effective color (based on current style)
        let color = self.effective_color();
        let text_color = rgb(
            color.r as u32 * 0x10000 +
            color.g as u32 * 0x100 +
            color.b as u32
        );

        // Cursor color matches text
        let cursor_color = text_color;

        // Outline settings for text readability
        let outline_offset = (scaled_font_size * 0.08).max(1.5);
        let outline_color = rgba(0x000000cc);
        let offsets: [(f32, f32); 8] = [
            (-outline_offset, -outline_offset),
            (0.0, -outline_offset),
            (outline_offset, -outline_offset),
            (-outline_offset, 0.0),
            (outline_offset, 0.0),
            (-outline_offset, outline_offset),
            (0.0, outline_offset),
            (outline_offset, outline_offset),
        ];

        let content = input_state.content.clone();

        div()
            .absolute()
            .left(px(canvas_x))
            .top(px(text_y))
            .flex()
            .flex_row()
            .items_center()
            // Container for text with outline
            .child(
                div()
                    .relative()
                    // Shadow layers
                    .children(offsets.iter().map(|(dx, dy)| {
                        div()
                            .absolute()
                            .left(px(*dx))
                            .top(px(*dy))
                            .text_color(outline_color)
                            .text_size(px(scaled_font_size))
                            .child(content.clone())
                    }))
                    // Main text
                    .child(
                        div()
                            .text_color(text_color)
                            .text_size(px(scaled_font_size))
                            .child(content.clone())
                    )
            )
            .child(
                // Blinking cursor - thin vertical bar after text
                div()
                    .w(px(2.))
                    .h(px(scaled_font_size))
                    .bg(cursor_color)
            )
    }
}

#[cfg(test)]
mod feedback_payload_tests {
    use super::{Annotation, AnnotationType, EditorView, NibPoint};

    fn number_annotation() -> Annotation {
        Annotation::new(AnnotationType::Number {
            position: NibPoint { x: 1.0, y: 2.0 },
            value: 5,
            radius: 10.0,
        })
    }

    #[test]
    fn decision_field_is_exact_for_each_path() {
        for decision in ["approve", "reject", "comment"] {
            let payload = EditorView::build_send_payload(decision, vec![]);
            let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
            assert_eq!(parsed["decision"], decision);
        }
    }

    #[test]
    fn approve_with_zero_annotations_yields_empty_annotations_array() {
        let payload = EditorView::build_send_payload("approve", vec![]);
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(
            parsed,
            serde_json::json!({ "decision": "approve", "annotations": [] })
        );
    }

    #[test]
    fn annotation_items_preserve_existing_shape() {
        let annotation = number_annotation();
        let refs = vec![&annotation];
        let items = EditorView::annotation_items_to_json(&refs);

        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["type"], "number");
        assert_eq!(items[0]["at"], serde_json::json!([1.0, 2.0]));
        assert_eq!(items[0]["content"], "5");

        let payload = EditorView::build_send_payload("comment", items);
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["decision"], "comment");
        assert_eq!(parsed["annotations"].as_array().unwrap().len(), 1);
    }
}

#[cfg(test)]
mod toolbar_layout_tests {
    // This crate has no headless GPUI layout harness to measure a real render pass, so this
    // is a static width accounting check standing in for one. The constants below mirror the
    // literal pixel widths/margins written in `render_toolbar` (crate::app) as of this change;
    // if those literals are edited, update these to match.
    const TOOLBAR_PADDING_X: f32 = 24.0; // px_3, both sides
    const GAP: f32 = 4.0; // gap_1, applied between each of the direct children below
    // Phase 4: Rectangle/Ellipse/Line/Pencil/Highlight collapsed into one shape-flyout
    // button (tool_flyout.rs), and Image added -- 2 (before) + 1 (flyout) + 5 (after,
    // includes Image) = 8 buttons, all the same 56px width. Margin ~288px, still passes.
    const NUM_TOOL_BUTTONS: f32 = 8.0;
    const TOOL_BUTTON_W: f32 = 56.0;
    const SEPARATOR_W: f32 = 1.0 + 8.0 * 2.0; // 1px rule + mx_2 margin both sides
    const STYLE_PICKER_BUTTON_W: f32 = 48.0; // collapsed swatch button (was 6 * 48px inline)
    const SEND_BUTTON_W: f32 = 80.0;
    const APPROVE_BUTTON_W: f32 = 110.0 + 8.0; // + ml_2
    const REJECT_BUTTON_W: f32 = 100.0 + 8.0; // + ml_2
    const DEFAULT_WINDOW_WIDTH: f32 = 1200.0;

    fn toolbar_min_width() -> f32 {
        // Direct children of the toolbar container, in render order:
        // [8 tool buttons/flyout] [separator] [style picker button] [separator] [send] [approve] [reject]
        let num_direct_children = NUM_TOOL_BUTTONS + 6.0;

        TOOLBAR_PADDING_X
            + NUM_TOOL_BUTTONS * TOOL_BUTTON_W
            + SEPARATOR_W * 2.0
            + STYLE_PICKER_BUTTON_W
            + SEND_BUTTON_W
            + APPROVE_BUTTON_W
            + REJECT_BUTTON_W
            + GAP * (num_direct_children - 1.0)
    }

    #[test]
    fn toolbar_fits_default_window_with_margin() {
        let width = toolbar_min_width();
        assert!(
            width < DEFAULT_WINDOW_WIDTH,
            "toolbar width {width} does not fit default window width {DEFAULT_WINDOW_WIDTH}"
        );
        // Require visible margin, not just a bare fit, so Reject isn't clipped at the edge.
        assert!(
            DEFAULT_WINDOW_WIDTH - width >= 100.0,
            "toolbar width {width} leaves less than 100px margin in a {DEFAULT_WINDOW_WIDTH}px window"
        );
    }

    #[test]
    fn collapsed_style_picker_is_narrower_than_six_inline_swatches() {
        // Guards against regressing the collapse: before this change all 6 AnnotationStyle
        // swatches (48px each) rendered inline in the toolbar, which is what pushed Reject
        // past the default window's right edge.
        let inline_swatches_width = 6.0 * STYLE_PICKER_BUTTON_W;
        assert!(STYLE_PICKER_BUTTON_W < inline_swatches_width);
    }
}

#[cfg(test)]
mod toolbar_shortcut_tests {
    use super::command_shortcuts;

    /// Real invariant: every toolbar command must have its own keystroke. This fails the
    /// moment someone adds a new command (or edits a `shortcut()`/label constant) whose
    /// keystroke collides with an existing one.
    #[test]
    fn every_toolbar_command_has_a_unique_keystroke() {
        let shortcuts = command_shortcuts();
        let mut seen = std::collections::HashSet::new();
        for (label, keystroke) in &shortcuts {
            assert!(
                seen.insert(keystroke.clone()),
                "keystroke {keystroke:?} is bound to more than one command (duplicate at {label:?}); full list: {shortcuts:?}"
            );
        }
    }

    #[test]
    fn every_toolbar_command_has_a_non_empty_keystroke() {
        for (label, keystroke) in command_shortcuts() {
            assert!(!keystroke.is_empty(), "{label} has no keystroke");
        }
    }
}

#[cfg(test)]
mod image_annotation_transform_tests {
    use super::*;

    fn image_at(x: f64, y: f64, w: f64, h: f64) -> AnnotationType {
        AnnotationType::Image {
            region: Region::new(x, y, w, h),
            asset: nib_core::AssetRef("hash".to_string()),
            opacity: 1.0,
        }
    }

    #[test]
    fn move_annotation_type_moves_an_image_region() {
        let mut image = image_at(10.0, 20.0, 30.0, 40.0);
        EditorView::move_annotation_type(&mut image, 5.0, -3.0);
        match image {
            AnnotationType::Image { region, .. } => {
                assert_eq!(region, Region::new(15.0, 17.0, 30.0, 40.0));
            }
            other => panic!("expected Image, got {other:?}"),
        }
    }

    #[test]
    fn resize_annotation_type_resizes_an_image_region() {
        let mut image = image_at(10.0, 20.0, 30.0, 40.0);
        let new_bounds = Region::new(0.0, 0.0, 100.0, 200.0);
        EditorView::resize_annotation_type(&mut image, new_bounds);
        match image {
            AnnotationType::Image { region, .. } => assert_eq!(region, new_bounds),
            other => panic!("expected Image, got {other:?}"),
        }
    }
}

impl Focusable for EditorView {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for EditorView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        // Schedule continuous re-renders to detect external file changes when idle
        window.request_animation_frame();

        // Update canvas dimensions from actual window size
        let viewport = window.viewport_size();
        let viewport_width: f32 = viewport.width.into();
        let viewport_height: f32 = viewport.height.into();
        self.canvas_width = viewport_width;
        self.canvas_height = viewport_height; // Toolbar floats inside canvas

        // Sync canvas viewport (handles resize and initial fit-to-view)
        self.canvas.set_viewport(viewport_width as f64, viewport_height as f64);

        // Check if sidecar file has changed and reload annotations if needed
        self.check_and_reload_annotations();

        // Process pending messages from CLI as toasts
        for message in std::mem::take(&mut self.pending_messages) {
            self.add_toast(message, cx);
        }

        // Clean up expired toasts
        self.cleanup_expired_toasts();

        // Process incoming collab messages (non-blocking)
        self.process_collab_messages(cx);

        // Inline text editing is now rendered directly on the canvas (Figma-style)
        // No separate overlay needed
        div()
            .id("editor-container")
            .size_full()
            .relative()
            .child(self.render_canvas(cx))
            .child(self.render_toolbar(cx)) // Toolbar floats over canvas
            .child(self.render_toasts()) // Toasts in top-right corner
            .child(self.render_claude_question()) // Claude question banner at top center
    }
}
