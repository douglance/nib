//! Event notification module for external tool integration.
//!
//! Provides minimal, structured logging for automation tools to consume.
//! Events are emitted when `NIB_EVENTS` is set (to stdout) or `NIB_EVENTS_PIPE`
//! is set to a named pipe path (for push-based notifications).
//!
//! # Usage
//!
//! ```bash
//! # Stdout mode (polling)
//! NIB_EVENTS=1 nib gui image.png
//!
//! # Pipe mode (push - blocking read)
//! mkfifo /tmp/nib.pipe
//! NIB_EVENTS_PIPE=/tmp/nib.pipe nib gui image.png &
//! cat /tmp/nib.pipe  # blocks until events arrive
//! ```
//!
//! # Event Format
//!
//! ```text
//! [NIB 1704067200000] human created a4 arrow
//! [NIB 1704067200500] human deleted a2
//! ```

use std::io::Write;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static ENABLED: OnceLock<bool> = OnceLock::new();
static PIPE_PATH: OnceLock<Option<String>> = OnceLock::new();

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

/// Get current timestamp in milliseconds since Unix epoch.
pub fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// Check if NIB event logging is enabled (cached after first call).
pub fn enabled() -> bool {
    *ENABLED.get_or_init(|| {
        std::env::var("NIB_EVENTS").is_ok() || std::env::var("NIB_EVENTS_PIPE").is_ok()
    })
}

/// Get the pipe path if configured.
pub fn pipe_path() -> Option<&'static str> {
    PIPE_PATH
        .get_or_init(|| std::env::var("NIB_EVENTS_PIPE").ok())
        .as_deref()
}

/// Write an event message to the configured output (stdout and/or pipe).
pub fn emit(message: &str) {
    let formatted = format!("[NIB {}] {}", timestamp_ms(), message);

    // Write to pipe if configured (non-blocking to avoid freezing if no reader)
    #[cfg(unix)]
    if let Some(path) = pipe_path() {
        use std::fs::OpenOptions;
        // O_NONBLOCK prevents blocking if no reader is connected
        if let Ok(mut file) = OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(path)
        {
            let _ = writeln!(file, "{}", formatted);
        }
    }

    // Also write to stdout if NIB_EVENTS is set
    if std::env::var("NIB_EVENTS").is_ok() {
        println!("{}", formatted);
    }
}

/// Log a NIB event. No-op if events are not enabled.
///
/// # Example
///
/// ```ignore
/// use nib::nib_log;
/// nib_log!("human created {} arrow", annotation.id.0);
/// ```
#[macro_export]
macro_rules! nib_log {
    ($($arg:tt)*) => {
        if $crate::events::enabled() {
            $crate::events::emit(&format!($($arg)*));
        }
    };
}

pub use nib_log;
