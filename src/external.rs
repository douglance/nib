//! Shells out to the external image-generation and judgment tools configured
//! in [`crate::config`] (default: `imago`). This is the seam: any CLI that
//! speaks the same JSON contract can be swapped in via config file or env var.
//!
//! Shared by the CLI (`nib generate` / `nib judge`) and the MCP tools
//! (`generate_image` / `judge_pair`) so both surfaces behave identically.

use crate::config::Config;
use crate::core::{NibError, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Default output path for a generated image: a timestamped PNG in the nib
/// captures directory.
pub fn default_output_path() -> PathBuf {
    let now = chrono::Local::now();
    let filename = format!("nib_gen_{}.png", now.format("%Y%m%d_%H%M%S"));
    crate::storage::captures_dir().join(filename)
}

/// Parameters for a generate request, mirroring the imago `generate` contract.
pub struct GenerateRequest<'a> {
    pub prompt: &'a str,
    pub width: u32,
    pub height: u32,
    pub out: &'a Path,
    pub references: &'a [PathBuf],
    pub crop: bool,
    pub timeout: Option<&'a str>,
}

/// Shell out to the configured generator:
/// `<command> generate --json --width W --height H --out PATH [--ref P]...
/// [--crop] [--timeout T] "<prompt>"`.
///
/// No kill timer is applied here: generation can legitimately take 12+
/// minutes, and the generator owns its own timeout handling. A non-zero exit
/// is always surfaced as an `Err` carrying the tool's own output — success is
/// never fabricated.
pub fn generate(config: &Config, req: &GenerateRequest) -> Result<serde_json::Value> {
    let mut cmd = Command::new(&config.generate.command);
    cmd.arg("generate")
        .arg("--json")
        .arg("--width")
        .arg(req.width.to_string())
        .arg("--height")
        .arg(req.height.to_string())
        .arg("--out")
        .arg(req.out);

    for reference in req.references {
        cmd.arg("--ref").arg(reference);
    }
    if req.crop {
        cmd.arg("--crop");
    }
    if let Some(timeout) = req.timeout {
        cmd.arg("--timeout").arg(timeout);
    }
    cmd.arg(req.prompt);

    run_json_tool(cmd, &config.generate.command)
}

/// Parameters for a judge request, mirroring the imago `compare` contract.
pub struct JudgeRequest<'a> {
    pub expected: &'a Path,
    pub actual: &'a Path,
    pub timeout: Option<&'a str>,
    pub open: bool,
}

/// Shell out to the configured judge tool:
/// `<command> compare --json [--open] [--timeout T] EXPECTED ACTUAL`.
///
/// Returns the parsed JSON verdict envelope (a `verdict` field of `READY` or
/// `BLOCKED`, plus `blockers`/`polish`/etc.) on success.
pub fn judge(config: &Config, req: &JudgeRequest) -> Result<serde_json::Value> {
    let mut cmd = Command::new(&config.judge.command);
    cmd.arg("compare").arg("--json");
    if req.open {
        cmd.arg("--open");
    }
    if let Some(timeout) = req.timeout {
        cmd.arg("--timeout").arg(timeout);
    }
    cmd.arg(req.expected).arg(req.actual);

    run_json_tool(cmd, &config.judge.command)
}

/// Run `cmd`, capturing output rather than streaming it (the captured-output
/// pattern from `src/ocr/mod.rs`, not the fire-and-forget spawn used for the
/// GUI subprocess). A non-zero exit surfaces the tool's own stdout/stderr
/// verbatim as the error and never produces a success value.
fn run_json_tool(mut cmd: Command, command_name: &str) -> Result<serde_json::Value> {
    let output = cmd
        .output()
        .map_err(|e| NibError::Other(format!("Failed to run '{}': {}", command_name, e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let body = if stdout.trim().is_empty() {
            stderr.trim()
        } else {
            stdout.trim()
        };
        return Err(NibError::Other(format!(
            "'{}' exited with {}: {}",
            command_name, output.status, body
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).map_err(|e| {
        NibError::Other(format!(
            "Failed to parse '{}' output as JSON: {} (output: {})",
            command_name,
            e,
            stdout.trim()
        ))
    })
}
