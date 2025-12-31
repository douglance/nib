//! CLI argument definitions using clap

use clap::{Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

/// Nib - Fast, native screenshot annotation tool
///
/// When called with just a file path (no subcommand), nib will:
/// - Create a .nib file from an image if needed
/// - Start watching for annotation changes (blocking mode)
/// - Exit after first event, outputting JSON
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

    /// File to watch (image or .nib). If omitted, a subcommand is required.
    /// Images (.png, .jpg, .webp) will be converted to .nib first.
    #[arg(value_name = "FILE")]
    pub file: Option<PathBuf>,

    /// Timeout in seconds for watching (default: 30, 0 = no timeout)
    #[arg(short = 't', long, default_value = "30")]
    pub timeout: u64,

    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Capture a screen region
    Capture(CaptureArgs),

    /// Open annotator or add annotations headlessly
    Annotate(AnnotateArgs),

    /// Open collaborative editing session (CLI and GUI can edit same image)
    Edit(EditArgs),

    /// Extract and display QML from an image
    Read(ReadArgs),

    /// Validate QML syntax in an image
    Validate(ValidateArgs),

    /// List recent captures
    List(ListArgs),

    /// List active collaboration sessions
    Sessions,

    /// Open the Nib storage folder
    Folder,

    /// Launch the GUI editor
    Gui(GuiArgs),

    /// Read annotations from a sidecar JSON file
    Annotations(AnnotationsArgs),

    /// Add an annotation to an image
    AddAnnotation(AddAnnotationArgs),

    /// Find text in an image using OCR and get precise coordinates
    FindText(FindTextArgs),

    /// Render annotations onto image and output to file (for Claude to view)
    Render(RenderArgs),

    /// Remove a specific annotation by ID
    RemoveAnnotation(RemoveAnnotationArgs),

    /// Clear all annotations from an image
    ClearAnnotations(ClearAnnotationsArgs),

    /// Overlay a coordinate grid on an image for precise positioning
    Grid(GridArgs),

    /// Show comprehensive info about a .nib file
    Info(InfoArgs),

    /// Import an image, create .nib file, and open in GUI
    Open(OpenArgs),

    /// Create .nib file from image without opening GUI
    Import(ImportArgs),

    /// Watch a .nib file for annotation changes in real-time
    Watch(WatchArgs),

    /// Migrate from JSON sidecar format to .nib SQLite format
    Migrate(MigrateArgs),

    /// Export .nib file to PNG (with annotations baked, as sidecar JSON, or as QML)
    Export(ExportArgs),

    /// Query a tiled capture for point or region information
    Query(QueryArgs),

    /// Extract a region from a tiled capture at full resolution
    Extract(ExtractArgs),

    /// List tiles in a tiled capture at a specific zoom level
    Tiles(TilesArgs),

    /// Start MCP server for Claude Code integration
    McpServer(McpServerArgs),

    /// Wait for human annotation feedback, spawn GUI, then render and exit
    Feedback(FeedbackArgs),
}

#[derive(Parser, Debug)]
pub struct McpServerArgs {
    /// Optional image file to work with
    pub image: Option<PathBuf>,
}

#[derive(Parser, Debug)]
pub struct FeedbackArgs {
    /// Image or .nib file to get feedback on
    pub file: PathBuf,

    /// Timeout in seconds (default: 60, 0 = no timeout)
    #[arg(short = 't', long, default_value = "60")]
    pub timeout: u64,

    /// Don't auto-open GUI (use when GUI is already open)
    #[arg(long)]
    pub no_gui: bool,

    /// Don't auto-render after annotation detected
    #[arg(long)]
    pub no_render: bool,
}

#[derive(Parser, Debug)]
pub struct AnnotationsArgs {
    /// Image file to read annotations for (reads from {file}.annotations.json)
    pub file: PathBuf,

    /// Output as raw JSON instead of formatted text
    #[arg(long)]
    pub json: bool,

    /// Only show annotations modified after this Unix timestamp
    #[arg(long)]
    pub since: Option<i64>,
}

#[derive(Parser, Debug)]
pub struct GuiArgs {
    /// Optional image file to open in the editor
    pub file: Option<PathBuf>,
}

#[derive(Debug, Clone, ValueEnum)]
pub enum OutputFormat {
    Text,
    Json,
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
pub struct AnnotateArgs {
    /// Image file to annotate
    #[arg(required_unless_present = "clipboard")]
    pub file: Option<PathBuf>,

    /// Read image from clipboard
    #[arg(long, conflicts_with = "file")]
    pub clipboard: bool,

    /// Export immediately without opening GUI
    #[arg(long)]
    pub export_only: bool,

    /// Add annotations via QML string (for headless mode)
    #[arg(long)]
    pub add: Option<String>,

    /// Add annotations from QML file
    #[arg(long)]
    pub qml_file: Option<PathBuf>,

    /// Output file for export
    #[arg(short, long)]
    pub output: Option<PathBuf>,
}

#[derive(Parser, Debug)]
pub struct EditArgs {
    /// Image file to edit collaboratively
    pub file: PathBuf,

    /// Add annotations via QML string
    #[arg(long)]
    pub add: Option<String>,

    /// Add annotations from QML file
    #[arg(long)]
    pub qml_file: Option<PathBuf>,

    /// Watch for changes from other clients (GUI)
    #[arg(long)]
    pub watch: bool,

    /// Output file to save when done (or saves to original)
    #[arg(short, long)]
    pub output: Option<PathBuf>,
}

#[derive(Parser, Debug)]
pub struct ReadArgs {
    /// Image file to read QML from
    pub file: PathBuf,

    /// Output raw QML without formatting
    #[arg(long)]
    pub raw: bool,
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
pub struct AddAnnotationArgs {
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
pub struct RenderArgs {
    /// Image file to render with annotations
    pub file: PathBuf,

    /// Output file (default: {file}.rendered.png)
    #[arg(short, long)]
    pub output: Option<PathBuf>,
}

#[derive(Parser, Debug)]
pub struct RemoveAnnotationArgs {
    /// Image file containing the annotation
    pub file: PathBuf,

    /// Annotation ID to remove (e.g., "a1", "a2")
    pub id: String,
}

#[derive(Parser, Debug)]
pub struct ClearAnnotationsArgs {
    /// Image file to clear annotations from
    pub file: PathBuf,
}

#[derive(Parser, Debug)]
pub struct GridArgs {
    /// Image file to overlay grid on (PNG or .tiles/ directory)
    pub file: PathBuf,

    /// Grid line spacing in pixels
    #[arg(short = 's', long, default_value = "100")]
    pub spacing: u32,

    /// Region to focus on (format: "x1,y1,x2,y2")
    /// If specified, outputs a cropped view of just that region with the grid
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
pub struct InfoArgs {
    /// The .nib file to inspect
    pub file: PathBuf,

    /// Output as JSON instead of formatted text
    #[arg(long)]
    pub json: bool,
}

#[derive(Parser, Debug)]
pub struct OpenArgs {
    /// Image file to import (PNG, JPEG, WebP)
    pub file: PathBuf,

    /// Output .nib file path (default: same name with .nib extension)
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
}

#[derive(Parser, Debug)]
pub struct WatchArgs {
    /// .nib file to watch for annotation changes
    pub file: PathBuf,

    /// Output changes as JSON instead of formatted text
    #[arg(long)]
    pub json: bool,

    /// Poll interval in milliseconds
    #[arg(long, default_value = "100")]
    pub interval: u64,

    /// Stream events continuously instead of exiting after first event
    #[arg(long)]
    pub stream: bool,

    /// Timeout in seconds (0 = no timeout, default: 30)
    #[arg(long, default_value = "30")]
    pub timeout: u64,
}

#[derive(Parser, Debug)]
pub struct MigrateArgs {
    /// Image file or directory to migrate
    pub path: PathBuf,

    /// Output .nib file (for single file migration)
    #[arg(short, long)]
    pub output: Option<PathBuf>,

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
pub struct QueryArgs {
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
pub struct ExtractArgs {
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
pub struct TilesArgs {
    /// Tiled capture directory (containing manifest.json)
    pub capture_dir: PathBuf,

    /// Zoom level to list (default: max resolution)
    #[arg(long)]
    pub zoom: Option<u8>,

    /// Show detailed bounds for each tile
    #[arg(short, long)]
    pub verbose: bool,
}
