//! Event notification module for external tool integration.
//!
//! Provides minimal, structured logging to stdout for automation tools to consume.
//! Events are only emitted when the `NIB_EVENTS` environment variable is set.
//!
//! # Usage
//!
//! ```bash
//! NIB_EVENTS=1 nib gui image.png
//! ```
//!
//! # Event Format
//!
//! Events follow progressive disclosure - just event type + ID + optional hint:
//! ```text
//! [NIB] created a4 arrow
//! [NIB] deleted a4
//! [NIB] moved a4 a5
//! [NIB] resized a3
//! [NIB] edited a5
//! [NIB] ready 3
//! ```

use std::sync::OnceLock;

static ENABLED: OnceLock<bool> = OnceLock::new();

/// Check if NIB event logging is enabled (cached after first call).
///
/// Returns `true` if the `NIB_EVENTS` environment variable is set to any value.
pub fn enabled() -> bool {
    *ENABLED.get_or_init(|| std::env::var("NIB_EVENTS").is_ok())
}

/// Log a NIB event to stdout. No-op if `NIB_EVENTS` is not set.
///
/// # Example
///
/// ```ignore
/// use nib::nib_log;
/// nib_log!("created {} arrow", annotation.id.0);
/// ```
#[macro_export]
macro_rules! nib_log {
    ($($arg:tt)*) => {
        if $crate::events::enabled() {
            println!("[NIB] {}", format!($($arg)*));
        }
    };
}

pub use nib_log;
