//! CLI argument definitions using clap

use clap::{Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

/// Quill - Fast, native screenshot annotation tool
#[derive(Parser, Debug)]
#[command(name = "quill")]
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

    /// Open the Quill storage folder
    Folder,

    /// Launch the GUI editor
    Gui(GuiArgs),
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
