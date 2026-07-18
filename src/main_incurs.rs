//! Temporary parallel entry point for the incurs migration.
//!
//! See ~/.claude/plans/what-would-it-look-typed-kettle.md. This binary exists
//! only for the duration of the migration so the real `nib` binary (clap-based)
//! and its full test suite stay green while commands are ported one at a time.
//! Removed at cutover (plan step 11), when `main.rs` itself becomes the
//! incurs-based entry point.

#[tokio::main]
async fn main() {
    let cli = nib::cli::build_cli();
    if let Err(e) = cli.serve().await {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}
