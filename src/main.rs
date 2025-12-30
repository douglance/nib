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
    let t0 = std::time::Instant::now();
    let cli = Cli::parse();
    eprintln!("[PERF] cli parse: {:?}", t0.elapsed());

    // Initialize logging
    let filter = if cli.verbose {
        "nib=debug"
    } else {
        "nib=info"
    };

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| filter.into()))
        .with(tracing_subscriber::fmt::layer().with_target(false))
        .init();

    // Initialize storage
    storage::init_storage()?;
    eprintln!("[PERF] storage init: {:?}", t0.elapsed());

    // Dispatch command
    eprintln!("[PERF] dispatch command: {:?}", t0.elapsed());
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
    }
}
