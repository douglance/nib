//! Quill CLI entry point

use clap::Parser;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use quill::cli::{self, Cli, Command};
use quill::core::Result;
use quill::storage;

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let cli = Cli::parse();

    // Initialize logging
    let filter = if cli.verbose {
        "quill=debug"
    } else {
        "quill=info"
    };

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| filter.into()))
        .with(tracing_subscriber::fmt::layer().with_target(false))
        .init();

    // Initialize storage
    storage::init_storage()?;

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
    }
}
