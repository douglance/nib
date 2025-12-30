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
    let is_mcp_server = matches!(&cli.command, Command::McpServer(_));

    if is_mcp_server {
        // MCP server: log to stderr only, no ANSI colors
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
    if !is_mcp_server {
        storage::init_storage()?;
    }

    // Dispatch command
    match &cli.command {
        Command::Capture(args) => cli::run_capture(args),
        Command::Annotate(args) => cli::run_annotate(args),
        Command::Edit(args) => cli::run_edit(args).await,
        Command::Read(args) => cli::run_read(args),
        Command::Validate(args) => cli::run_validate(args),
        Command::List(args) => cli::run_list(args),
        Command::Sessions => cli::run_sessions(),
        Command::Folder => cli::run_folder(),
        Command::Gui(args) => cli::run_gui(args),
        Command::Annotations(args) => cli::run_annotations(args),
        Command::AddAnnotation(args) => cli::run_add_annotation(args),
        Command::FindText(args) => cli::run_find_text(args),
        Command::Render(args) => cli::run_render(args),
        Command::RemoveAnnotation(args) => cli::run_remove_annotation(args),
        Command::ClearAnnotations(args) => cli::run_clear_annotations(args),
        Command::Grid(args) => cli::run_grid(args),
        Command::Info(args) => cli::run_info(args),
        Command::Open(args) => cli::run_open(args),
        Command::Import(args) => cli::run_import(args),
        Command::Watch(args) => cli::run_watch(args).await,
        Command::Migrate(args) => cli::run_migrate(args),
        Command::Export(args) => cli::run_export(args),
        Command::Query(args) => cli::run_query(args, &cli.format),
        Command::Extract(args) => cli::run_extract(args),
        Command::Tiles(args) => cli::run_tiles(args, &cli.format),
        Command::McpServer(args) => cli::run_mcp_server(args).await,
    }
}
