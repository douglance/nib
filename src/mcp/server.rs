//! MCP Server implementation for Nib
//!
//! Provides tools for Claude to interact with Nib annotations.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use rmcp::{
    handler::server::tool::{ToolCallContext, ToolRouter},
    handler::server::wrapper::Parameters,
    model::*,
    service::{RequestContext, ServiceExt},
    tool, tool_router,
    transport::stdio,
    ErrorData as McpError, RoleServer, ServerHandler,
};
use tokio::sync::Mutex;

use crate::core::{ImageSource, NibImage, Result as NibResult};
use crate::storage::export;
use crate::{
    annotations_file_path, deserialize_annotation, AnnotationGeometry, AnnotationsFile,
    SerializedAnnotation,
};

use super::tools::*;
use super::watcher::AnnotationWatcher;

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
}

#[tool_router]
impl NibMcpServer {
    pub fn new() -> Self {
        let watcher = AnnotationWatcher::new().ok();
        Self {
            current_image: Arc::new(Mutex::new(None)),
            tool_router: Self::tool_router(),
            watcher: Arc::new(Mutex::new(watcher)),
        }
    }

    pub fn with_image(image_path: PathBuf) -> Self {
        let watcher = AnnotationWatcher::new().ok();
        Self {
            current_image: Arc::new(Mutex::new(Some(image_path))),
            tool_router: Self::tool_router(),
            watcher: Arc::new(Mutex::new(watcher)),
        }
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
            return Ok(CallToolResult::error(vec![Content::text(format!(
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
                return Ok(CallToolResult::error(vec![Content::text(format!(
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

        Ok(CallToolResult::success(vec![Content::text(result_text)]))
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
            return Ok(CallToolResult::error(vec![Content::text(format!(
                "Error: File not found: {}",
                request.image_path
            ))]));
        }

        let annotations_path = annotations_file_path(&image_path);

        if !annotations_path.exists() {
            return Ok(CallToolResult::success(vec![Content::text(
                "No annotations found for this image.",
            )]));
        }

        let json_content = std::fs::read_to_string(&annotations_path)
            .map_err(|e| McpError::internal_error(format!("Failed to read: {}", e), None))?;

        let annotations_file: AnnotationsFile = serde_json::from_str(&json_content)
            .map_err(|e| McpError::internal_error(format!("Failed to parse: {}", e), None))?;

        if annotations_file.annotations.is_empty() {
            return Ok(CallToolResult::success(vec![Content::text(
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

        Ok(CallToolResult::success(vec![Content::text(output)]))
    }

    /// Remove a specific annotation by ID
    #[tool(description = "Remove a specific annotation by its ID (e.g., 'a1', 'a2').")]
    async fn remove_annotation(
        &self,
        Parameters(request): Parameters<RemoveAnnotationRequest>,
    ) -> Result<CallToolResult, McpError> {
        let image_path = PathBuf::from(&request.image_path);

        if !image_path.exists() {
            return Ok(CallToolResult::error(vec![Content::text(format!(
                "Error: File not found: {}",
                request.image_path
            ))]));
        }

        let annotations_path = annotations_file_path(&image_path);

        if !annotations_path.exists() {
            return Ok(CallToolResult::error(vec![Content::text(
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
            return Ok(CallToolResult::error(vec![Content::text(format!(
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
        Ok(CallToolResult::success(vec![Content::text(format!(
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
            return Ok(CallToolResult::error(vec![Content::text(format!(
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
        Ok(CallToolResult::success(vec![Content::text(format!(
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
            return Ok(CallToolResult::error(vec![Content::text(format!(
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
        Ok(CallToolResult::success(vec![Content::text(format!(
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
            return Ok(CallToolResult::error(vec![Content::text(format!(
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
                        return Ok(CallToolResult::error(vec![Content::text(format!(
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
            return Ok(CallToolResult::error(vec![Content::text(format!(
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

        Ok(CallToolResult::success(vec![Content::text(json)]))
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
                return Ok(CallToolResult::error(vec![Content::text(format!(
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
                Ok(CallToolResult::success(vec![Content::text(json)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(format!(
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
                Ok(CallToolResult::success(vec![Content::text(json)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(format!(
                "Error: {}",
                e
            ))])),
        }
    }
}

impl Default for NibMcpServer {
    fn default() -> Self {
        Self::new()
    }
}

impl ServerHandler for NibMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            protocol_version: ProtocolVersion::V_2024_11_05,
            capabilities: ServerCapabilities::builder()
                .enable_tools()
                .build(),
            server_info: Implementation {
                name: "nib".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                title: None,
                icons: None,
                website_url: None,
            },
            instructions: Some(
                "Nib MCP Server - Visual annotation tool for human↔AI communication.\n\n\
                Tools:\n\
                - add_annotation: Add arrow, rectangle, text, number, ellipse, line, highlight, or blur\n\
                - read_annotations: List all annotations on an image\n\
                - remove_annotation: Remove an annotation by ID (e.g., 'a1')\n\
                - clear_annotations: Remove all annotations\n\
                - render: Bake annotations onto image for viewing\n\
                - wait_for_events: Block until human adds annotations (or timeout)\n\
                - generate_image: Generate an image via the configured generator (default: imago)\n\
                - judge_pair: Compare expected vs actual images via the configured judge tool (default: imago compare)\n\n\
                Collaboration Workflow:\n\
                1. Use add_annotation to mark up images, then render\n\
                2. Call wait_for_events to block until human responds\n\
                3. When events arrive, read the annotations or process events\n\
                4. Use since_seq from response to avoid duplicate events".to_string()
            ),
        }
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParam>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let tools = self.tool_router.list_all();
        Ok(ListToolsResult {
            tools,
            next_cursor: None,
            meta: None,
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParam,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let tool_context = ToolCallContext::new(self, request, context);
        self.tool_router.call(tool_context).await
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
