//! Nib CLI entry point

use clap::Parser;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use nib::cli::{self, Cli, Command};
use nib::core::Result;
use nib::storage;

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let cli = Cli::parse();

    // For MCP server, skip logging initialization (stdout must be pure JSON-RPC)
    // and redirect any logs to stderr
    let is_mcp_server = matches!(&cli.command, Some(Command::McpServer(_)));

    // Default mode (nib <file>) also needs quiet logging
    let is_default_mode = cli.command.is_none() && cli.file.is_some();

    // Feedback mode also needs quiet logging (JSON output)
    let is_feedback_mode = matches!(&cli.command, Some(Command::Feedback(_)));

    if is_mcp_server || is_default_mode || is_feedback_mode {
        // MCP server and default mode: log to stderr only, no ANSI colors
        tracing_subscriber::registry()
            .with(tracing_subscriber::EnvFilter::new("warn"))
            .with(tracing_subscriber::fmt::layer()
                .with_target(false)
                .with_ansi(false)
                .with_writer(std::io::stderr))
            .init();
    } else {
        // Normal CLI: log to stdout with colors
        let filter = if cli.verbose {
            "nib=debug"
        } else {
            "nib=info"
        };

        tracing_subscriber::registry()
            .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| filter.into()))
            .with(tracing_subscriber::fmt::layer().with_target(false))
            .init();
    }

    // Initialize storage (skip for MCP server to avoid any stdout output)
    if !is_mcp_server && !is_default_mode {
        storage::init_storage()?;
    }

    // Handle default mode: nib <file> → watch for changes
    if is_default_mode {
        return cli::run_default_watch(&cli.file.unwrap(), cli.timeout).await;
    }

    // Dispatch command
    match cli.command {
        Some(Command::Capture(args)) => cli::run_capture(&args),
        Some(Command::Annotate(args)) => cli::run_annotate(&args),
        Some(Command::Edit(args)) => cli::run_edit(&args).await,
        Some(Command::Read(args)) => cli::run_read(&args),
        Some(Command::Validate(args)) => cli::run_validate(&args),
        Some(Command::List(args)) => cli::run_list(&args),
        Some(Command::Sessions) => cli::run_sessions(),
        Some(Command::Folder) => cli::run_folder(),
        #[cfg(feature = "gui")]
        Some(Command::Gui(args)) => cli::run_gui(&args),
        #[cfg(not(feature = "gui"))]
        Some(Command::Gui(_)) => {
            eprintln!("Error: GUI feature not enabled. Rebuild with --features gui");
            std::process::exit(1);
        }
        Some(Command::Annotations(args)) => cli::run_annotations(&args),
        Some(Command::AddAnnotation(args)) => cli::run_add_annotation(&args),
        #[cfg(feature = "ocr")]
        Some(Command::FindText(args)) => cli::run_find_text(&args),
        #[cfg(not(feature = "ocr"))]
        Some(Command::FindText(_)) => {
            eprintln!("Error: OCR feature not enabled. Rebuild with --features ocr");
            std::process::exit(1);
        }
        Some(Command::Render(args)) => cli::run_render(&args),
        Some(Command::RemoveAnnotation(args)) => cli::run_remove_annotation(&args),
        Some(Command::ClearAnnotations(args)) => cli::run_clear_annotations(&args),
        Some(Command::Grid(args)) => cli::run_grid(&args),
        Some(Command::Info(args)) => cli::run_info(&args),
        #[cfg(feature = "gui")]
        Some(Command::Open(args)) => cli::run_open(&args),
        #[cfg(not(feature = "gui"))]
        Some(Command::Open(_)) => {
            eprintln!("Error: GUI feature not enabled. Rebuild with --features gui");
            std::process::exit(1);
        }
        Some(Command::Import(args)) => cli::run_import(&args),
        Some(Command::Watch(args)) => cli::run_watch(&args).await,
        Some(Command::Migrate(args)) => cli::run_migrate(&args),
        Some(Command::Export(args)) => cli::run_export(&args),
        Some(Command::Query(args)) => cli::run_query(&args, &cli.format),
        Some(Command::Extract(args)) => cli::run_extract(&args),
        Some(Command::Tiles(args)) => cli::run_tiles(&args, &cli.format),
        #[cfg(feature = "mcp")]
        Some(Command::McpServer(args)) => cli::run_mcp_server(&args).await,
        #[cfg(not(feature = "mcp"))]
        Some(Command::McpServer(_)) => {
            eprintln!("Error: MCP feature not enabled. Rebuild with --features mcp");
            std::process::exit(1);
        }
        Some(Command::Feedback(args)) => cli::run_feedback(&args).await,
        None => {
            eprintln!("Error: No file or command specified. Use --help for usage.");
            std::process::exit(1);
        }
    }
}
