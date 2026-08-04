//! Nib CLI entry point.

use clap::Parser;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use nib::cli::{
    self, AnnotationCommand, Command, MediaCommand, RecordCommand, RequestCommand, TileCommand,
};
use nib::core::Result;
use nib::storage;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("Error: {error}");
        std::process::exit(1);
    }
}

async fn run() -> std::result::Result<(), Box<dyn std::error::Error>> {
    if std::env::var_os("NIB_CLAP_COMPAT").is_some() {
        return run_compat().await.map_err(Into::into);
    }

    let argv = std::env::args().skip(1).collect::<Vec<_>>();

    // Incurs owns `--mcp` and serves the whole command catalog over MCP. The
    // only thing left to do here is keep the log level down, because the stdio
    // transport shares this process.
    let serving_mcp = argv.iter().any(|argument| argument == "--mcp");
    if serving_mcp && argv.len() != 1 {
        return Err("`--mcp` cannot be combined with a Nib command".into());
    }

    let verbosity = argv.iter().fold(0usize, |count, argument| {
        if argument == "--verbose" {
            count + 1
        } else if argument.starts_with('-')
            && argument.len() > 1
            && argument[1..].chars().all(|character| character == 'v')
        {
            count + argument.len() - 1
        } else {
            count
        }
    });
    init_logging(verbosity, serving_mcp);

    if !is_side_effect_free_builtin(&argv) {
        storage::init_storage()?;
    }

    cli::build_cli().serve().await
}

fn init_logging(verbosity: usize, mcp: bool) {
    let filter = if mcp {
        "warn"
    } else {
        match verbosity {
            0 => "nib=info",
            1 => "nib=debug",
            _ => "nib=trace",
        }
    };
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| filter.into()),
        )
        .with(
            tracing_subscriber::fmt::layer()
                .with_target(false)
                .with_ansi(false)
                .with_writer(std::io::stderr),
        )
        .init();
}

fn is_side_effect_free_builtin(argv: &[String]) -> bool {
    argv.is_empty()
        || argv.iter().any(|argument| {
            matches!(
                argument.as_str(),
                "--help"
                    | "-h"
                    | "--version"
                    | "--llms"
                    | "--llms-full"
                    | "--schema"
                    | "--config-schema"
            )
        })
        || matches!(
            argv.first().map(String::as_str),
            Some("completions" | "skills" | "mcp")
        )
}

/// Compatibility execution for command implementations that still accept the
/// former clap argument structs. This is private to the Incurs handlers and is
/// never the public parser or discovery surface.
async fn run_compat() -> Result<()> {
    let cli = cli::Cli::parse();
    let quiet = matches!(
        &cli.command,
        Command::Feedback(_)
            | Command::Request(_)
            | Command::Record(_)
            | Command::Media(_)
            | Command::AwaitSubmit(_)
            | Command::Generate(_)
            | Command::Judge(_)
            | Command::Sessions
    );
    init_logging(usize::from(cli.verbose), quiet);
    storage::init_storage()?;

    match cli.command {
        #[cfg(feature = "gui")]
        Command::Gui(args) => cli::run_gui(&args),
        #[cfg(not(feature = "gui"))]
        Command::Gui(_) => Err(nib::core::NibError::Other(
            "GUI feature not enabled; rebuild with --features gui".into(),
        )),
        Command::Capture(args) => cli::run_capture(&args),
        Command::Feedback(args) => cli::run_feedback(&args).await,
        Command::Review(args) => cli::run_review(&args).await,
        Command::Request(RequestCommand::Create(args)) => {
            cli::web_feedback::run_request_create(&args)
        }
        Command::Request(RequestCommand::Wait(args)) => {
            cli::web_feedback::run_request_wait(&args).await
        }
        Command::Request(RequestCommand::Review(args)) => {
            cli::web_feedback::run_request_review(&args).await
        }
        Command::Record(subcommand) => match subcommand {
            RecordCommand::Start(args) => nib::media::run_record_start(&args),
            RecordCommand::Status(args) => nib::media::run_record_status(&args),
            RecordCommand::Stop(args) => nib::media::run_record_stop(&args),
            RecordCommand::Wait(args) => nib::media::run_record_wait(&args).await,
        },
        Command::Media(subcommand) => match subcommand {
            MediaCommand::Inspect(args) => nib::media::run_media_inspect(&args),
            MediaCommand::Poster(args) => nib::media::run_media_poster(&args),
            MediaCommand::Transcribe(args) => nib::media::run_media_transcribe(&args),
        },
        Command::AwaitSubmit(args) => cli::run_await_submit(&args).await,
        Command::Annotation(subcommand) => match subcommand {
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
        Command::Grid(args) => cli::run_grid(&args),
        #[cfg(feature = "ocr")]
        Command::FindText(args) => cli::run_find_text(&args),
        #[cfg(not(feature = "ocr"))]
        Command::FindText(_) => Err(nib::core::NibError::Other(
            "OCR feature not enabled; rebuild with --features ocr".into(),
        )),
        Command::PickColor(args) => cli::run_pick_color(&args),
        Command::Windows(args) => cli::run_windows(&args),
        Command::Info(args) => cli::run_info(&args),
        Command::Tile(subcommand) => match subcommand {
            TileCommand::Query(args) => cli::run_tile_query(&args, &cli.format),
            TileCommand::Extract(args) => cli::run_tile_extract(&args),
            TileCommand::List(args) => cli::run_tile_list(&args, &cli.format),
        },
        Command::Validate(args) => cli::run_validate(&args),
        Command::List(args) => cli::run_list(&args),
        Command::Sessions => cli::run_sessions(&cli.format),
    }
}
