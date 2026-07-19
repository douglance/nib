//! Nib CLI entry point

use clap::Parser;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use nib::cli::{self, AnnotationCommand, Cli, Command, TileCommand};
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
    let is_mcp_server = matches!(&cli.command, Command::McpServer(_));

    // Feedback, AwaitSubmit, Generate, and Judge need quiet logging: their
    // stdout is a JSON contract consumed by scripts/agents and must not be
    // interleaved with log lines.
    let is_quiet_mode = matches!(
        &cli.command,
        Command::Feedback(_)
            | Command::AwaitSubmit(_)
            | Command::Generate(_)
            | Command::Judge(_)
            | Command::Sessions
    );

    if is_mcp_server || is_quiet_mode {
        // MCP server and quiet modes: log to stderr only, no ANSI colors
        tracing_subscriber::registry()
            .with(tracing_subscriber::EnvFilter::new("warn"))
            .with(
                tracing_subscriber::fmt::layer()
                    .with_target(false)
                    .with_ansi(false)
                    .with_writer(std::io::stderr),
            )
            .init();
    } else {
        // Normal CLI: log to stdout with colors
        let filter = if cli.verbose { "nib=debug" } else { "nib=info" };

        tracing_subscriber::registry()
            .with(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| filter.into()),
            )
            .with(tracing_subscriber::fmt::layer().with_target(false))
            .init();
    }

    // Initialize storage (skip for MCP server to avoid any stdout output)
    if !is_mcp_server {
        storage::init_storage()?;
    }

    // Dispatch command
    match cli.command {
        // Human interface
        #[cfg(feature = "gui")]
        Command::Gui(args) => cli::run_gui(&args),
        #[cfg(not(feature = "gui"))]
        Command::Gui(_) => {
            eprintln!("Error: GUI feature not enabled. Rebuild with --features gui");
            std::process::exit(1);
        }

        // Claude actions
        Command::Capture(args) => cli::run_capture(&args),
        Command::Feedback(args) => cli::run_feedback(&args).await,
        Command::Review(args) => cli::run_review(&args).await,
        Command::AwaitSubmit(args) => cli::run_await_submit(&args).await,
        Command::Annotation(subcmd) => match subcmd {
            AnnotationCommand::Add(args) => cli::run_annotation_add(&args),
            AnnotationCommand::Remove(args) => cli::run_annotation_remove(&args),
            AnnotationCommand::Clear(args) => cli::run_annotation_clear(&args),
            AnnotationCommand::List(args) => cli::run_annotation_list(&args),
        },
        Command::Render(args) => cli::run_render(&args),
        Command::Import(args) => cli::run_import(&args),
        Command::Export(args) => cli::run_export(&args),
        Command::Generate(args) => cli::run_generate(&args, &cli.format).await,
        Command::Judge(args) => cli::run_judge(&args, &cli.format),

        // Claude inspection
        Command::Grid(args) => cli::run_grid(&args),
        #[cfg(feature = "ocr")]
        Command::FindText(args) => cli::run_find_text(&args),
        #[cfg(not(feature = "ocr"))]
        Command::FindText(_) => {
            eprintln!("Error: OCR feature not enabled. Rebuild with --features ocr");
            std::process::exit(1);
        }
        Command::PickColor(args) => cli::run_pick_color(&args),
        Command::Windows(args) => cli::run_windows(&args),
        Command::Info(args) => cli::run_info(&args),
        Command::Tile(subcmd) => match subcmd {
            TileCommand::Query(args) => cli::run_tile_query(&args, &cli.format),
            TileCommand::Extract(args) => cli::run_tile_extract(&args),
            TileCommand::List(args) => cli::run_tile_list(&args, &cli.format),
        },

        // Utilities
        Command::Validate(args) => cli::run_validate(&args),
        Command::List(args) => cli::run_list(&args),
        Command::Sessions => cli::run_sessions(&cli.format),
        #[cfg(feature = "mcp")]
        Command::McpServer(args) => cli::run_mcp_server(&args).await,
        #[cfg(not(feature = "mcp"))]
        Command::McpServer(_) => {
            eprintln!("Error: MCP feature not enabled. Rebuild with --features mcp");
            std::process::exit(1);
        }
    }
}
