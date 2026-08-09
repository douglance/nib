//! Screen recording and media primitives shared by CLI and MCP surfaces.

use crate::cli::{
    MediaInspectArgs, MediaPosterArgs, MediaTranscribeArgs, RecordStartArgs, RecordStatusArgs,
    RecordStopArgs, RecordWaitArgs,
};
use crate::core::{NibError, Result};
use chrono::Utc;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use uuid::Uuid;

#[cfg(target_os = "macos")]
use std::os::unix::process::CommandExt;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RecordingStatus {
    Recording,
    Finalizing,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecordingState {
    pub id: String,
    pub status: RecordingStatus,
    pub pid: u32,
    pub output: PathBuf,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub duration_seconds: Option<u64>,
    pub system_audio: bool,
    pub microphone: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: PathBuf,
    pub content_type: String,
    pub container: String,
    pub video_codec: String,
    pub width: u32,
    pub height: u32,
    pub duration_ms: u64,
    pub frame_rate: Option<f64>,
    pub has_audio: bool,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptResult {
    pub status: &'static str,
    pub source: &'static str,
    pub locale: Option<String>,
    pub text: String,
    pub segments: Vec<serde_json::Value>,
    pub error: Option<String>,
}

pub fn run_record_start(args: &RecordStartArgs) -> Result<()> {
    let state = start_recording(args)?;
    print_json(&state)
}

pub fn run_record_status(args: &RecordStatusArgs) -> Result<()> {
    let state = recording_status(args.id.as_deref())?;
    print_json(&state)
}

pub fn run_record_stop(args: &RecordStopArgs) -> Result<()> {
    let state = stop_recording(args.id.as_deref())?;
    print_json(&state)
}

pub async fn run_record_wait(args: &RecordWaitArgs) -> Result<()> {
    let state = wait_for_recording(&args.id, args.timeout).await?;
    print_json(&state)
}

pub fn run_media_inspect(args: &MediaInspectArgs) -> Result<()> {
    print_json(&inspect_media(&args.file)?)
}

pub fn run_media_poster(args: &MediaPosterArgs) -> Result<()> {
    let output = poster_frame(&args.file, args.output.as_deref())?;
    print_json(&serde_json::json!({ "file": output, "contentType": "image/png" }))
}

pub fn run_media_transcribe(args: &MediaTranscribeArgs) -> Result<()> {
    let _ = inspect_media(&args.file)?;
    print_json(&TranscriptResult {
        status: "unavailable",
        source: "none",
        locale: args.locale.clone(),
        text: String::new(),
        segments: Vec::new(),
        error: Some(
            "On-device transcription is unavailable in this build; preserve the media and retry on a Nib Apple client"
                .to_string(),
        ),
    })
}

pub fn start_recording(args: &RecordStartArgs) -> Result<RecordingState> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = args;
        return Err(other(
            "E_RECORDING_UNSUPPORTED: screen recording is currently available on macOS",
        ));
    }

    #[cfg(target_os = "macos")]
    {
        validate_record_target(args)?;
        if let Ok(active) = recording_status(None) {
            if matches!(
                active.status,
                RecordingStatus::Recording | RecordingStatus::Finalizing
            ) {
                return Err(other(format!(
                    "E_RECORDING_ACTIVE: recording {} is already active at {}",
                    active.id,
                    active.output.display()
                )));
            }
        }

        let id = Uuid::new_v4().to_string();
        let output = recording_output(args.output.as_deref())?;
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::create_dir_all(recordings_dir())?;
        let diagnostic_log = File::create(recording_log_path(&id))?;
        let mut command = Command::new("/usr/sbin/screencapture");
        command.args(["-v", "-x"]);
        if !args.no_cursor {
            command.arg("-C");
        }
        if args.show_clicks {
            command.arg("-k");
        }
        if args.system_audio {
            command.arg("-A");
        }
        if args.microphone {
            command.arg("-g");
        }
        if let Some(duration) = args.duration {
            if duration == 0 {
                return Err(other("recording duration must be greater than zero"));
            }
            command.arg(format!("-V{duration}"));
        }
        if args.interactive {
            command.args(["-i", "-Jvideo"]);
        } else if let Some(display) = args.display {
            command.arg(format!("-D{display}"));
        } else if let Some(window) = args.window {
            command.arg(format!("-l{window}"));
        } else if let Some(region) = &args.region {
            parse_region(region)?;
            command.arg(format!("-R{region}"));
        } else {
            command.arg("-D1");
        }
        command
            .arg(&output)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(diagnostic_log));
        // The CLI returns the durable recording ID immediately. Put the
        // capture worker in its own session so closing that CLI process does
        // not deliver a terminal hangup to the in-progress recording.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command
            .spawn()
            .map_err(|error| other(format!("failed to start macOS screen recording: {error}")))?;
        let state = RecordingState {
            id,
            status: RecordingStatus::Recording,
            pid: child.id(),
            output,
            started_at: Utc::now().to_rfc3339(),
            finished_at: None,
            duration_seconds: args.duration,
            system_audio: args.system_audio,
            microphone: args.microphone,
            error: None,
        };
        save_recording(&state)?;
        std::thread::sleep(Duration::from_millis(150));
        if let Some(exit) = child
            .try_wait()
            .map_err(|error| other(format!("failed to read recording worker state: {error}")))?
        {
            let mut failed = state;
            failed.status = RecordingStatus::Failed;
            failed.finished_at = Some(Utc::now().to_rfc3339());
            let diagnostics = recording_diagnostics(&failed.id);
            failed.error = Some(if diagnostics.is_empty() {
                format!(
                    "screen recording exited immediately with {exit}; check Screen Recording permission"
                )
            } else {
                format!("screen recording exited immediately with {exit}: {diagnostics}")
            });
            save_recording(&failed)?;
            return Err(other(failed.error.clone().unwrap_or_default()));
        }
        Ok(state)
    }
}

pub fn recording_status(id: Option<&str>) -> Result<RecordingState> {
    let id = match id {
        Some(id) => id.to_string(),
        None => active_recording_id()?.ok_or_else(|| other("no active recording"))?,
    };
    let mut state = load_recording(&id)?;
    if matches!(
        state.status,
        RecordingStatus::Recording | RecordingStatus::Finalizing
    ) && !crate::storage::is_process_alive(state.pid)
    {
        state.finished_at = Some(Utc::now().to_rfc3339());
        match fs::metadata(&state.output) {
            Ok(metadata) if metadata.len() > 0 => {
                state.status = RecordingStatus::Completed;
                if let Err(error) = inspect_media(&state.output) {
                    state.status = RecordingStatus::Failed;
                    state.error = Some(error.to_string());
                }
            }
            _ => {
                state.status = RecordingStatus::Failed;
                let diagnostics = recording_diagnostics(&state.id);
                state.error = Some(if diagnostics.is_empty() {
                    "recording worker exited without a usable MP4 file; check Screen Recording permission"
                        .to_string()
                } else {
                    format!("recording worker exited without a usable MP4 file: {diagnostics}")
                });
            }
        }
        save_recording(&state)?;
    }
    Ok(state)
}

pub fn stop_recording(id: Option<&str>) -> Result<RecordingState> {
    let mut state = recording_status(id)?;
    if matches!(
        state.status,
        RecordingStatus::Completed | RecordingStatus::Failed
    ) {
        return Ok(state);
    }
    #[cfg(unix)]
    unsafe {
        if libc::kill(state.pid as libc::pid_t, libc::SIGINT) != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(other(format!(
                    "failed to stop recording {}: {error}",
                    state.id
                )));
            }
        }
    }
    state.status = RecordingStatus::Finalizing;
    save_recording(&state)?;
    Ok(state)
}

pub async fn wait_for_recording(id: &str, timeout_seconds: u64) -> Result<RecordingState> {
    let started = Instant::now();
    loop {
        let state = recording_status(Some(id))?;
        if matches!(
            state.status,
            RecordingStatus::Completed | RecordingStatus::Failed
        ) {
            return Ok(state);
        }
        if timeout_seconds > 0 && started.elapsed() >= Duration::from_secs(timeout_seconds) {
            return Err(other(format!(
                "recording {id} did not finish within {timeout_seconds}s; resume with: nib record wait {id}"
            )));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

pub fn inspect_media(path: &Path) -> Result<MediaInfo> {
    if !path.is_file() {
        return Err(other(format!("media file not found: {}", path.display())));
    }
    let bytes = fs::read(path)?;
    if bytes.len() < 12 || &bytes[4..8] != b"ftyp" {
        return Err(other("E_MEDIA_CONTAINER: expected an MP4 file"));
    }
    if !contains(&bytes, b"avc1") && !contains(&bytes, b"avc3") {
        return Err(other("E_MEDIA_CODEC: first-release video must use H.264"));
    }
    let mut duration_ms = 0;
    let mut dimensions = (0, 0);
    walk_boxes(&bytes, 0, bytes.len(), 0, &mut |kind, payload| match kind {
        b"mvhd" => duration_ms = parse_mvhd(payload).unwrap_or(duration_ms),
        b"tkhd" => {
            if let Some((width, height)) = parse_tkhd(payload) {
                if u64::from(width) * u64::from(height)
                    > u64::from(dimensions.0) * u64::from(dimensions.1)
                {
                    dimensions = (width, height);
                }
            }
        }
        _ => {}
    });
    if dimensions.0 == 0 || dimensions.1 == 0 {
        return Err(other(
            "E_MEDIA_DIMENSIONS: MP4 video dimensions are missing",
        ));
    }
    if duration_ms == 0 {
        return Err(other("E_MEDIA_DURATION: MP4 duration is missing"));
    }
    let sha256 = hash_file(path)?;
    Ok(MediaInfo {
        path: absolute(path)?,
        content_type: "video/mp4".to_string(),
        container: "mp4".to_string(),
        video_codec: "h264".to_string(),
        width: dimensions.0,
        height: dimensions.1,
        duration_ms,
        frame_rate: None,
        has_audio: contains(&bytes, b"soun") || contains(&bytes, b"mp4a"),
        sha256,
        bytes: bytes.len() as u64,
    })
}

pub fn poster_frame(path: &Path, output: Option<&Path>) -> Result<PathBuf> {
    let _ = inspect_media(path)?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = output;
        return Err(other(
            "E_POSTER_UNSUPPORTED: poster extraction is currently available on macOS",
        ));
    }
    #[cfg(target_os = "macos")]
    {
        let output = output
            .map(Path::to_path_buf)
            .unwrap_or_else(|| path.with_extension("poster.png"));
        let temporary = std::env::temp_dir().join(format!("nib-poster-{}", Uuid::new_v4()));
        fs::create_dir_all(&temporary)?;
        let status = Command::new("/usr/bin/qlmanage")
            .args(["-t", "-s", "1600", "-o"])
            .arg(&temporary)
            .arg(path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| other(format!("failed to start poster extraction: {error}")))?;
        if !status.success() {
            let _ = fs::remove_dir_all(&temporary);
            return Err(other(format!("poster extraction failed with {status}")));
        }
        let generated = fs::read_dir(&temporary)?
            .filter_map(std::result::Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
            })
            .ok_or_else(|| other("poster extraction did not produce a PNG"))?;
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&generated, &output)?;
        fs::remove_dir_all(&temporary)?;
        absolute(&output)
    }
}

fn validate_record_target(args: &RecordStartArgs) -> Result<()> {
    let targets = [
        args.display.is_some(),
        args.window.is_some(),
        args.region.is_some(),
        args.interactive,
    ]
    .into_iter()
    .filter(|selected| *selected)
    .count();
    if targets > 1 {
        return Err(other(
            "choose only one recording target: --display, --window, --region, or --interactive",
        ));
    }
    Ok(())
}

fn parse_region(value: &str) -> Result<(u32, u32, u32, u32)> {
    let values = value
        .split(',')
        .map(str::trim)
        .map(str::parse::<u32>)
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| other("--region must be x,y,width,height using non-negative integers"))?;
    if values.len() != 4 || values[2] == 0 || values[3] == 0 {
        return Err(other(
            "--region must be x,y,width,height with non-zero width and height",
        ));
    }
    Ok((values[0], values[1], values[2], values[3]))
}

fn recording_output(output: Option<&Path>) -> Result<PathBuf> {
    match output {
        Some(path) => absolute(path),
        None => {
            let directory = crate::storage::captures_dir();
            fs::create_dir_all(&directory)?;
            Ok(directory.join(format!(
                "recording-{}-{}.mp4",
                Utc::now().format("%Y%m%d-%H%M%S"),
                &Uuid::new_v4().to_string()[..8]
            )))
        }
    }
}

fn recordings_dir() -> PathBuf {
    crate::storage::storage_dir().join("recordings")
}

fn recording_path(id: &str) -> PathBuf {
    recordings_dir().join(format!("{id}.json"))
}

fn recording_log_path(id: &str) -> PathBuf {
    recordings_dir().join(format!("{id}.stderr.log"))
}

fn recording_diagnostics(id: &str) -> String {
    fs::read_to_string(recording_log_path(id))
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn save_recording(state: &RecordingState) -> Result<()> {
    fs::create_dir_all(recordings_dir())?;
    let path = recording_path(&state.id);
    let temporary = path.with_extension(format!("json.tmp-{}", std::process::id()));
    let mut file = File::create(&temporary)?;
    serde_json::to_writer_pretty(&mut file, state)
        .map_err(|error| other(format!("failed to serialize recording state: {error}")))?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn load_recording(id: &str) -> Result<RecordingState> {
    let bytes = fs::read(recording_path(id))
        .map_err(|error| other(format!("recording {id} was not found: {error}")))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| other(format!("recording {id} state is invalid: {error}")))
}

fn active_recording_id() -> Result<Option<String>> {
    let directory = recordings_dir();
    if !directory.exists() {
        return Ok(None);
    }
    let mut candidates = fs::read_dir(directory)?
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
        .filter_map(|entry| fs::read(entry.path()).ok())
        .filter_map(|bytes| serde_json::from_slice::<RecordingState>(&bytes).ok())
        .filter(|state| {
            matches!(
                state.status,
                RecordingStatus::Recording | RecordingStatus::Finalizing
            ) && crate::storage::is_process_alive(state.pid)
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.started_at.cmp(&left.started_at));
    Ok(candidates.into_iter().next().map(|state| state.id))
}

fn hash_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn absolute(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn walk_boxes(
    data: &[u8],
    start: usize,
    end: usize,
    depth: usize,
    visitor: &mut impl FnMut(&[u8; 4], &[u8]),
) {
    if depth > 12 || start >= end || end > data.len() {
        return;
    }
    let mut offset = start;
    while offset.saturating_add(8) <= end {
        let size32 = u32::from_be_bytes(data[offset..offset + 4].try_into().unwrap()) as usize;
        let kind: &[u8; 4] = data[offset + 4..offset + 8].try_into().unwrap();
        let (size, header) = if size32 == 1 && offset.saturating_add(16) <= end {
            (
                u64::from_be_bytes(data[offset + 8..offset + 16].try_into().unwrap()) as usize,
                16,
            )
        } else if size32 == 0 {
            (end - offset, 8)
        } else {
            (size32, 8)
        };
        if size < header || offset.saturating_add(size) > end {
            break;
        }
        let payload_start = offset + header;
        let payload_end = offset + size;
        let payload = &data[payload_start..payload_end];
        visitor(kind, payload);
        if matches!(
            kind,
            b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" | b"edts" | b"dinf" | b"udta" | b"meta"
        ) {
            let child_start = if kind == b"meta" {
                payload_start.saturating_add(4)
            } else {
                payload_start
            };
            walk_boxes(data, child_start, payload_end, depth + 1, visitor);
        }
        offset += size;
    }
}

fn parse_mvhd(payload: &[u8]) -> Option<u64> {
    let version = *payload.first()?;
    let (timescale_offset, duration_offset, duration_bytes) = if version == 1 {
        (20, 24, 8)
    } else {
        (12, 16, 4)
    };
    let timescale = u32::from_be_bytes(
        payload
            .get(timescale_offset..timescale_offset + 4)?
            .try_into()
            .ok()?,
    );
    if timescale == 0 {
        return None;
    }
    let duration = if duration_bytes == 8 {
        u64::from_be_bytes(
            payload
                .get(duration_offset..duration_offset + 8)?
                .try_into()
                .ok()?,
        )
    } else {
        u32::from_be_bytes(
            payload
                .get(duration_offset..duration_offset + 4)?
                .try_into()
                .ok()?,
        ) as u64
    };
    Some(duration.saturating_mul(1_000) / u64::from(timescale))
}

fn parse_tkhd(payload: &[u8]) -> Option<(u32, u32)> {
    if payload.len() < 8 {
        return None;
    }
    let width = u32::from_be_bytes(
        payload[payload.len() - 8..payload.len() - 4]
            .try_into()
            .ok()?,
    ) >> 16;
    let height = u32::from_be_bytes(payload[payload.len() - 4..].try_into().ok()?) >> 16;
    (width > 0 && height > 0).then_some((width, height))
}

fn print_json(value: &impl Serialize) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string(value)
            .map_err(|error| other(format!("failed to serialize result: {error}")))?
    );
    Ok(())
}

fn other(message: impl Into<String>) -> NibError {
    NibError::Other(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_target_is_unambiguous() {
        let args = RecordStartArgs {
            output: None,
            duration: None,
            display: Some(1),
            window: Some(2),
            region: None,
            interactive: false,
            system_audio: false,
            microphone: false,
            no_cursor: false,
            show_clicks: false,
        };
        assert!(validate_record_target(&args).is_err());
    }

    #[test]
    fn region_requires_four_values_and_nonzero_size() {
        assert_eq!(parse_region("1,2,3,4").unwrap(), (1, 2, 3, 4));
        assert!(parse_region("1,2,0,4").is_err());
        assert!(parse_region("1,2,3").is_err());
    }
}
