//! Integration tests for `nib generate` and `nib judge`, driven against fake
//! generator/judge fixtures (see tests/fixtures/). Each test spawns the real
//! compiled `nib` binary with `NIB_GENERATE_COMMAND`/`NIB_JUDGE_COMMAND`
//! pointed at a fixture script, and the fixture's behavior mode passed via a
//! child-process-scoped env var — no shared process state, safe under
//! parallel test execution.
//!
//! This also exercises the real exit-code contract (0 READY / 2 BLOCKED /
//! non-zero tool failure) by observing a child process's exit code, since
//! calling `std::process::exit` in-process would abort the whole test run.

use std::path::PathBuf;
use std::process::Command;

fn nib_bin() -> &'static str {
    env!("CARGO_BIN_EXE_nib")
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

#[test]
fn generate_success_writes_png_and_prints_json_envelope() {
    let temp = tempfile::TempDir::new().unwrap();
    let out = temp.path().join("out.png");

    let output = Command::new(nib_bin())
        .env("NIB_GENERATE_COMMAND", fixture("fake-generate.sh"))
        .args([
            "--format", "json", "generate", "--width", "64", "--height", "64", "--out",
        ])
        .arg(&out)
        .arg("a lighthouse at dusk")
        .output()
        .expect("failed to run nib generate");

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(out.exists(), "generator should have written the PNG");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value = serde_json::from_str(stdout.trim())
        .expect("stdout should be the generator's JSON envelope");
    assert_eq!(json["status"], "success");
    assert_eq!(json["matched"], true);
}

#[test]
fn generate_nonzero_exit_passes_error_envelope_through_and_never_fabricates_success() {
    let temp = tempfile::TempDir::new().unwrap();
    let out = temp.path().join("out.png");

    let output = Command::new(nib_bin())
        .env("NIB_GENERATE_COMMAND", fixture("fake-generate.sh"))
        .env("FAKE_GENERATE_MODE", "error")
        .args(["generate", "--width", "64", "--height", "64", "--out"])
        .arg(&out)
        .arg("a lighthouse at dusk")
        .output()
        .expect("failed to run nib generate");

    assert!(!output.status.success());
    assert!(
        !out.exists(),
        "must never fabricate success: no PNG should have been written"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("AGY_FAILED"),
        "the generator's error envelope should pass through verbatim, got: {}",
        stderr
    );
}

#[test]
fn generate_garbage_stdout_is_a_tool_error_not_a_fabricated_success() {
    let temp = tempfile::TempDir::new().unwrap();
    let out = temp.path().join("out.png");

    let output = Command::new(nib_bin())
        .env("NIB_GENERATE_COMMAND", fixture("fake-generate.sh"))
        .env("FAKE_GENERATE_MODE", "garbage")
        .args(["generate", "--width", "64", "--height", "64", "--out"])
        .arg(&out)
        .arg("a lighthouse at dusk")
        .output()
        .expect("failed to run nib generate");

    assert!(!output.status.success());
}

#[test]
fn judge_ready_exits_zero_and_prints_verdict() {
    let expected = fixture("tiny.png");

    let output = Command::new(nib_bin())
        .env("NIB_JUDGE_COMMAND", fixture("fake-judge.sh"))
        .env("FAKE_JUDGE_MODE", "ready")
        .args(["--format", "json", "judge"])
        .arg(&expected)
        .arg(&expected)
        .output()
        .expect("failed to run nib judge");

    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("stdout should be the judge's JSON verdict");
    assert_eq!(json["verdict"], "READY");
}

#[test]
fn judge_blocked_exits_two() {
    let expected = fixture("tiny.png");

    let output = Command::new(nib_bin())
        .env("NIB_JUDGE_COMMAND", fixture("fake-judge.sh"))
        .env("FAKE_JUDGE_MODE", "blocked")
        .args(["judge"])
        .arg(&expected)
        .arg(&expected)
        .output()
        .expect("failed to run nib judge");

    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn judge_garbage_output_is_tool_failure_not_ready_or_blocked() {
    let expected = fixture("tiny.png");

    let output = Command::new(nib_bin())
        .env("NIB_JUDGE_COMMAND", fixture("fake-judge.sh"))
        .env("FAKE_JUDGE_MODE", "garbage")
        .args(["judge"])
        .arg(&expected)
        .arg(&expected)
        .output()
        .expect("failed to run nib judge");

    assert!(!output.status.success());
    assert_ne!(
        output.status.code(),
        Some(2),
        "unparseable judge output must not read as BLOCKED"
    );
}

#[test]
fn judge_tool_process_failure_exits_nonzero_not_two() {
    let expected = fixture("tiny.png");

    let output = Command::new(nib_bin())
        .env("NIB_JUDGE_COMMAND", fixture("fake-judge.sh"))
        .env("FAKE_JUDGE_MODE", "error")
        .args(["judge"])
        .arg(&expected)
        .arg(&expected)
        .output()
        .expect("failed to run nib judge");

    assert!(!output.status.success());
    assert_ne!(output.status.code(), Some(2));
}

#[test]
fn generate_with_nib_flag_also_imports_a_nib_file() {
    let temp = tempfile::TempDir::new().unwrap();
    let out = temp.path().join("out.png");

    let output = Command::new(nib_bin())
        .env("NIB_GENERATE_COMMAND", fixture("fake-generate.sh"))
        .args([
            "generate", "--width", "64", "--height", "64", "--nib", "--out",
        ])
        .arg(&out)
        .arg("a lighthouse at dusk")
        .output()
        .expect("failed to run nib generate --nib");

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(out.exists());
    assert!(
        out.with_extension("nib").exists(),
        "--nib should import the generated PNG into a .nib file"
    );
}
