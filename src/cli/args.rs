//! CLI argument definitions using clap

use clap::{Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

/// Nib - Fast, native screenshot annotation tool
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
}

#[derive(Parser, Debug)]
pub struct AnnotationsArgs {
    /// Image file to read annotations for (reads from {file}.annotations.json)
    pub file: PathBuf,

    /// Output as raw JSON instead of formatted text
    #[arg(long)]
    pub json: bool,
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
