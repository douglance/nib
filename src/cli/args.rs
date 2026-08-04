//! CLI argument definitions using clap

use clap::{Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

/// Nib - Fast, native screenshot annotation tool
///
/// Human-AI collaboration through visual feedback:
/// - Humans use the GUI to draw annotations
/// - Claude uses the CLI to capture, annotate, and inspect images
#[derive(Parser, Debug)]
#[command(name = "nib")]
#[command(author, version, about, long_about = None)]
pub struct Cli {
    /// Enable verbose output
    #[arg(short, long, global = true)]
    pub verbose: bool,

    /// Output format for structured data
    #[arg(long, global = true, default_value = "text")]
    pub format: OutputFormat,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    // === Human Interface ===
    /// Launch the GUI editor (human's entry point)
    Gui(GuiArgs),

    // === Claude Actions ===
    /// Capture a screen region
    Capture(CaptureArgs),

    /// Ask a human for visual feedback and await structured JSON
    #[command(name = "feedback", alias = "ask-human")]
    Feedback(FeedbackArgs),

    /// Open an existing feedback session in the terminal reviewer
    Review(ReviewArgs),

    /// Inspect or wait for a durable human request
    #[command(subcommand)]
    Request(RequestCommand),

    /// Record the screen and manage durable recording workers
    #[command(subcommand)]
    Record(RecordCommand),

    /// Inspect and derive supported media files
    #[command(subcommand)]
    Media(MediaCommand),

    /// Wait for annotation submit event from GUI
    AwaitSubmit(AwaitSubmitArgs),

    /// Manage annotations (add/remove/clear/list)
    #[command(subcommand)]
    Annotation(AnnotationCommand),

    /// Render annotations onto image
    Render(RenderArgs),

    /// Import image to .nib format
    Import(ImportArgs),

    /// Export .nib file (rendered, json, or qml format)
    Export(ExportArgs),

    /// Generate an image via the configured generator (default: imago)
    Generate(GenerateArgs),

    /// Judge a pair of images via the configured judge tool (default: imago compare)
    Judge(JudgeArgs),

    // === Claude Inspection ===
    /// Overlay a coordinate grid on an image
    Grid(GridArgs),

    /// Find text in an image using OCR
    FindText(FindTextArgs),

    /// Pick a color from an image at specific coordinates
    PickColor(PickColorArgs),

    /// List capturable windows
    Windows(WindowsArgs),

    /// Show comprehensive info about a .nib file
    Info(InfoArgs),

    /// Manage tiled captures (query/extract/list)
    #[command(subcommand)]
    Tile(TileCommand),

    // === Utilities ===
    /// Validate QML syntax
    Validate(ValidateArgs),

    /// List recent captures
    List(ListArgs),

    /// List active collaboration sessions
    Sessions,
}

// === Subcommand Enums ===

#[derive(Subcommand, Debug)]
pub enum AnnotationCommand {
    /// Add an annotation to an image
    Add(AnnotationAddArgs),

    /// Remove a specific annotation by ID
    Remove(AnnotationRemoveArgs),

    /// Clear all annotations from an image
    Clear(AnnotationClearArgs),

    /// List annotations for an image
    List(AnnotationListArgs),
}

#[derive(Subcommand, Debug)]
pub enum TileCommand {
    /// Query a tiled capture for point or region information
    Query(TileQueryArgs),

    /// Extract a region from a tiled capture at full resolution
    Extract(TileExtractArgs),

    /// List tiles in a tiled capture
    List(TileListArgs),
}

#[derive(Subcommand, Debug)]
pub enum RequestCommand {
    /// Publish a durable visual review and return immediately
    Create(RequestCreateArgs),

    /// Wait for a published request to receive a response
    Wait(RequestWaitArgs),

    /// Open a durable request in the native Rust reviewer
    Review(RequestReviewArgs),
}

#[derive(Subcommand, Debug)]
pub enum RecordCommand {
    /// Start a macOS screen recording and return its durable ID
    Start(RecordStartArgs),
    /// Read one recording or the currently active recording
    Status(RecordStatusArgs),
    /// Stop and finalize one recording
    Stop(RecordStopArgs),
    /// Wait for one recording to finish
    Wait(RecordWaitArgs),
}

#[derive(Subcommand, Debug)]
pub enum MediaCommand {
    /// Validate and inspect an MP4/H.264 media file
    Inspect(MediaInspectArgs),
    /// Extract a representative PNG poster frame
    Poster(MediaPosterArgs),
    /// Transcribe media with on-device speech services when available
    Transcribe(MediaTranscribeArgs),
}

// === Argument Structs ===

#[derive(Parser, Debug)]
pub struct GuiArgs {
    /// Optional image file to open in the editor
    pub file: Option<PathBuf>,
}

#[derive(Parser, Debug)]
pub struct CaptureArgs {
    /// Output file path (default: auto-generated in storage folder)
    #[arg(short, long)]
    pub output: Option<PathBuf>,

    /// Capture mode
    #[arg(short, long, default_value = "region")]
    pub mode: CaptureMode,

    /// Copy to clipboard instead of saving
    #[arg(long)]
    pub clipboard: bool,

    /// Open in editor after capture
    #[arg(short, long)]
    pub edit: bool,

    /// Delay before capture (seconds)
    #[arg(short, long, default_value = "0")]
    pub delay: u32,

    /// Capture a specific app's window (case-insensitive substring match)
    #[arg(long)]
    pub app: Option<String>,

    /// Capture window matching this title (case-insensitive substring match)
    #[arg(long)]
    pub title: Option<String>,

    /// Enable tiled capture for large images (creates tile pyramid)
    #[arg(long)]
    pub tiled: bool,

    /// Tile size in pixels (default: 512, only used with --tiled)
    #[arg(long, default_value = "512")]
    pub tile_size: u32,

    /// Number of zoom levels (default: auto-calculated, only used with --tiled)
    #[arg(long)]
    pub zoom_levels: Option<u8>,
}

#[derive(Debug, Clone, ValueEnum)]
pub enum CaptureMode {
    /// Select a region with crosshairs
    Region,
    /// Capture full screen
    Screen,
    /// Capture a specific window
    Window,
}

#[derive(Parser, Debug)]
pub struct FeedbackArgs {
    /// Image or .nib file to get feedback on
    pub file: PathBuf,

    /// Question to display in the selected review surface
    #[arg(short = 'm', long)]
    pub message: Option<String>,

    /// Annotations JSON array (visual prompts from Claude)
    #[arg(short = 'a', long)]
    pub annotations: Option<String>,

    /// Timeout in seconds (0 = no timeout)
    #[arg(short = 't', long, default_value = "0")]
    pub timeout: u64,

    /// Human review surface
    #[arg(long, value_enum, default_value = "native")]
    pub ui: FeedbackUi,

    /// Explicitly publish without waiting; only use when the caller requests it
    #[arg(long)]
    pub detach: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum FeedbackUi {
    #[value(name = "native", alias = "gui")]
    Native,
    Terminal,
    Web,
    Auto,
}

#[derive(Parser, Debug)]
pub struct ReviewArgs {
    /// .nib file backing the deterministic collaboration session
    pub session: PathBuf,

    /// Review request shown above the decision controls
    #[arg(short = 'm', long)]
    pub message: Option<String>,
}

#[derive(Parser, Debug)]
pub struct RequestCreateArgs {
    /// Image, .nib, or MP4/H.264 file to review
    pub file: PathBuf,

    /// Question shown to the reviewer
    #[arg(short = 'm', long)]
    pub question: Option<String>,

    /// Image-only annotation prompt JSON
    #[arg(short = 'a', long)]
    pub annotations: Option<String>,
}

#[derive(Parser, Debug)]
pub struct RequestWaitArgs {
    /// Durable request ID printed when feedback publishes
    pub request_id: String,

    /// Timeout in seconds (0 = no timeout)
    #[arg(short = 't', long, default_value = "0")]
    pub timeout: u64,
}

#[derive(Parser, Debug)]
pub struct RequestReviewArgs {
    /// Durable request ID
    pub request_id: String,

    /// Portal base URL; defaults to NIB_PORTAL_URL or the configured portal
    #[arg(long)]
    pub portal: Option<String>,
}

#[derive(Parser, Debug, Clone)]
pub struct RecordStartArgs {
    /// Output MP4 path
    #[arg(short, long)]
    pub output: Option<PathBuf>,

    /// Stop automatically after this many seconds
    #[arg(short = 't', long)]
    pub duration: Option<u64>,

    /// Record a display number (1 is the primary display)
    #[arg(long)]
    pub display: Option<u32>,

    /// Record a CoreGraphics window ID
    #[arg(long)]
    pub window: Option<u32>,

    /// Record x,y,width,height
    #[arg(long)]
    pub region: Option<String>,

    /// Let the user select a window or region
    #[arg(short, long)]
    pub interactive: bool,

    /// Include system audio
    #[arg(long)]
    pub system_audio: bool,

    /// Include the default microphone
    #[arg(long)]
    pub microphone: bool,

    /// Hide the cursor
    #[arg(long)]
    pub no_cursor: bool,

    /// Show pointer clicks
    #[arg(long)]
    pub show_clicks: bool,
}

#[derive(Parser, Debug, Clone)]
pub struct RecordStatusArgs {
    /// Recording ID; defaults to the active recording
    pub id: Option<String>,
}

#[derive(Parser, Debug, Clone)]
pub struct RecordStopArgs {
    /// Recording ID; defaults to the active recording
    pub id: Option<String>,
}

#[derive(Parser, Debug, Clone)]
pub struct RecordWaitArgs {
    /// Recording ID
    pub id: String,

    /// Timeout in seconds (0 = no timeout)
    #[arg(short = 't', long, default_value = "0")]
    pub timeout: u64,
}

#[derive(Parser, Debug, Clone)]
pub struct MediaInspectArgs {
    /// MP4 media file
    pub file: PathBuf,
}

#[derive(Parser, Debug, Clone)]
pub struct MediaPosterArgs {
    /// MP4 media file
    pub file: PathBuf,

    /// Output PNG path
    #[arg(short, long)]
    pub output: Option<PathBuf>,
}

#[derive(Parser, Debug, Clone)]
pub struct MediaTranscribeArgs {
    /// MP4 media file
    pub file: PathBuf,

    /// BCP-47 locale hint
    #[arg(long)]
    pub locale: Option<String>,
}

#[derive(Parser, Debug)]
pub struct AwaitSubmitArgs {
    /// .nib file to watch for annotation changes
    pub file: PathBuf,

    /// Stream events continuously instead of exiting after first event
    #[arg(long)]
    pub stream: bool,

    /// Timeout in seconds (0 = no timeout, default: 30)
    #[arg(short = 't', long, default_value = "30")]
    pub timeout: u64,

    /// Output changes as JSON instead of formatted text
    #[arg(long)]
    pub json: bool,

    /// Poll interval in milliseconds
    #[arg(long, default_value = "100")]
    pub interval: u64,

    /// Wait for a terminal/GUI feedback decision instead of annotation changes
    #[arg(long)]
    pub feedback: bool,
}

#[derive(Parser, Debug)]
pub struct AnnotationAddArgs {
    /// Image file to annotate
    pub file: PathBuf,

    /// Annotation type (rectangle, arrow, highlight, text, number, line, ellipse, blur)
    #[arg(short = 't', long, default_value = "rectangle")]
    pub annotation_type: String,

    /// X coordinate
    #[arg(short = 'x', long)]
    pub x: f64,

    /// Y coordinate
    #[arg(short = 'y', long)]
    pub y: f64,

    /// Width (for shapes)
    #[arg(short = 'w', long, default_value = "100")]
    pub width: f64,

    /// Height (for shapes)
    #[arg(short = 'H', long, default_value = "50")]
    pub height: f64,

    /// Color in hex format
    #[arg(short = 'c', long, default_value = "#ff0000")]
    pub color: String,

    /// Text content (for text annotations)
    #[arg(long)]
    pub text: Option<String>,

    /// Number value (for number annotations)
    #[arg(long)]
    pub value: Option<u32>,

    /// Message to display as toast in GUI (for Claude->human communication)
    #[arg(short = 'm', long)]
    pub message: Option<String>,
}

#[derive(Parser, Debug)]
pub struct AnnotationRemoveArgs {
    /// Image file containing the annotation
    pub file: PathBuf,

    /// Annotation ID to remove (e.g., "a1", "a2")
    pub id: String,
}

#[derive(Parser, Debug)]
pub struct AnnotationClearArgs {
    /// Image file to clear annotations from
    pub file: PathBuf,
}

#[derive(Parser, Debug)]
pub struct AnnotationListArgs {
    /// Image file to read annotations for
    pub file: PathBuf,

    /// Output as raw JSON instead of formatted text
    #[arg(long)]
    pub json: bool,

    /// Only show annotations modified after this Unix timestamp
    #[arg(long)]
    pub since: Option<i64>,
}

#[derive(Parser, Debug)]
pub struct RenderArgs {
    /// Image file to render with annotations
    pub file: PathBuf,

    /// Output file (default: {file}.rendered.png)
    #[arg(short, long)]
    pub output: Option<PathBuf>,
}

#[derive(Parser, Debug)]
pub struct ImportArgs {
    /// Image file to import (PNG, JPEG, WebP)
    pub file: PathBuf,

    /// Output .nib file path (default: same name with .nib extension)
    #[arg(short, long)]
    pub output: Option<PathBuf>,

    /// Migrate from JSON sidecar format (deletes sidecar after migration)
    #[arg(long)]
    pub migrate_sidecar: bool,

    /// Delete sidecar JSON files after successful migration
    #[arg(long)]
    pub delete_sidecar: bool,

    /// Migrate recursively (for directories)
    #[arg(short, long)]
    pub recursive: bool,
}

#[derive(Parser, Debug)]
pub struct ExportArgs {
    /// .nib file to export
    pub file: PathBuf,

    /// Output file path (default: same name with .png extension)
    #[arg(short, long)]
    pub output: Option<PathBuf>,

    /// Export format: "rendered" (baked), "json" (PNG + sidecar), "qml" (PNG + embedded QML)
    #[arg(short = 'F', long = "export-format", default_value = "rendered")]
    pub export_format: ExportFormat,
}

#[derive(Debug, Clone, ValueEnum)]
pub enum ExportFormat {
    /// Render annotations directly onto the image
    Rendered,
    /// Export PNG + JSON sidecar file
    Json,
    /// Export PNG with embedded QML tEXt chunk
    Qml,
}

#[derive(Parser, Debug)]
pub struct GenerateArgs {
    /// Text prompt describing the desired image
    pub prompt: String,

    /// Image width in pixels
    #[arg(long)]
    pub width: u32,

    /// Image height in pixels
    #[arg(long)]
    pub height: u32,

    /// Output PNG path (default: timestamped file in the nib captures directory)
    #[arg(short, long)]
    pub out: Option<PathBuf>,

    /// Reference image path (repeatable)
    #[arg(long = "ref")]
    pub reference: Vec<PathBuf>,

    /// Crop output to exact requested dimensions
    #[arg(long)]
    pub crop: bool,

    /// Timeout passed through to the generator (e.g. "12m")
    #[arg(long)]
    pub timeout: Option<String>,

    /// Also import the generated PNG into a .nib file
    #[arg(long)]
    pub nib: bool,

    /// After generation, run the feedback flow on the result
    #[arg(long)]
    pub feedback: bool,

    /// Message to show in the feedback GUI (question for the human, used with --feedback)
    #[arg(short = 'm', long)]
    pub message: Option<String>,

    /// Human review surface used with --feedback
    #[arg(long, value_enum, default_value = "native")]
    pub feedback_ui: FeedbackUi,
}

#[derive(Parser, Debug)]
pub struct JudgeArgs {
    /// Expected/reference image path
    pub expected: PathBuf,

    /// Actual/generated image path
    pub actual: PathBuf,

    /// Timeout passed through to the judge tool (e.g. "10m")
    #[arg(long)]
    pub timeout: Option<String>,

    /// Open the comparison in a viewer
    #[arg(long)]
    pub open: bool,
}

#[derive(Parser, Debug)]
pub struct GridArgs {
    /// Image file to overlay grid on (PNG or .tiles/ directory)
    pub file: PathBuf,

    /// Grid line spacing in pixels
    #[arg(short = 's', long, default_value = "100")]
    pub spacing: u32,

    /// Region to focus on (format: "x1,y1,x2,y2")
    #[arg(short = 'r', long)]
    pub region: Option<String>,

    /// Output file (default: {file}.grid.png or stdout for --json)
    #[arg(short = 'o', long)]
    pub output: Option<PathBuf>,

    /// Grid line color in hex format (default: semi-transparent gray)
    #[arg(short = 'c', long, default_value = "#80808080")]
    pub color: String,

    /// Major line color in hex format (default: semi-transparent red)
    #[arg(long, default_value = "#ff0000a0")]
    pub major_color: String,

    /// Interval for major lines with labels (every N lines)
    #[arg(long, default_value = "5")]
    pub major_interval: u32,

    /// Output grid metadata as JSON instead of rendering image
    #[arg(long)]
    pub json: bool,
}

#[derive(Parser, Debug)]
pub struct FindTextArgs {
    /// Image file to search for text
    pub file: PathBuf,

    /// Search for specific text (case-insensitive substring match)
    #[arg(short, long)]
    pub search: Option<String>,

    /// Output as JSON for easy parsing
    #[arg(long)]
    pub json: bool,

    /// Minimum confidence level (0-100, default: 60)
    #[arg(short, long, default_value = "60")]
    pub confidence: i32,

    /// Automatically add highlight annotation for found text
    #[arg(long)]
    pub highlight: bool,

    /// Color for highlight annotation (hex format)
    #[arg(long, default_value = "#ffff00")]
    pub color: String,

    /// Limit search to a specific region (format: "x,y,width,height")
    #[arg(short, long)]
    pub region: Option<String>,
}

#[derive(Parser, Debug)]
pub struct PickColorArgs {
    /// Image file to pick color from
    pub file: PathBuf,

    /// X coordinate
    #[arg(short = 'x', long)]
    pub x: u32,

    /// Y coordinate
    #[arg(short = 'y', long)]
    pub y: u32,

    /// Sample radius for averaging (0 = single pixel, default: 0)
    #[arg(short = 'r', long, default_value = "0")]
    pub radius: u32,

    /// Output as JSON for easy parsing
    #[arg(long)]
    pub json: bool,
}

#[derive(Parser, Debug)]
pub struct InfoArgs {
    /// The .nib file to inspect
    pub file: PathBuf,

    /// Output as JSON instead of formatted text
    #[arg(long)]
    pub json: bool,
}

#[derive(Parser, Debug)]
pub struct TileQueryArgs {
    /// Tiled capture directory (containing manifest.json)
    pub capture_dir: PathBuf,

    /// Query by point coordinates (format: "x,y")
    #[arg(long)]
    pub point: Option<String>,

    /// Query by region (format: "x,y,width,height")
    #[arg(long)]
    pub region: Option<String>,

    /// Zoom level for query (default: max resolution)
    #[arg(long)]
    pub zoom: Option<u8>,

    /// Include OCR data in response (if available)
    #[arg(long)]
    pub include_ocr: bool,
}

#[derive(Parser, Debug)]
pub struct TileExtractArgs {
    /// Tiled capture directory (containing manifest.json)
    pub capture_dir: PathBuf,

    /// Region to extract (format: "x,y,width,height")
    #[arg(short, long)]
    pub region: String,

    /// Output file path
    #[arg(short, long)]
    pub output: PathBuf,

    /// Scale factor (default: 1.0 = full resolution)
    #[arg(long, default_value = "1.0")]
    pub scale: f64,
}

#[derive(Parser, Debug)]
pub struct TileListArgs {
    /// Tiled capture directory (containing manifest.json)
    pub capture_dir: PathBuf,

    /// Zoom level to list (default: max resolution)
    #[arg(long)]
    pub zoom: Option<u8>,

    /// Show detailed bounds for each tile
    #[arg(short, long)]
    pub verbose: bool,
}

#[derive(Parser, Debug)]
pub struct ValidateArgs {
    /// Image file or QML file to validate
    pub file: PathBuf,

    /// Treat input as raw QML text file
    #[arg(long)]
    pub qml_file: bool,
}

#[derive(Parser, Debug)]
pub struct ListArgs {
    /// Maximum number of items to show
    #[arg(short = 'n', long, default_value = "10")]
    pub limit: usize,

    /// Sort order
    #[arg(short, long, default_value = "date")]
    pub sort: SortOrder,
}

#[derive(Debug, Clone, ValueEnum)]
pub enum SortOrder {
    Date,
    Name,
    Size,
}

#[derive(Parser, Debug)]
pub struct WindowsArgs {
    /// Filter by app name (case-insensitive substring match)
    #[arg(short, long)]
    pub app: Option<String>,

    /// Output as JSON for easy parsing
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Clone, ValueEnum)]
pub enum OutputFormat {
    Text,
    Json,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feedback_defaults_to_native_attached_review() {
        let cli = Cli::try_parse_from(["nib", "feedback", "review.png"]).unwrap();
        let Command::Feedback(args) = cli.command else {
            panic!("expected feedback command");
        };
        assert_eq!(args.ui, FeedbackUi::Native);
        assert_eq!(args.timeout, 0);
        assert!(!args.detach, "feedback must wait unless detach is explicit");
    }

    #[test]
    fn request_wait_defaults_to_no_timeout() {
        let cli = Cli::try_parse_from(["nib", "request", "wait", "req-123"]).unwrap();
        let Command::Request(RequestCommand::Wait(args)) = cli.command else {
            panic!("expected request wait command");
        };
        assert_eq!(args.request_id, "req-123");
        assert_eq!(args.timeout, 0);
    }

    #[test]
    fn request_review_accepts_an_explicit_portal() {
        let cli = Cli::try_parse_from([
            "nib",
            "request",
            "review",
            "req-123",
            "--portal",
            "https://nib.example",
        ])
        .unwrap();
        let Command::Request(RequestCommand::Review(args)) = cli.command else {
            panic!("expected request review command");
        };
        assert_eq!(args.request_id, "req-123");
        assert_eq!(args.portal.as_deref(), Some("https://nib.example"));
    }
}
