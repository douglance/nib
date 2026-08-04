//! MCP Server implementation for Nib
//!
//! Provides tools for Claude to interact with Nib annotations.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashSet};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use base64::{engine::general_purpose, Engine as _};
use incurs::tool::{ToolCallOptions, ToolCallOutcome, ToolCatalog, ToolDefinition};
use incurs_codemode::{CodeMode, IncurConnector};
use incurs_codemode_local::{LocalCodeModeService, LocalExecutor};
use incurs_codemode_mcp::{CodeModeMcpServer, TOOL_NAMES as CODE_MODE_TOOL_NAMES};
use rmcp::{
    handler::server::tool::{ToolCallContext, ToolRouter},
    handler::server::wrapper::Parameters,
    model::*,
    service::{RequestContext, ServiceExt},
    task_handler,
    task_manager::OperationProcessor,
    tool, tool_router,
    transport::stdio,
    ErrorData as McpError, RoleServer, ServerHandler,
};
use tokio::sync::Mutex;

use crate::core::{ImageSource, NibImage, Result as NibResult};
use crate::storage::export;
use crate::storage::{encode_composited_png, nib_file::NibFile, ExportOptions};
use crate::{
    annotations_file_path, deserialize_annotation, AnnotationGeometry, AnnotationsFile,
    SerializedAnnotation,
};

use super::tools::*;
use super::watcher::AnnotationWatcher;

const REQUEST_TASK_TTL_MS: u64 = 24 * 60 * 60 * 1_000;
const REQUEST_TASK_POLL_INTERVAL_MS: u64 = 1_500;

fn request_task(task_id: String, status: TaskStatus, status_message: Option<&str>) -> Task {
    let timestamp = rmcp::task_manager::current_timestamp();
    let mut task = Task::new(task_id, status, timestamp.clone(), timestamp)
        .with_ttl(REQUEST_TASK_TTL_MS)
        .with_poll_interval(REQUEST_TASK_POLL_INTERVAL_MS);
    if let Some(message) = status_message {
        task = task.with_status_message(message);
    }
    task
}

fn completed_task_status(result: &rmcp::task_manager::TaskResult) -> TaskStatus {
    match &result.result {
        Ok(transport) => transport
            .as_any()
            .downcast_ref::<rmcp::task_manager::ToolCallTaskResult>()
            .map(|tool| {
                if tool.result.is_ok() {
                    TaskStatus::Completed
                } else {
                    TaskStatus::Failed
                }
            })
            .unwrap_or(TaskStatus::Completed),
        Err(error) if error.to_string().contains("cancelled") => TaskStatus::Cancelled,
        Err(_) => TaskStatus::Failed,
    }
}

/// MCP Server for Nib annotations
#[derive(Clone)]
pub struct NibMcpServer {
    /// Current image being annotated (optional, can work with any image)
    #[allow(dead_code)]
    current_image: Arc<Mutex<Option<PathBuf>>>,
    /// Tool router for MCP protocol
    tool_router: ToolRouter<Self>,
    /// Annotation watcher for file change events
    watcher: Arc<Mutex<Option<AnnotationWatcher>>>,
    /// Task state for durable request waiters
    processor: Arc<Mutex<OperationProcessor>>,
    /// Incurs Code Mode lifecycle served through the same MCP connection
    code_mode: Option<CodeModeMcpServer>,
    /// Canonical Incurs catalog used for direct MCP commands and Code Mode
    catalog: Option<ToolCatalog>,
}

#[tool_router]
impl NibMcpServer {
    pub fn new() -> Self {
        let watcher = AnnotationWatcher::new().ok();
        let (catalog, code_mode) = build_catalog_and_code_mode();
        Self {
            current_image: Arc::new(Mutex::new(None)),
            tool_router: Self::tool_router(),
            watcher: Arc::new(Mutex::new(watcher)),
            processor: Arc::new(Mutex::new(OperationProcessor::new())),
            code_mode,
            catalog,
        }
    }

    /// Present an image as first-class MCP image content. Text-only Codex TUI
    /// clients also receive a best-effort render through their controlling
    /// graphics terminal without contaminating MCP stdio.
    #[tool(
        description = "Display a PNG, JPEG, WebP, or .nib image inline and ask a feedback question. Returns first-class MCP image content; when Codex CLI is running in a supported graphics terminal, Nib also renders into transcript rows reserved for the result. After calling, wait for the user's next thread message as the feedback response."
    )]
    async fn present_image(
        &self,
        Parameters(request): Parameters<PresentImageRequest>,
    ) -> Result<CallToolResult, McpError> {
        let image_path = PathBuf::from(&request.image_path);
        if !image_path.exists() {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Error: File not found: {}",
                request.image_path
            ))]));
        }

        let (bytes, mime_type) =
            inline_image_content(&image_path).map_err(|e| McpError::internal_error(e, None))?;
        let terminal_rendered = terminal_png(&bytes)
            .map(|(png, width, height)| {
                nib_tui::try_schedule_codex_inline_image(png, width, height)
            })
            .unwrap_or(false);
        let prompt = present_image_prompt(&request.question, &image_path, terminal_rendered);
        Ok(CallToolResult::success(vec![
            ContentBlock::image(general_purpose::STANDARD.encode(bytes), mime_type),
            ContentBlock::text(prompt),
        ]))
    }

    pub fn with_image(image_path: PathBuf) -> Self {
        let watcher = AnnotationWatcher::new().ok();
        let (catalog, code_mode) = build_catalog_and_code_mode();
        Self {
            current_image: Arc::new(Mutex::new(Some(image_path))),
            tool_router: Self::tool_router(),
            watcher: Arc::new(Mutex::new(watcher)),
            processor: Arc::new(Mutex::new(OperationProcessor::new())),
            code_mode,
            catalog,
        }
    }

    /// Publish a visual review without tying its lifetime to this MCP process.
    #[tool(
        description = "Create and publish a durable visual feedback request. Returns the request ID, URL, status, and canonical .nib file. Use wait_for_request with the returned request ID.",
        execution(task_support = "forbidden")
    )]
    async fn create_feedback_request(
        &self,
        Parameters(request): Parameters<CreateFeedbackRequest>,
    ) -> Result<CallToolResult, McpError> {
        let path = PathBuf::from(request.image_path);
        let question = request.question;
        let annotations = request.annotations;
        let published = tokio::task::spawn_blocking(move || {
            crate::cli::web_feedback::create_feedback_request(
                &path,
                question.as_deref(),
                annotations.as_deref(),
            )
        })
        .await
        .map_err(|error| McpError::internal_error(format!("Feedback task failed: {error}"), None))?
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        let json = serde_json::to_string(&published)
            .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::text(json)]))
    }

    /// Publish an image or MP4/H.264 review through the same durable contract.
    #[tool(
        description = "Create and publish a durable image or MP4/H.264 review. Returns the request ID and URL. Use wait_for_request with the returned request ID.",
        execution(task_support = "forbidden")
    )]
    async fn create_review_request(
        &self,
        Parameters(request): Parameters<CreateReviewRequest>,
    ) -> Result<CallToolResult, McpError> {
        let path = PathBuf::from(request.media_path);
        let question = request.question;
        let annotations = request.annotations;
        let published = tokio::task::spawn_blocking(move || {
            crate::cli::web_feedback::create_review_request(
                &path,
                question.as_deref(),
                annotations.as_deref(),
            )
        })
        .await
        .map_err(|error| McpError::internal_error(format!("Review task failed: {error}"), None))?
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        json_tool_result(&published)
    }

    /// Start a durable screen recording on macOS.
    #[tool(
        description = "Start a macOS screen recording. Silent audio is the default. Returns a durable recording ID immediately."
    )]
    async fn start_recording(
        &self,
        Parameters(request): Parameters<StartRecordingRequest>,
    ) -> Result<CallToolResult, McpError> {
        let args = crate::cli::RecordStartArgs {
            output: request.output_path.map(PathBuf::from),
            duration: request.duration_seconds,
            display: request.display,
            window: request.window,
            region: request.region,
            interactive: request.interactive.unwrap_or(false),
            system_audio: request.system_audio.unwrap_or(false),
            microphone: request.microphone.unwrap_or(false),
            no_cursor: !request.cursor.unwrap_or(true),
            show_clicks: request.show_clicks.unwrap_or(false),
        };
        let state = tokio::task::spawn_blocking(move || crate::media::start_recording(&args))
            .await
            .map_err(|error| {
                McpError::internal_error(format!("Recording task failed: {error}"), None)
            })?
            .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        json_tool_result(&state)
    }

    /// Inspect active or named recording state.
    #[tool(
        description = "Read the current state of a durable recording. Omitting recording_id selects the active recording."
    )]
    async fn recording_status(
        &self,
        Parameters(request): Parameters<RecordingRequest>,
    ) -> Result<CallToolResult, McpError> {
        let state = crate::media::recording_status(request.recording_id.as_deref())
            .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        json_tool_result(&state)
    }

    /// Stop and finalize an active recording.
    #[tool(
        description = "Idempotently stop and begin finalizing a durable recording. Omitting recording_id selects the active recording."
    )]
    async fn stop_recording(
        &self,
        Parameters(request): Parameters<RecordingRequest>,
    ) -> Result<CallToolResult, McpError> {
        let state = crate::media::stop_recording(request.recording_id.as_deref())
            .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        json_tool_result(&state)
    }

    /// Wait for a recording to finish.
    #[tool(
        description = "Wait for a durable recording to complete or fail. The recording continues if this call is cancelled."
    )]
    async fn wait_for_recording(
        &self,
        Parameters(request): Parameters<WaitForRecordingRequest>,
    ) -> Result<CallToolResult, McpError> {
        let state = crate::media::wait_for_recording(
            &request.recording_id,
            request.timeout_seconds.unwrap_or(0),
        )
        .await
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        json_tool_result(&state)
    }

    /// Validate and inspect MP4 media.
    #[tool(
        description = "Validate MP4/H.264 media and return dimensions, duration, audio presence, byte size, and SHA-256."
    )]
    async fn inspect_media(
        &self,
        Parameters(request): Parameters<MediaRequest>,
    ) -> Result<CallToolResult, McpError> {
        let info = crate::media::inspect_media(Path::new(&request.media_path))
            .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        json_tool_result(&info)
    }

    /// Extract a representative poster frame.
    #[tool(description = "Extract a representative PNG poster frame from MP4/H.264 media.")]
    async fn extract_poster(
        &self,
        Parameters(request): Parameters<MediaRequest>,
    ) -> Result<CallToolResult, McpError> {
        let path = crate::media::poster_frame(Path::new(&request.media_path), None)
            .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        json_tool_result(&serde_json::json!({"file":path,"contentType":"image/png"}))
    }

    /// Transcribe media on-device where supported.
    #[tool(
        description = "Request an on-device timed transcript for media. Returns an explicit unavailable result when this build cannot transcribe."
    )]
    async fn transcribe_media(
        &self,
        Parameters(request): Parameters<TranscribeMediaRequest>,
    ) -> Result<CallToolResult, McpError> {
        crate::media::inspect_media(Path::new(&request.media_path))
            .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        json_tool_result(&serde_json::json!({
            "status":"unavailable",
            "source":"none",
            "locale":request.locale,
            "text":"",
            "segments":[],
            "error":"On-device transcription is unavailable in this build; preserve the media and retry on a Nib Apple client"
        }))
    }

    /// Wait for a durable request. Cancelling the MCP task stops this waiter;
    /// the portal request remains available and can be resumed by ID.
    #[tool(
        description = "Wait for a durable Nib request to receive its final response. This tool must run as an MCP task. Cancelling the task stops only this waiter; call it again with the same request ID to resume.",
        execution(task_support = "required")
    )]
    async fn wait_for_request(
        &self,
        Parameters(request): Parameters<WaitForRequestRequest>,
    ) -> Result<CallToolResult, McpError> {
        let response = crate::cli::web_feedback::wait_for_request(&request.request_id, 0)
            .await
            .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        let json = serde_json::to_string(&response)
            .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::text(json)]))
    }

    /// Add an annotation to an image
    #[tool(
        description = "Add an annotation to an image. Supports: arrow, rectangle, text, number, ellipse, line, highlight, blur. Returns the annotation ID."
    )]
    async fn add_annotation(
        &self,
        Parameters(request): Parameters<AddAnnotationRequest>,
    ) -> Result<CallToolResult, McpError> {
        let image_path = PathBuf::from(&request.image_path);

        if !image_path.exists() {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Error: File not found: {}",
                request.image_path
            ))]));
        }

        let annotations_path = annotations_file_path(&image_path);

        // Load existing annotations or create empty file
        let mut annotations_file = if annotations_path.exists() {
            let json_content = std::fs::read_to_string(&annotations_path).map_err(|e| {
                McpError::internal_error(format!("Failed to read annotations: {}", e), None)
            })?;
            serde_json::from_str::<AnnotationsFile>(&json_content)
                .unwrap_or_else(|_| AnnotationsFile::new(&request.image_path, Vec::new()))
        } else {
            AnnotationsFile::new(&request.image_path, Vec::new())
        };

        // Determine next annotation ID (a1, a2, etc.)
        let next_id = annotations_file
            .annotations
            .iter()
            .filter_map(|a| a.id.strip_prefix('a').and_then(|n| n.parse::<u32>().ok()))
            .max()
            .unwrap_or(0)
            + 1;

        let annotation_id = format!("a{}", next_id);

        // Parse color
        let color = request
            .color
            .clone()
            .unwrap_or_else(|| "#ff0000".to_string());

        // Create geometry based on annotation type
        let geometry = match request.annotation_type.as_str() {
            "rectangle" | "highlight" | "blur" | "crop" => {
                let width = request.width.unwrap_or(100.0);
                let height = request.height.unwrap_or(50.0);
                AnnotationGeometry::Rectangle {
                    x: request.x,
                    y: request.y,
                    width,
                    height,
                }
            }
            "arrow" | "line" => {
                let end_x = request.end_x.unwrap_or(request.x + 100.0);
                let end_y = request.end_y.unwrap_or(request.y);
                AnnotationGeometry::Line {
                    start_x: request.x,
                    start_y: request.y,
                    end_x,
                    end_y,
                }
            }
            "ellipse" => {
                let width = request.width.unwrap_or(100.0);
                let height = request.height.unwrap_or(100.0);
                AnnotationGeometry::Ellipse {
                    center_x: request.x + width / 2.0,
                    center_y: request.y + height / 2.0,
                    radius_x: width / 2.0,
                    radius_y: height / 2.0,
                }
            }
            "text" => AnnotationGeometry::Point {
                x: request.x,
                y: request.y,
                value: None,
                content: Some(request.text.clone().unwrap_or_else(|| "Text".to_string())),
            },
            "number" => AnnotationGeometry::Point {
                x: request.x,
                y: request.y,
                value: Some(request.number.unwrap_or(next_id)),
                content: None,
            },
            _ => {
                return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                    "Error: Unknown annotation type '{}'. Valid types: rectangle, arrow, line, ellipse, highlight, blur, text, number",
                    request.annotation_type
                ))]));
            }
        };

        // Create serialized annotation
        let annotation = SerializedAnnotation {
            id: annotation_id.clone(),
            annotation_type: request.annotation_type.clone(),
            geometry,
            color,
            style: nib_serde::SerializedStyle {
                stroke_width: request.stroke_width,
                font_size: request.font_size,
                ..Default::default()
            },
        };

        annotations_file.annotations.push(annotation);

        // Write back to file
        let json = serde_json::to_string_pretty(&annotations_file)
            .map_err(|e| McpError::internal_error(format!("Failed to serialize: {}", e), None))?;
        std::fs::write(&annotations_path, json)
            .map_err(|e| McpError::internal_error(format!("Failed to write: {}", e), None))?;

        // Emit event for GUI notification
        let timestamp = crate::events::timestamp_ms();
        let result_text = format!(
            "[NIB {}] claude added [{}] {} at ({}, {})",
            timestamp, annotation_id, request.annotation_type, request.x, request.y
        );

        Ok(CallToolResult::success(vec![ContentBlock::text(
            result_text,
        )]))
    }

    /// Read all annotations from an image
    #[tool(
        description = "Read all annotations from an image. Returns a list of annotations with their IDs, types, positions, and colors."
    )]
    async fn read_annotations(
        &self,
        Parameters(request): Parameters<ReadAnnotationsRequest>,
    ) -> Result<CallToolResult, McpError> {
        let image_path = PathBuf::from(&request.image_path);

        if !image_path.exists() {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Error: File not found: {}",
                request.image_path
            ))]));
        }

        let annotations_path = annotations_file_path(&image_path);

        if !annotations_path.exists() {
            return Ok(CallToolResult::success(vec![ContentBlock::text(
                "No annotations found for this image.",
            )]));
        }

        let json_content = std::fs::read_to_string(&annotations_path)
            .map_err(|e| McpError::internal_error(format!("Failed to read: {}", e), None))?;

        let annotations_file: AnnotationsFile = serde_json::from_str(&json_content)
            .map_err(|e| McpError::internal_error(format!("Failed to parse: {}", e), None))?;

        if annotations_file.annotations.is_empty() {
            return Ok(CallToolResult::success(vec![ContentBlock::text(
                "No annotations found.",
            )]));
        }

        // Format annotations for output
        let mut output = format!(
            "Found {} annotation(s):\n\n",
            annotations_file.annotations.len()
        );

        for ann in &annotations_file.annotations {
            let position = match &ann.geometry {
                AnnotationGeometry::Rectangle {
                    x,
                    y,
                    width,
                    height,
                } => {
                    format!("position: ({}, {}), size: {}x{}", x, y, width, height)
                }
                AnnotationGeometry::Line {
                    start_x,
                    start_y,
                    end_x,
                    end_y,
                } => {
                    format!("from ({}, {}) to ({}, {})", start_x, start_y, end_x, end_y)
                }
                AnnotationGeometry::Ellipse {
                    center_x,
                    center_y,
                    radius_x,
                    radius_y,
                } => {
                    format!(
                        "center: ({}, {}), radius: {}x{}",
                        center_x, center_y, radius_x, radius_y
                    )
                }
                AnnotationGeometry::Point {
                    x,
                    y,
                    value,
                    content,
                } => {
                    let extra = match (value, content) {
                        (Some(v), _) => format!(", value: {}", v),
                        (_, Some(c)) => format!(", text: \"{}\"", c),
                        _ => String::new(),
                    };
                    format!("position: ({}, {}){}", x, y, extra)
                }
                AnnotationGeometry::Path { points } => {
                    format!("{} points", points.len())
                }
            };

            output.push_str(&format!(
                "- [{}] {} (color: {}) - {}\n",
                ann.id, ann.annotation_type, ann.color, position
            ));
        }

        Ok(CallToolResult::success(vec![ContentBlock::text(output)]))
    }

    /// Remove a specific annotation by ID
    #[tool(description = "Remove a specific annotation by its ID (e.g., 'a1', 'a2').")]
    async fn remove_annotation(
        &self,
        Parameters(request): Parameters<RemoveAnnotationRequest>,
    ) -> Result<CallToolResult, McpError> {
        let image_path = PathBuf::from(&request.image_path);

        if !image_path.exists() {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Error: File not found: {}",
                request.image_path
            ))]));
        }

        let annotations_path = annotations_file_path(&image_path);

        if !annotations_path.exists() {
            return Ok(CallToolResult::error(vec![ContentBlock::text(
                "Error: No annotations file found.",
            )]));
        }

        let json_content = std::fs::read_to_string(&annotations_path)
            .map_err(|e| McpError::internal_error(format!("Failed to read: {}", e), None))?;

        let mut annotations_file: AnnotationsFile = serde_json::from_str(&json_content)
            .map_err(|e| McpError::internal_error(format!("Failed to parse: {}", e), None))?;

        let original_count = annotations_file.annotations.len();
        annotations_file
            .annotations
            .retain(|a| a.id != request.annotation_id);

        if annotations_file.annotations.len() == original_count {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Error: Annotation '{}' not found.",
                request.annotation_id
            ))]));
        }

        // Write back to file
        let json = serde_json::to_string_pretty(&annotations_file)
            .map_err(|e| McpError::internal_error(format!("Failed to serialize: {}", e), None))?;
        std::fs::write(&annotations_path, json)
            .map_err(|e| McpError::internal_error(format!("Failed to write: {}", e), None))?;

        let timestamp = crate::events::timestamp_ms();
        Ok(CallToolResult::success(vec![ContentBlock::text(format!(
            "[NIB {}] claude removed [{}]. Remaining: {} annotation(s).",
            timestamp,
            request.annotation_id,
            annotations_file.annotations.len()
        ))]))
    }

    /// Clear all annotations from an image
    #[tool(description = "Clear all annotations from an image.")]
    async fn clear_annotations(
        &self,
        Parameters(request): Parameters<ClearAnnotationsRequest>,
    ) -> Result<CallToolResult, McpError> {
        let image_path = PathBuf::from(&request.image_path);

        if !image_path.exists() {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Error: File not found: {}",
                request.image_path
            ))]));
        }

        let annotations_path = annotations_file_path(&image_path);

        let removed_count = if annotations_path.exists() {
            let json_content = std::fs::read_to_string(&annotations_path).ok();
            json_content
                .and_then(|c| serde_json::from_str::<AnnotationsFile>(&c).ok())
                .map(|f| f.annotations.len())
                .unwrap_or(0)
        } else {
            0
        };

        // Create empty annotations file
        let empty_file = AnnotationsFile::new(&request.image_path, Vec::new());
        let json = serde_json::to_string_pretty(&empty_file)
            .map_err(|e| McpError::internal_error(format!("Failed to serialize: {}", e), None))?;
        std::fs::write(&annotations_path, json)
            .map_err(|e| McpError::internal_error(format!("Failed to write: {}", e), None))?;

        let timestamp = crate::events::timestamp_ms();
        Ok(CallToolResult::success(vec![ContentBlock::text(format!(
            "[NIB {}] claude cleared {} annotation(s).",
            timestamp, removed_count
        ))]))
    }

    /// Render annotations onto image
    #[tool(
        description = "Render annotations onto the image, creating a new file with annotations baked in. Output defaults to {stem}.rendered.{ext}."
    )]
    async fn render(
        &self,
        Parameters(request): Parameters<RenderRequest>,
    ) -> Result<CallToolResult, McpError> {
        let image_path = PathBuf::from(&request.image_path);

        if !image_path.exists() {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Error: File not found: {}",
                request.image_path
            ))]));
        }

        let annotations_path = annotations_file_path(&image_path);

        // Load annotations
        let annotations: Vec<crate::core::Annotation> = if annotations_path.exists() {
            let json_content = std::fs::read_to_string(&annotations_path)
                .map_err(|e| McpError::internal_error(format!("Failed to read: {}", e), None))?;
            match serde_json::from_str::<AnnotationsFile>(&json_content) {
                Ok(file) => file
                    .annotations
                    .iter()
                    .filter_map(deserialize_annotation)
                    .collect(),
                Err(_) => Vec::new(),
            }
        } else {
            Vec::new()
        };

        // Load the base image
        let image_data = std::fs::read(&image_path)
            .map_err(|e| McpError::internal_error(format!("Failed to read image: {}", e), None))?;
        let img = image::load_from_memory(&image_data).map_err(|e| {
            McpError::internal_error(format!("Failed to decode image: {}", e), None)
        })?;

        // Create NibImage with annotations
        let nib_image = NibImage {
            image_data,
            width: img.width(),
            height: img.height(),
            source: ImageSource::File(image_path.clone()),
            annotations,
            assets: std::collections::HashMap::new(),
            title: None,
            description: None,
            tags: Vec::new(),
            file_path: Some(image_path.clone()),
            created_at: SystemTime::now(),
            modified_at: SystemTime::now(),
        };

        // Determine output path
        let output_path = request.output_path.map(PathBuf::from).unwrap_or_else(|| {
            let stem = image_path.file_stem().unwrap_or_default().to_string_lossy();
            let ext = image_path.extension().unwrap_or_default().to_string_lossy();
            image_path.with_file_name(format!("{}.rendered.{}", stem, ext))
        });

        // Export with baked annotations
        let options = export::ExportOptions {
            bake_annotations: true,
            ..Default::default()
        };
        export::export_image(&nib_image, &output_path, &options)
            .map_err(|e| McpError::internal_error(format!("Failed to export: {}", e), None))?;

        let timestamp = crate::events::timestamp_ms();
        Ok(CallToolResult::success(vec![ContentBlock::text(format!(
            "[NIB {}] Rendered {} annotation(s) to: {}",
            timestamp,
            nib_image.annotations.len(),
            output_path.display()
        ))]))
    }

    /// Wait for annotation events from the human
    #[tool(
        description = "Wait for the human to add, modify, or delete annotations. Blocks until events occur or timeout. Use since_seq from previous response to avoid duplicate events."
    )]
    async fn wait_for_events(
        &self,
        Parameters(request): Parameters<WaitForEventsRequest>,
    ) -> Result<CallToolResult, McpError> {
        let image_path = PathBuf::from(&request.image_path);

        if !image_path.exists() {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Error: File not found: {}",
                request.image_path
            ))]));
        }

        let timeout_ms = request.timeout_ms.unwrap_or(30000);
        let since_seq = request.since_seq.unwrap_or(0);
        let timeout = Duration::from_millis(timeout_ms);

        // Get or create watcher
        let mut watcher_guard = self.watcher.lock().await;
        let watcher = match watcher_guard.as_mut() {
            Some(w) => w,
            None => {
                // Try to create watcher
                match AnnotationWatcher::new() {
                    Ok(w) => {
                        *watcher_guard = Some(w);
                        watcher_guard.as_mut().unwrap()
                    }
                    Err(e) => {
                        return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                            "Error: Failed to create file watcher: {}",
                            e
                        ))]));
                    }
                }
            }
        };

        // Initialize store and start watching
        watcher.init_store(&image_path).await;
        if let Err(e) = watcher.watch(&image_path) {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Error: Failed to watch file: {}",
                e
            ))]));
        }

        // Drop the lock before waiting
        let current_seq = watcher.current_seq();
        drop(watcher_guard);

        // Wait for events (need to reacquire lock)
        let watcher_guard = self.watcher.lock().await;
        let (events, reason) = if let Some(watcher) = watcher_guard.as_ref() {
            watcher
                .wait_for_events(&image_path, timeout, since_seq)
                .await
        } else {
            (Vec::new(), "timeout".to_string())
        };
        drop(watcher_guard);

        // Build result
        let result = WaitForEventsResult {
            seq: if events.is_empty() {
                current_seq
            } else {
                events.last().map(|e| e.seq).unwrap_or(current_seq)
            },
            events,
            reason,
        };

        let json = serde_json::to_string_pretty(&result)
            .map_err(|e| McpError::internal_error(format!("Failed to serialize: {}", e), None))?;

        Ok(CallToolResult::success(vec![ContentBlock::text(json)]))
    }

    /// Generate an image via the configured generator (default: imago)
    #[tool(
        description = "Generate an image via the configured generator (default: imago). Shells out and can take 12+ minutes to return; never fabricates success — a non-zero exit from the generator surfaces as a tool error. Returns the generator's JSON result envelope."
    )]
    async fn generate_image(
        &self,
        Parameters(request): Parameters<GenerateImageRequest>,
    ) -> Result<CallToolResult, McpError> {
        let config = crate::config::load();

        let out_path = request
            .out
            .map(PathBuf::from)
            .unwrap_or_else(crate::external::default_output_path);

        if let Some(parent) = out_path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                    "Error: Failed to create output directory: {}",
                    e
                ))]));
            }
        }

        let references: Vec<PathBuf> = request
            .refs
            .unwrap_or_default()
            .into_iter()
            .map(PathBuf::from)
            .collect();

        let generate_request = crate::external::GenerateRequest {
            prompt: &request.prompt,
            width: request.width,
            height: request.height,
            out: &out_path,
            references: &references,
            crop: request.crop.unwrap_or(false),
            timeout: request.timeout.as_deref(),
        };

        match crate::external::generate(&config, &generate_request) {
            Ok(result) => {
                let json = serde_json::to_string(&result).map_err(|e| {
                    McpError::internal_error(format!("Failed to serialize: {}", e), None)
                })?;
                Ok(CallToolResult::success(vec![ContentBlock::text(json)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Error: {}",
                e
            ))])),
        }
    }

    /// Judge a pair of images via the configured judge tool (default: imago compare)
    #[tool(
        description = "Compare an expected and actual image via the configured judge tool (default: imago compare). Returns the judge's JSON verdict envelope (verdict: READY or BLOCKED, plus blockers/polish/review)."
    )]
    async fn judge_pair(
        &self,
        Parameters(request): Parameters<JudgePairRequest>,
    ) -> Result<CallToolResult, McpError> {
        let config = crate::config::load();

        let judge_request = crate::external::JudgeRequest {
            expected: &PathBuf::from(&request.expected),
            actual: &PathBuf::from(&request.actual),
            timeout: request.timeout.as_deref(),
            open: request.open.unwrap_or(false),
        };

        match crate::external::judge(&config, &judge_request) {
            Ok(result) => {
                let json = serde_json::to_string(&result).map_err(|e| {
                    McpError::internal_error(format!("Failed to serialize: {}", e), None)
                })?;
                Ok(CallToolResult::success(vec![ContentBlock::text(json)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Error: {}",
                e
            ))])),
        }
    }
}

fn present_image_prompt(question: &str, image_path: &Path, reserve_terminal_rows: bool) -> String {
    let reserved_rows = if reserve_terminal_rows {
        "\n".repeat(nib_tui::CODEX_INLINE_RESERVED_ROWS)
    } else {
        String::new()
    };
    format!(
        "{reserved_rows}{question}\n\nReply in this Codex thread with approval, rejection, or specific corrections.\nSource: {}",
        image_path.display()
    )
}

fn terminal_png(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let image = image::load_from_memory(bytes).map_err(|e| e.to_string())?;
    let (width, height) = (image.width(), image.height());
    let mut png = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok((png, width, height))
}

fn inline_image_content(image_path: &Path) -> Result<(Vec<u8>, String), String> {
    let is_nib = image_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("nib"));

    let (bytes, mime_type) = if is_nib {
        let nib = NibFile::open(image_path).map_err(|e| e.to_string())?;
        let (image_data, info) = nib.get_image().map_err(|e| e.to_string())?;
        let image = NibImage {
            image_data,
            width: info.width,
            height: info.height,
            source: ImageSource::File(image_path.to_path_buf()),
            annotations: nib.list_annotations().map_err(|e| e.to_string())?,
            assets: nib.get_all_assets().map_err(|e| e.to_string())?,
            title: None,
            description: None,
            tags: Vec::new(),
            file_path: Some(image_path.to_path_buf()),
            created_at: SystemTime::now(),
            modified_at: SystemTime::now(),
        };
        (
            encode_composited_png(&image, &ExportOptions::default()).map_err(|e| e.to_string())?,
            "image/png".to_string(),
        )
    } else {
        let bytes = std::fs::read(image_path).map_err(|e| e.to_string())?;
        let format = image::guess_format(&bytes).map_err(|e| e.to_string())?;
        let mime_type = match format {
            image::ImageFormat::Png => "image/png",
            image::ImageFormat::Jpeg => "image/jpeg",
            image::ImageFormat::WebP => "image/webp",
            _ => return Err("Unsupported image format; use PNG, JPEG, WebP, or .nib".into()),
        };
        (bytes, mime_type.to_string())
    };

    Ok((bytes, mime_type))
}

fn json_tool_result(value: &impl serde::Serialize) -> Result<CallToolResult, McpError> {
    let json = serde_json::to_string(value)
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
    Ok(CallToolResult::success(vec![ContentBlock::text(json)]))
}

/// Instructions advertised to connecting clients. Code Mode leads: one JavaScript
/// program composing several primitives beats the same work chained as single
/// tool calls. When Code Mode fails to initialize its tools are not listed, so
/// the text must not advertise them.
fn server_instructions(code_mode_available: bool) -> String {
    let mut instructions = String::from("Nib MCP Server - Visual communication for Codex.\n\n");

    if code_mode_available {
        instructions.push_str(
            "PRIMARY INTERFACE: Code Mode. Compose Nib primitives in JavaScript through codemode_execute instead of chaining one direct tool call at a time. Exchange paths and IDs, never media bytes. Executions, snippets, and artifacts persist in Nib's local storage, so an execution survives an MCP restart and can be resumed by ID.\n\n\
            Code Mode lifecycle:\n\
            - codemode_search: Discover the composable Nib methods and saved snippets. Call this first; it is the authoritative list.\n\
            - codemode_execute: Run a JavaScript program over those methods and return its durable execution state\n\
            - codemode_execution: Read an execution, or one oversized artifact it owns, by ID\n\
            - codemode_decide: Approve or reject one pending Code Mode action\n\
            - codemode_cancel: Cancel one running or paused Code Mode execution\n\n\
            Collaboration Workflow - prefer one codemode_execute program per round trip:\n\
            1. Capture, annotate, render, and publish inside a single program: create_review_request for an image or MP4/H.264 media. Retain the returned request ID.\n\
            2. Await the human verdict with wait_for_request, resuming the same request ID after any restart; never create a replacement request.\n\
            3. For canvas annotation loops, add annotations and render, then wait on events; pass since_seq from each response to avoid duplicates.\n\
            4. Drop to a direct tool call only for a genuine one-off, or for a tool marked MCP-native below.\n\n\
            Direct tools (one-off calls; most are also reachable inside a Code Mode program):\n",
        );
    } else {
        instructions.push_str(
            "Code Mode is unavailable in this session; use the direct tools below.\n\n\
            Tools:\n",
        );
    }

    instructions.push_str(
        "- present_image: MCP-native, direct only. Display an image inline in Codex and ask for thread-native feedback; the image is returned as first-class inline MCP content, so treat the user's next message in the same thread as the response. Codex CLI terminals may also receive a lossless inline rendering fallback. Do not substitute local file links.\n\
        - wait_for_request: MCP-native. Task-backed wait for the final response; resume with the same request ID\n\
        - create_feedback_request: Publish a durable visual request and return its request ID\n\
        - create_review_request: Publish an image or MP4/H.264 review through the generic media contract\n\
        - start_recording / recording_status / stop_recording / wait_for_recording: Durable macOS screen recording\n\
        - inspect_media / extract_poster / transcribe_media: Media validation and derivation\n\
        - add_annotation: Add arrow, rectangle, text, number, ellipse, line, highlight, or blur\n\
        - read_annotations: List all annotations on an image\n\
        - remove_annotation: Remove an annotation by ID (e.g., 'a1')\n\
        - clear_annotations: Remove all annotations\n\
        - render: Bake annotations onto image for viewing\n\
        - wait_for_events: Block until human adds annotations (or timeout)\n\
        - generate_image: Generate an image via the configured generator (default: imago)\n\
        - judge_pair: Compare expected vs actual images via the configured judge tool (default: imago compare)",
    );

    if !code_mode_available {
        instructions.push_str(
            "\n\nCollaboration Workflow:\n\
            1. For thread-native review, call present_image and wait for the next user message\n\
            2. For durable cross-device review, call create_feedback_request, retain its request ID, then call wait_for_request as a task\n\
            3. For canvas annotation workflows, use add_annotation/render and wait_for_events\n\
            4. Use since_seq from event responses to avoid duplicates",
        );
    }

    instructions
}

/// Build the Incurs catalog and the Code Mode server that composes it. Code Mode
/// is the primary interface, so a failed initialization is logged rather than
/// discarded silently; the server then degrades to direct tools only.
fn build_catalog_and_code_mode() -> (Option<ToolCatalog>, Option<CodeModeMcpServer>) {
    let catalog = crate::cli::build_cli().try_tool_catalog().ok();
    let code_mode = catalog.clone().and_then(|catalog| {
        build_code_mode_server(catalog)
            .inspect_err(|error| {
                tracing::warn!(
                    "Incurs Code Mode unavailable, falling back to direct tools: {error}"
                );
            })
            .ok()
    });
    (catalog, code_mode)
}

fn build_code_mode_server(catalog: ToolCatalog) -> Result<CodeModeMcpServer, String> {
    let root = crate::storage::storage_dir().join("codemode");
    let runtime = Arc::new(crate::codemode_store::FileRuntimeStore::new(root.clone())?);
    let artifacts = Arc::new(crate::codemode_store::FileArtifactStore::new(
        root.join("artifacts"),
    )?);
    let service = LocalCodeModeService::spawn(move || {
        CodeMode::with_artifact_store(
            runtime,
            artifacts,
            LocalExecutor::default(),
            vec![Arc::new(
                IncurConnector::new(catalog)
                    .with_name("nib")
                    .with_instructions("Compose Nib capture, review, and durable human-request primitives. Exchange paths and IDs instead of media bytes."),
            )],
        )
    })?;
    Ok(CodeModeMcpServer::new(Arc::new(service)))
}

fn incurs_mcp_tool(definition: &ToolDefinition) -> Tool {
    let input_schema = definition
        .input_schema
        .as_object()
        .cloned()
        .unwrap_or_default();
    let mut tool = Tool::new(
        Cow::Owned(definition.name.clone()),
        Cow::Owned(definition.description.clone()),
        Arc::new(input_schema),
    );
    tool.output_schema = definition
        .output_schema
        .as_ref()
        .and_then(serde_json::Value::as_object)
        .cloned()
        .map(Arc::new);
    tool.annotations = definition.annotations.as_ref().map(|annotations| {
        ToolAnnotations::from_raw(
            annotations.title.clone(),
            annotations.read_only_hint,
            annotations.destructive_hint,
            annotations.idempotent_hint,
            annotations.open_world_hint,
        )
    });
    tool
}

async fn call_incurs_tool(
    catalog: &ToolCatalog,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    let arguments = request
        .arguments
        .clone()
        .unwrap_or_default()
        .into_iter()
        .collect::<BTreeMap<_, _>>();
    match catalog
        .call(
            request.name.as_ref(),
            arguments,
            ToolCallOptions::isolated(),
        )
        .await
    {
        ToolCallOutcome::Ok { data, cta } => json_tool_result(&serde_json::json!({
            "data": data,
            "cta": cta
        })),
        ToolCallOutcome::Error {
            code,
            message,
            retryable,
            field_errors,
            exit_code,
            cta,
        } => Ok(CallToolResult::error(vec![ContentBlock::text(
            serde_json::json!({
                "code": code,
                "message": message,
                "retryable": retryable,
                "fieldErrors": field_errors,
                "exitCode": exit_code,
                "cta": cta
            })
            .to_string(),
        )])),
    }
}

impl Default for NibMcpServer {
    fn default() -> Self {
        Self::new()
    }
}

#[task_handler]
impl ServerHandler for NibMcpServer {
    async fn enqueue_task(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CreateTaskResult, McpError> {
        use rmcp::task_manager::{
            OperationDescriptor, OperationMessage, OperationResultTransport, ToolCallTaskResult,
        };

        let task_id = context.id.to_string();
        let operation_name = request.name.to_string();
        let future_request = request.clone();
        let future_context = context.clone();
        let server = self.clone();
        let descriptor = OperationDescriptor::new(task_id.clone(), operation_name)
            .with_context(context)
            .with_client_request(ClientRequest::CallToolRequest(Request::new(request)))
            .with_ttl(REQUEST_TASK_TTL_MS);
        let task_result_id = task_id.clone();
        let future = Box::pin(async move {
            let result = server.call_tool(future_request, future_context).await;
            Ok(Box::new(ToolCallTaskResult::new(task_result_id, result))
                as Box<dyn OperationResultTransport>)
        });

        self.processor
            .lock()
            .await
            .submit_operation(OperationMessage::new(descriptor, future))
            .map_err(|error| {
                McpError::internal_error(format!("failed to enqueue task: {error}"), None)
            })?;

        let task = request_task(
            task_id,
            TaskStatus::Working,
            Some("Waiting for a durable Nib request response"),
        );
        Ok(CreateTaskResult::new(task))
    }

    async fn list_tasks(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListTasksResult, McpError> {
        let mut processor = self.processor.lock().await;
        let mut tasks = processor
            .list_running()
            .into_iter()
            .map(|task_id| request_task(task_id, TaskStatus::Working, None))
            .collect::<Vec<_>>();
        tasks.extend(processor.peek_completed().iter().map(|result| {
            request_task(
                result.descriptor.operation_id.clone(),
                completed_task_status(result),
                None,
            )
        }));
        Ok(ListTasksResult::new(tasks))
    }

    async fn get_task_info(
        &self,
        request: GetTaskParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<GetTaskResult, McpError> {
        let mut processor = self.processor.lock().await;
        if let Some(result) = processor
            .peek_completed()
            .iter()
            .rev()
            .find(|result| result.descriptor.operation_id == request.task_id)
        {
            return Ok(GetTaskResult::new(request_task(
                request.task_id,
                completed_task_status(result),
                None,
            )));
        }
        if processor
            .list_running()
            .iter()
            .any(|task_id| task_id == &request.task_id)
        {
            return Ok(GetTaskResult::new(request_task(
                request.task_id,
                TaskStatus::Working,
                None,
            )));
        }
        Err(McpError::resource_not_found(
            format!("task not found: {}", request.task_id),
            None,
        ))
    }

    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_tasks()
                .build(),
        )
        .with_server_info(Implementation::new("nib", env!("CARGO_PKG_VERSION")))
        .with_instructions(server_instructions(self.code_mode.is_some()))
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        // Code Mode is the primary interface, so it leads the list.
        let mut tools = Vec::new();
        let mut names = HashSet::new();
        if let Some(code_mode) = &self.code_mode {
            for tool in code_mode.tools() {
                names.insert(tool.name.to_string());
                tools.push(tool.clone());
            }
        }
        for tool in self.tool_router.list_all() {
            names.insert(tool.name.to_string());
            tools.push(tool);
        }
        if let Some(catalog) = &self.catalog {
            for definition in catalog.definitions() {
                if names.insert(definition.name.clone()) {
                    tools.push(incurs_mcp_tool(&definition));
                }
            }
        }
        Ok(ListToolsResult {
            tools,
            next_cursor: None,
            meta: None,
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        if CODE_MODE_TOOL_NAMES.contains(&request.name.as_ref()) {
            let code_mode = self.code_mode.as_ref().ok_or_else(|| {
                McpError::internal_error("Incurs Code Mode failed to initialize", None)
            })?;
            return code_mode.call_tool(request, context).await;
        }
        let has_direct_tool = self
            .tool_router
            .list_all()
            .iter()
            .any(|tool| tool.name == request.name);
        if !has_direct_tool {
            if let Some(catalog) = &self.catalog {
                if catalog.get(request.name.as_ref()).is_some() {
                    return call_incurs_tool(catalog, &request).await;
                }
            }
        }
        let tool_context = ToolCallContext::new(self, request, context);
        self.tool_router.call(tool_context).await
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.tool_router
            .list_all()
            .into_iter()
            .find(|tool| tool.name == name)
            .or_else(|| {
                self.code_mode
                    .as_ref()
                    .and_then(|server| server.get_tool(name))
            })
            .or_else(|| {
                self.catalog
                    .as_ref()
                    .and_then(|catalog| catalog.get(name))
                    .map(incurs_mcp_tool)
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::ClientHandler;

    #[test]
    fn inline_png_is_returned_byte_identical() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("sample.png");
        let image = image::RgbaImage::from_pixel(2, 1, image::Rgba([1, 2, 3, 255]));
        image.save(&path).unwrap();
        let expected = std::fs::read(&path).unwrap();

        let (data, mime_type) = inline_image_content(&path).unwrap();
        assert_eq!(mime_type, "image/png");
        assert_eq!(data, expected);
    }

    #[test]
    fn terminal_prompt_reserves_exact_image_rows_before_the_question() {
        let prompt = present_image_prompt("Visible?", Path::new("/tmp/image.png"), true);
        assert!(prompt.starts_with(&"\n".repeat(nib_tui::CODEX_INLINE_RESERVED_ROWS)));
        assert!(prompt.contains("Visible?\n\nReply in this Codex thread"));
    }

    #[test]
    fn present_image_is_registered() {
        assert!(NibMcpServer::new()
            .tool_router
            .list_all()
            .iter()
            .any(|tool| tool.name == "present_image"));
    }

    #[test]
    fn durable_request_tools_are_registered_with_task_contracts() {
        let server = NibMcpServer::new();
        let tools = server.tool_router.list_all();
        let create = tools
            .iter()
            .find(|tool| tool.name == "create_feedback_request")
            .unwrap();
        let wait = tools
            .iter()
            .find(|tool| tool.name == "wait_for_request")
            .unwrap();
        assert_eq!(create.task_support(), TaskSupport::Forbidden);
        assert_eq!(wait.task_support(), TaskSupport::Required);
        assert!(server.get_info().capabilities.tasks.is_some());
    }

    #[test]
    fn combined_server_includes_incurs_code_mode_and_media_primitives() {
        let server = NibMcpServer::new();
        let direct = server.tool_router.list_all();
        assert!(direct.iter().any(|tool| tool.name == "start_recording"));
        assert!(direct
            .iter()
            .any(|tool| tool.name == "create_review_request"));
        let code_mode = server.code_mode.as_ref().expect("Code Mode initializes");
        let names = code_mode
            .tools()
            .iter()
            .map(|tool| tool.name.as_ref())
            .collect::<Vec<_>>();
        for expected in CODE_MODE_TOOL_NAMES {
            assert!(names.contains(&expected));
        }
        assert!(
            server.get_tool("capture").is_some(),
            "catalog-only Incurs commands must be exposed through the combined MCP server"
        );
    }

    #[test]
    fn instructions_lead_with_code_mode() {
        let instructions = server_instructions(true);
        let code_mode = instructions
            .find("Code Mode")
            .expect("Code Mode is named in the instructions");
        let direct = instructions
            .find("present_image")
            .expect("direct tools are still documented");
        assert!(
            code_mode < direct,
            "Code Mode must be presented before any direct tool"
        );
        assert!(instructions.contains("PRIMARY INTERFACE: Code Mode"));
        for name in CODE_MODE_TOOL_NAMES {
            assert!(instructions.contains(name), "instructions must name {name}");
        }
    }

    #[test]
    fn instructions_omit_code_mode_when_unavailable() {
        let instructions = server_instructions(false);
        assert!(
            !instructions.contains("codemode_"),
            "unavailable Code Mode tools must not be advertised"
        );
        assert!(instructions.contains("present_image"));
        assert!(instructions.contains("Collaboration Workflow"));
    }

    #[test]
    fn server_advertises_code_mode_instructions() {
        let server = NibMcpServer::new();
        let info = server.get_info();
        let instructions = info.instructions.expect("instructions are advertised");
        assert!(instructions.contains("PRIMARY INTERFACE: Code Mode"));
    }

    #[derive(Clone, Default)]
    struct TestClient;

    impl ClientHandler for TestClient {}

    #[tokio::test]
    async fn combined_transport_lists_and_searches_code_mode_tools() {
        let (server_transport, client_transport) = tokio::io::duplex(64 * 1024);
        let server_handle = tokio::spawn(async move {
            NibMcpServer::new()
                .serve(server_transport)
                .await
                .unwrap()
                .waiting()
                .await
                .unwrap();
        });
        let client = TestClient.serve(client_transport).await.unwrap();
        let listed = client
            .send_request(ClientRequest::ListToolsRequest(ListToolsRequest::default()))
            .await
            .unwrap();
        let ServerResult::ListToolsResult(listed) = listed else {
            panic!("expected tool list");
        };
        assert!(listed
            .tools
            .iter()
            .any(|tool| tool.name == "start_recording"));
        let leading = listed
            .tools
            .iter()
            .take(CODE_MODE_TOOL_NAMES.len())
            .map(|tool| tool.name.to_string())
            .collect::<HashSet<_>>();
        assert_eq!(
            leading,
            CODE_MODE_TOOL_NAMES
                .iter()
                .map(|name| name.to_string())
                .collect::<HashSet<_>>(),
            "Code Mode is the primary interface and must lead the tool list"
        );
        let unique = listed
            .tools
            .iter()
            .map(|tool| tool.name.to_string())
            .collect::<HashSet<_>>();
        assert_eq!(
            unique.len(),
            listed.tools.len(),
            "reordering must not duplicate tools"
        );

        let mut arguments = JsonObject::new();
        arguments.insert("query".to_string(), serde_json::json!("recording"));
        let searched = client
            .send_request(ClientRequest::CallToolRequest(Request::new(
                CallToolRequestParams::new("codemode_search").with_arguments(arguments),
            )))
            .await
            .unwrap();
        let ServerResult::CallToolResult(searched) = searched else {
            panic!("expected Code Mode search result");
        };
        assert_ne!(searched.is_error, Some(true));
        assert!(format!("{searched:?}").contains("start_recording"));

        client.cancel().await.unwrap();
        server_handle.await.unwrap();
    }

    #[tokio::test]
    async fn durable_wait_task_can_be_listed_and_cancelled() {
        let (server_transport, client_transport) = tokio::io::duplex(16 * 1024);
        let server_handle = tokio::spawn(async move {
            NibMcpServer::new()
                .serve(server_transport)
                .await
                .unwrap()
                .waiting()
                .await
                .unwrap();
        });
        let client = TestClient.serve(client_transport).await.unwrap();
        let mut arguments = JsonObject::new();
        arguments.insert(
            "request_id".to_string(),
            serde_json::Value::String("req-cancel".to_string()),
        );
        let create = client
            .send_request(ClientRequest::CallToolRequest(Request::new(
                CallToolRequestParams::new("wait_for_request")
                    .with_arguments(arguments)
                    .with_task(TaskMetadata::new()),
            )))
            .await
            .unwrap();
        let ServerResult::CreateTaskResult(created) = create else {
            panic!("expected a task result");
        };
        assert_eq!(created.task.ttl, Some(24 * 60 * 60 * 1_000));
        assert_eq!(created.task.poll_interval, Some(1_500));

        let listed = client
            .send_request(ClientRequest::ListTasksRequest(ListTasksRequest::default()))
            .await
            .unwrap();
        let ServerResult::ListTasksResult(listed) = listed else {
            panic!("expected task list");
        };
        assert!(listed
            .tasks
            .iter()
            .any(|task| task.task_id == created.task.task_id));

        let cancelled = client
            .send_request(ClientRequest::CancelTaskRequest(Request::new(
                CancelTaskParams::new(created.task.task_id.clone()),
            )))
            .await
            .unwrap();
        let status = match cancelled {
            ServerResult::CancelTaskResult(result) => result.task.status,
            // RMCP 2.2 deserializes the shape-identical cancellation payload
            // through GetTaskResult in its untagged ServerResult union.
            ServerResult::GetTaskResult(result) => result.task.status,
            other => panic!("expected cancelled task, got {other:?}"),
        };
        assert_eq!(status, TaskStatus::Cancelled);

        let task_info = client
            .send_request(ClientRequest::GetTaskRequest(Request::new(
                GetTaskParams::new(created.task.task_id),
            )))
            .await
            .unwrap();
        let ServerResult::GetTaskResult(task_info) = task_info else {
            panic!("expected task info");
        };
        assert_eq!(task_info.task.status, TaskStatus::Cancelled);
        assert_eq!(task_info.task.ttl, Some(REQUEST_TASK_TTL_MS));
        assert_eq!(
            task_info.task.poll_interval,
            Some(REQUEST_TASK_POLL_INTERVAL_MS)
        );

        client.cancel().await.unwrap();
        server_handle.await.unwrap();
    }
}

/// Run the MCP server over stdio
pub async fn run_mcp_server(image_path: Option<PathBuf>) -> NibResult<()> {
    let server = match image_path {
        Some(path) => NibMcpServer::with_image(path),
        None => NibMcpServer::new(),
    };

    let service = server
        .serve(stdio())
        .await
        .map_err(|e| crate::core::NibError::Other(format!("Failed to start MCP server: {}", e)))?;

    service
        .waiting()
        .await
        .map_err(|e| crate::core::NibError::Other(format!("MCP server error: {}", e)))?;

    Ok(())
}
