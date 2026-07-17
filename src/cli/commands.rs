//! CLI command implementations

use super::args::*;
use crate::capture::{generate_tiles, screen, TiledCapture};
use crate::core::TileConfig;
use crate::collab::{
    log::SessionManager,
    session::Session,
    types::ClientType,
};
use crate::core::{qml, NibImage, Result, TileBounds, TileId};
use crate::{annotations_file_path, AnnotationsFile, AnnotationGeometry};
#[cfg(feature = "gui")]
use crate::gui::NibApp;
use crate::storage::{
    self, convert, export, index::Index, nib_file::NibFile, qml_file, sessions::SessionRegistry,
};
use arboard::Clipboard;
use chrono::{DateTime, Local};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Execute the capture command
pub fn run_capture(args: &CaptureArgs) -> Result<()> {
    tracing::info!(?args, "Running capture");

    // Handle delay
    if args.delay > 0 {
        println!("Capturing in {} seconds...", args.delay);
        std::thread::sleep(Duration::from_secs(args.delay as u64));
    }

    // Capture based on --app/--title flags or mode
    let image = if let Some(ref app) = args.app {
        println!("Capturing window for app: {}", app);
        crate::capture::window::capture_by_app(app)?
    } else if let Some(ref title) = args.title {
        println!("Capturing window with title: {}", title);
        crate::capture::window::capture_by_title(title)?
    } else {
        match args.mode {
            CaptureMode::Screen => {
                println!("Capturing full screen...");
                screen::capture_primary()?
            }
            CaptureMode::Region => {
                // For now, fall back to full screen capture
                // TODO: Implement interactive region selection
                println!("Region selection not yet implemented, capturing full screen...");
                screen::capture_primary()?
            }
            CaptureMode::Window => {
                // Capture the focused window
                let windows = crate::capture::window::list_windows()
                    .map_err(|e| crate::core::NibError::Other(format!("{}", e)))?;
                let focused = windows.iter().find(|w| w.is_focused);
                if let Some(w) = focused {
                    println!(
                        "Capturing focused window: {} - \"{}\"",
                        w.app_name, w.title
                    );
                    crate::capture::window::capture_by_app(&w.app_name)?
                } else {
                    println!("No focused window found, capturing full screen...");
                    screen::capture_primary()?
                }
            }
        }
    };

    println!(
        "Captured {}x{} image ({} bytes)",
        image.width,
        image.height,
        image.image_data.len()
    );

    // Handle output
    if args.clipboard {
        copy_to_clipboard(&image)?;
        println!("Copied to clipboard!");
    } else if args.tiled {
        // Tiled capture mode: create tile pyramid
        let output_dir = args.output.clone().unwrap_or_else(generate_tiled_dirname);

        // Load image as RGBA
        let img = image::load_from_memory(&image.image_data)
            .map_err(|e| crate::core::NibError::Image(crate::core::ImageError::DecodeError(e.to_string())))?
            .to_rgba8();

        // Create tile config
        let config = TileConfig::for_image(img.width(), img.height(), args.tile_size);

        // Generate tiles
        let manifest = generate_tiles(&img, &output_dir, &config).map_err(|e| {
            crate::core::NibError::Other(format!("Failed to generate tiles: {}", e))
        })?;

        println!("Tiled capture saved to: {}", output_dir.display());
        println!("  Dimensions: {}x{}", image.width, image.height);
        println!("  Tile size: {}px", args.tile_size);
        println!("  Zoom levels: {}", manifest.levels.len());
        println!("  Total tiles: {}", manifest.total_tile_count());
    } else {
        let output_path = args.output.clone().unwrap_or_else(generate_filename);
        save_capture(&image, &output_path)?;
        println!("Saved to: {}", output_path.display());

        // Index the capture
        if let Err(e) = index_capture(&image, &output_path) {
            tracing::warn!("Failed to index capture: {}", e);
        }
    }

    // TODO: If --edit, launch GUI
    if args.edit {
        println!("GUI editor not yet implemented");
    }

    Ok(())
}

/// Generate a unique directory name for tiled captures
fn generate_tiled_dirname() -> PathBuf {
    let now = chrono::Local::now();
    let dirname = format!("nib_tiled_{}", now.format("%Y%m%d_%H%M%S"));
    storage::captures_dir().join(dirname)
}

/// Execute the sessions command (list active sessions)
pub fn run_sessions() -> Result<()> {
    tracing::info!("Running sessions");

    let manager = SessionManager::new(SessionManager::default_dir())
        .map_err(|e| crate::core::NibError::Other(e.to_string()))?;

    let sessions = manager
        .list_sessions()
        .map_err(|e| crate::core::NibError::Other(e.to_string()))?;

    if sessions.is_empty() {
        println!("No active collaboration sessions.");
        println!("\nStart a session with: nib gui <image.png>");
        return Ok(());
    }

    println!("Active collaboration sessions:");
    println!("{}", "─".repeat(70));

    for session in &sessions {
        let created = DateTime::<Local>::from(session.created_at);
        let modified = DateTime::<Local>::from(session.last_modified);

        let path = &session.image_path;
        let filename = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();

        let client_count = session.connected_clients.len();
        let client_info = if client_count == 0 {
            "no clients".to_string()
        } else {
            let types: Vec<_> = session
                .connected_clients
                .iter()
                .map(|c| format!("{}", c.client_type))
                .collect();
            format!("{} client(s): {}", client_count, types.join(", "))
        };

        println!("  {} │ {}", filename, session.session_id);
        println!(
            "    Created: {} │ Modified: {}",
            created.format("%Y-%m-%d %H:%M"),
            modified.format("%H:%M:%S")
        );
        println!("    Operations: {} │ {}", session.operation_count, client_info);
        println!("    Path: {}", path.display());
        println!();
    }

    println!("{}", "─".repeat(70));
    println!(
        "Session storage: {}",
        SessionManager::default_dir().display()
    );

    Ok(())
}

/// Execute the validate command
pub fn run_validate(args: &ValidateArgs) -> Result<()> {
    tracing::info!(?args, "Running validate");

    let result = if args.qml_file {
        // Validate raw QML file
        let content = std::fs::read_to_string(&args.file)?;
        qml::parse_qml_str(&content)
    } else if args
        .file
        .extension()
        .map(|e| e == "qml")
        .unwrap_or(false)
    {
        // .qml extension - treat as raw QML
        let content = std::fs::read_to_string(&args.file)?;
        qml::parse_qml_str(&content)
    } else {
        // PNG file - extract and validate embedded QML
        let image = qml_file::load_qml_image(&args.file)?;
        Ok(image.annotations)
    };

    match result {
        Ok(annotations) => {
            println!("✓ Valid QML");
            println!("  Annotations: {}", annotations.len());

            // Count by type
            let mut type_counts = std::collections::HashMap::new();
            for a in &annotations {
                *type_counts
                    .entry(a.annotation_type.type_name())
                    .or_insert(0) += 1;
            }
            for (type_name, count) in type_counts {
                println!("    {}: {}", type_name, count);
            }

            Ok(())
        }
        Err(e) => {
            println!("✗ Invalid QML");
            println!("  Error: {}", e);
            Err(e.into())
        }
    }
}

/// Execute the list command
pub fn run_list(args: &ListArgs) -> Result<()> {
    tracing::info!(?args, "Running list");

    let index = Index::open()?;
    let entries = index.list_recent(args.limit)?;

    // Load session registry to check which files are open
    let registry = SessionRegistry::load()?;
    let active_sessions = registry.list_active()?;
    let open_paths: std::collections::HashSet<PathBuf> = active_sessions
        .iter()
        .map(|s| s.path.clone())
        .collect();

    if entries.is_empty() {
        println!("No captures found.");
        println!("Use 'nib capture' to take a screenshot.");
        return Ok(());
    }

    println!("Recent captures ({}):", entries.len());
    println!("{}", "─".repeat(70));

    for (i, entry) in entries.iter().enumerate() {
        let path = std::path::Path::new(&entry.path);
        let filename = path.file_name().unwrap_or_default().to_string_lossy();

        let annotations = if entry.annotation_count > 0 {
            format!(", {} annotations", entry.annotation_count)
        } else {
            String::new()
        };

        // Check if this file is open in the session registry
        let is_open = open_paths.contains(path);

        // Also check embedded session for .nib files
        let is_nib_open = if path.extension().map(|e| e == "nib").unwrap_or(false) && path.exists() {
            get_nib_session_info(&path.to_path_buf()).ok().flatten().is_some()
        } else {
            false
        };

        let open_indicator = if is_open || is_nib_open {
            " [OPEN]"
        } else {
            ""
        };

        println!(
            "  {}. {} ({}x{}{}){}",
            i + 1,
            filename,
            entry.width,
            entry.height,
            annotations,
            open_indicator
        );
    }

    println!("{}", "─".repeat(70));
    println!("Storage: {}", storage::captures_dir().display());

    Ok(())
}

/// Execute the gui command (launch the graphical editor)
#[cfg(feature = "gui")]
pub fn run_gui(args: &GuiArgs) -> Result<()> {
    tracing::info!(?args, "Launching GUI");

    let file_path = args.file.clone();
    let is_nib_file = file_path
        .as_ref()
        .map(|p| p.extension().map(|e| e == "nib").unwrap_or(false))
        .unwrap_or(false);

    // Verify file exists
    if let Some(ref path) = file_path {
        if !path.exists() {
            return Err(crate::core::NibError::Storage(
                crate::core::StorageError::NotFound(format!(
                    "File not found: {}",
                    path.display()
                )),
            ));
        }
        println!("Opening {} in Nib editor...", path.display());
    } else {
        println!("Launching Nib editor...");
    }

    // Register session for .nib files
    let pid = std::process::id();
    if is_nib_file {
        if let Some(ref path) = file_path {
            // Register in SessionRegistry
            if let Ok(mut registry) = SessionRegistry::load() {
                if let Err(e) = registry.register(path, pid) {
                    tracing::warn!("Failed to register session in registry: {}", e);
                }
            }

            // Update session in .nib file itself
            if let Ok(nib) = NibFile::open(path) {
                if let Err(e) = nib.update_session(Some(pid)) {
                    tracing::warn!("Failed to update session in .nib file: {}", e);
                }
            }
        }
    }

    // Create and run the app
    let app = match file_path.clone() {
        Some(path) => NibApp::with_file(path),
        None => NibApp::new(),
    };

    let result = app.run().map_err(|e| crate::core::NibError::Other(e.to_string()));

    // Unregister session for .nib files when GUI closes
    if is_nib_file {
        if let Some(ref path) = file_path {
            // Unregister from SessionRegistry
            if let Ok(mut registry) = SessionRegistry::load() {
                if let Err(e) = registry.unregister(path) {
                    tracing::warn!("Failed to unregister session from registry: {}", e);
                }
            }

            // Clear session in .nib file itself
            if let Ok(nib) = NibFile::open(path) {
                if let Err(e) = nib.clear_session() {
                    tracing::warn!("Failed to clear session in .nib file: {}", e);
                }
            }
        }
    }

    result
}

/// List annotations for an image
pub fn run_annotation_list(args: &AnnotationListArgs) -> Result<()> {
    tracing::info!(?args, "Running annotation list");

    // Check if this is a .nib file
    let is_nib_file = args.file.extension().map(|e| e == "nib").unwrap_or(false);

    if is_nib_file {
        // Handle .nib file with SQLite storage
        return run_annotations_nib(args);
    }

    // Legacy: handle sidecar JSON file
    let annotations_path = annotations_file_path(&args.file);

    if !annotations_path.exists() {
        if args.json {
            // Output empty JSON structure
            let empty = AnnotationsFile::new(
                &args.file.to_string_lossy(),
                Vec::new(),
            );
            println!("{}", serde_json::to_string_pretty(&empty).unwrap_or_default());
        } else {
            println!("No annotations found for: {}", args.file.display());
            println!("Annotations file would be at: {}", annotations_path.display());
        }
        return Ok(());
    }

    let json_content = std::fs::read_to_string(&annotations_path)?;

    if args.json {
        // Output raw JSON
        print!("{}", json_content);
    } else {
        // Parse and format output
        match serde_json::from_str::<AnnotationsFile>(&json_content) {
            Ok(file) => {
                println!("Annotations for: {}", args.file.display());
                println!("Sidecar file: {}", annotations_path.display());
                println!("Format version: {}", file.version);
                println!("{}", "─".repeat(50));

                if file.annotations.is_empty() {
                    println!("No annotations found.");
                } else {
                    println!("Found {} annotation(s):\n", file.annotations.len());

                    for (i, annotation) in file.annotations.iter().enumerate() {
                        let geometry_info = match &annotation.geometry {
                            AnnotationGeometry::Rectangle { x, y, width, height } => {
                                format!("x={:.0}, y={:.0}, w={:.0}, h={:.0}", x, y, width, height)
                            }
                            AnnotationGeometry::Line { start_x, start_y, end_x, end_y } => {
                                format!("({:.0},{:.0}) -> ({:.0},{:.0})", start_x, start_y, end_x, end_y)
                            }
                            AnnotationGeometry::Ellipse { center_x, center_y, radius_x, radius_y } => {
                                format!("center=({:.0},{:.0}), rx={:.0}, ry={:.0}", center_x, center_y, radius_x, radius_y)
                            }
                            AnnotationGeometry::Point { x, y, value, content } => {
                                let mut info = format!("({:.0},{:.0})", x, y);
                                if let Some(v) = value {
                                    info.push_str(&format!(" value={}", v));
                                }
                                if let Some(c) = content {
                                    info.push_str(&format!(" \"{}\"", c));
                                }
                                info
                            }
                            AnnotationGeometry::Path { points } => {
                                format!("{} points", points.len())
                            }
                        };

                        println!(
                            "  {}. [{}] {} {} [{}]",
                            i + 1,
                            annotation.id,
                            annotation.annotation_type.to_uppercase(),
                            geometry_info,
                            annotation.color
                        );
                    }
                }
            }
            Err(e) => {
                println!("Error parsing annotations file: {}", e);
                return Err(crate::core::NibError::Other(format!(
                    "Failed to parse annotations: {}",
                    e
                )));
            }
        }
    }

    Ok(())
}

/// Execute the annotations command for .nib files (with --since support)
fn run_annotations_nib(args: &AnnotationListArgs) -> Result<()> {
    // Verify the file exists
    if !args.file.exists() {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::NotFound(format!(
                "File not found: {}",
                args.file.display()
            )),
        ));
    }

    // Open the .nib file
    let nib = NibFile::open(&args.file)?;

    // Get annotations, optionally filtered by --since
    let annotations = if let Some(since_unix) = args.since {
        nib.list_annotations_since(since_unix)?
    } else {
        nib.list_annotations()?
    };

    if args.json {
        // JSON output
        let annotations_json: Vec<serde_json::Value> = annotations
            .iter()
            .map(|a| {
                let modified_unix = a
                    .modified_at
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                let created_unix = a
                    .created_at
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);

                serde_json::json!({
                    "id": format!("a{}", a.id.0),
                    "type": a.annotation_type.type_name(),
                    "color": format!("#{:02x}{:02x}{:02x}", a.color.r, a.color.g, a.color.b),
                    "visible": a.visible,
                    "locked": a.locked,
                    "z_index": a.z_index,
                    "created_at": created_unix,
                    "modified_at": modified_unix
                })
            })
            .collect();

        let output = serde_json::json!({
            "file": args.file.to_string_lossy(),
            "since": args.since,
            "count": annotations.len(),
            "annotations": annotations_json
        });

        println!("{}", serde_json::to_string_pretty(&output).unwrap_or_default());
    } else {
        // Human-readable output
        println!("Annotations for: {}", args.file.display());
        if let Some(since) = args.since {
            println!("Since: {} (Unix timestamp)", since);
        }
        println!("{}", "─".repeat(50));

        if annotations.is_empty() {
            println!("No annotations found.");
        } else {
            println!("Found {} annotation(s):\n", annotations.len());

            for (i, annotation) in annotations.iter().enumerate() {
                let modified = DateTime::<Local>::from(annotation.modified_at);
                println!(
                    "  {}. [a{}] {} [#{:02x}{:02x}{:02x}] (modified: {})",
                    i + 1,
                    annotation.id.0,
                    annotation.annotation_type.type_name().to_uppercase(),
                    annotation.color.r,
                    annotation.color.g,
                    annotation.color.b,
                    modified.format("%Y-%m-%d %H:%M:%S")
                );
            }
        }
    }

    Ok(())
}

/// Add an annotation to an image
pub fn run_annotation_add(args: &AnnotationAddArgs) -> Result<()> {
    use crate::core::{Annotation, AnnotationType, ArrowHead, BlurIntensity, Color, Point, Region, StrokeStyle, TextAlign};

    tracing::info!(?args, "Running annotation add");

    // Verify the file exists
    if !args.file.exists() {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::NotFound(format!(
                "File not found: {}",
                args.file.display()
            )),
        ));
    }

    // Parse color from hex string
    let color = parse_hex_color(&args.color).unwrap_or(Color::RED);

    // Check if this is a .nib file (SQLite format) or regular image (JSON sidecar)
    let is_nib_file = args.file.extension().map(|e| e == "nib").unwrap_or(false);

    if is_nib_file {
        // Handle .nib SQLite format
        let nib = NibFile::open(&args.file)?;

        // Create the annotation type based on args
        let annotation_type = match args.annotation_type.as_str() {
            "rectangle" => AnnotationType::Box {
                region: Region::new(args.x, args.y, args.width, args.height),
                stroke_width: 2.0,
                stroke_style: StrokeStyle::Solid,
                filled: false,
                corner_radius: 0.0,
            },
            "highlight" => AnnotationType::Highlight {
                region: Region::new(args.x, args.y, args.width, args.height),
                corner_radius: 0.0,
            },
            "blur" => AnnotationType::Blur {
                region: Region::new(args.x, args.y, args.width, args.height),
                intensity: BlurIntensity::Medium,
            },
            "crop" => AnnotationType::Crop {
                region: Region::new(args.x, args.y, args.width, args.height),
            },
            "arrow" => AnnotationType::Arrow {
                start: Point::new(args.x, args.y),
                end: Point::new(args.x + args.width, args.y + args.height),
                head: ArrowHead::End,
                stroke_width: 2.0,
            },
            "line" => AnnotationType::Line {
                start: Point::new(args.x, args.y),
                end: Point::new(args.x + args.width, args.y + args.height),
                stroke_width: 2.0,
                stroke_style: StrokeStyle::Solid,
            },
            "ellipse" => AnnotationType::Ellipse {
                center: Point::new(args.x + args.width / 2.0, args.y + args.height / 2.0),
                radius_x: args.width / 2.0,
                radius_y: args.height / 2.0,
                stroke_width: 2.0,
                filled: false,
            },
            "text" => AnnotationType::Text {
                position: Point::new(args.x, args.y),
                content: args.text.clone().unwrap_or_else(|| "Text".to_string()),
                font_size: 32.0,
                align: TextAlign::Left,
                background: None,
                max_width: None,
            },
            "number" => {
                // Get next number value from existing annotations
                let next_num = nib.list_annotations()?
                    .iter()
                    .filter_map(|a| {
                        if let AnnotationType::Number { value, .. } = &a.annotation_type {
                            Some(*value)
                        } else {
                            None
                        }
                    })
                    .max()
                    .unwrap_or(0) + 1;

                AnnotationType::Number {
                    position: Point::new(args.x, args.y),
                    value: args.value.unwrap_or(next_num),
                    radius: 16.0,
                }
            }
            _ => {
                return Err(crate::core::NibError::Other(format!(
                    "Unknown annotation type: {}. Valid types: rectangle, arrow, line, ellipse, highlight, blur, text, number",
                    args.annotation_type
                )));
            }
        };

        // Create and add the annotation
        let annotation = Annotation::new(annotation_type).with_color(color);
        let id = nib.add_annotation(&annotation)?;

        // Store message for GUI toast if provided
        if let Some(ref message) = args.message {
            nib.add_message(message, "agent")?;
        }
        nib.save()?;

        println!("[NIB {}] claude added [{}] {} at ({}, {})",
            crate::events::timestamp_ms(),
            id,
            args.annotation_type,
            args.x,
            args.y
        );
        println!("Saved to: {}", args.file.display());

        return Ok(());
    }

    // Handle regular image files - use .nib SQLite format
    let nib_path = args.file.with_extension("nib");

    // Open existing .nib or create new one from the image
    let nib = if nib_path.exists() {
        NibFile::open(&nib_path)?
    } else {
        // Create new .nib file from image
        let image_data = std::fs::read(&args.file)?;
        let img = image::load_from_memory(&image_data).map_err(|e| {
            crate::core::NibError::Image(crate::core::ImageError::DecodeError(e.to_string()))
        })?;
        let extension = args.file
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png")
            .to_lowercase();
        let format = match extension.as_str() {
            "jpg" | "jpeg" => "jpeg",
            "webp" => "webp",
            _ => "png",
        };
        NibFile::create(&nib_path, &image_data, format, img.width(), img.height())?
    };

    // Create the annotation type based on args
    let annotation_type = match args.annotation_type.as_str() {
        "rectangle" => AnnotationType::Box {
            region: Region::new(args.x, args.y, args.width, args.height),
            stroke_width: 2.0,
            stroke_style: StrokeStyle::Solid,
            filled: false,
            corner_radius: 0.0,
        },
        "highlight" => AnnotationType::Highlight {
            region: Region::new(args.x, args.y, args.width, args.height),
            corner_radius: 0.0,
        },
        "blur" => AnnotationType::Blur {
            region: Region::new(args.x, args.y, args.width, args.height),
            intensity: BlurIntensity::Medium,
        },
        "crop" => AnnotationType::Crop {
            region: Region::new(args.x, args.y, args.width, args.height),
        },
        "arrow" => AnnotationType::Arrow {
            start: Point::new(args.x, args.y),
            end: Point::new(args.x + args.width, args.y + args.height),
            head: ArrowHead::End,
            stroke_width: 2.0,
        },
        "line" => AnnotationType::Line {
            start: Point::new(args.x, args.y),
            end: Point::new(args.x + args.width, args.y + args.height),
            stroke_width: 2.0,
            stroke_style: StrokeStyle::Solid,
        },
        "ellipse" => AnnotationType::Ellipse {
            center: Point::new(args.x + args.width / 2.0, args.y + args.height / 2.0),
            radius_x: args.width / 2.0,
            radius_y: args.height / 2.0,
            stroke_width: 2.0,
            filled: false,
        },
        "text" => AnnotationType::Text {
            position: Point::new(args.x, args.y),
            content: args.text.clone().unwrap_or_else(|| "Text".to_string()),
            font_size: 32.0,
            align: TextAlign::Left,
            background: None,
            max_width: None,
        },
        "number" => {
            // Get next number value from existing annotations
            let next_num = nib.list_annotations()?
                .iter()
                .filter_map(|a| {
                    if let AnnotationType::Number { value, .. } = &a.annotation_type {
                        Some(*value)
                    } else {
                        None
                    }
                })
                .max()
                .unwrap_or(0) + 1;

            AnnotationType::Number {
                position: Point::new(args.x, args.y),
                value: args.value.unwrap_or(next_num),
                radius: 16.0,
            }
        }
        _ => {
            return Err(crate::core::NibError::Other(format!(
                "Unknown annotation type: {}. Valid types: rectangle, arrow, line, ellipse, highlight, blur, text, number",
                args.annotation_type
            )));
        }
    };

    // Create and add the annotation
    let annotation = Annotation::new(annotation_type).with_color(color);
    let id = nib.add_annotation(&annotation)?;

    // Store message for GUI toast if provided
    if let Some(ref message) = args.message {
        nib.add_message(message, "agent")?;
    }
    nib.save()?;

    println!("[NIB {}] claude added [{}] {} at ({}, {})",
        crate::events::timestamp_ms(),
        id,
        args.annotation_type,
        args.x,
        args.y
    );
    println!("Saved to: {}", nib_path.display());

    Ok(())
}

/// Parse a hex color string (e.g., "#ff0000" or "#ff0000ff") into a Color
fn parse_hex_color(hex: &str) -> Option<crate::core::Color> {
    let hex = hex.trim_start_matches('#');
    if hex.len() == 6 {
        let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
        let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
        let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
        Some(crate::core::Color::rgb(r, g, b))
    } else if hex.len() == 8 {
        let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
        let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
        let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
        let a = u8::from_str_radix(&hex[6..8], 16).ok()?;
        Some(crate::core::Color::rgba(r, g, b, a))
    } else {
        None
    }
}

// =============================================================================
// Helper functions
// =============================================================================

/// Generate a unique filename for captures
fn generate_filename() -> PathBuf {
    let now = chrono::Local::now();
    let filename = format!("nib_{}.png", now.format("%Y%m%d_%H%M%S"));
    storage::captures_dir().join(filename)
}

/// Save a capture to disk
fn save_capture(image: &NibImage, path: &PathBuf) -> Result<()> {
    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    qml_file::save_qml_image(image, path)?;
    Ok(())
}

/// Copy image to clipboard
fn copy_to_clipboard(image: &NibImage) -> Result<()> {
    let mut clipboard = Clipboard::new().map_err(|e| {
        crate::core::NibError::Capture(crate::core::CaptureError::CaptureFailed(e.to_string()))
    })?;

    // Load image to get raw RGBA data
    let img = image::load_from_memory(&image.image_data).map_err(|e| {
        crate::core::NibError::Image(crate::core::ImageError::DecodeError(e.to_string()))
    })?;

    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();

    let img_data = arboard::ImageData {
        width: width as usize,
        height: height as usize,
        bytes: std::borrow::Cow::Owned(rgba.into_raw()),
    };

    clipboard.set_image(img_data).map_err(|e| {
        crate::core::NibError::Capture(crate::core::CaptureError::CaptureFailed(e.to_string()))
    })?;

    Ok(())
}


/// Parse a region string in "x,y,width,height" format.
#[cfg(feature = "ocr")]
fn parse_region(region_str: &str) -> Result<crate::ocr::Region> {
    let parts: Vec<&str> = region_str.split(',').collect();
    if parts.len() != 4 {
        return Err(crate::core::NibError::Other(format!(
            "Invalid region format '{}'. Expected 'x,y,width,height'",
            region_str
        )));
    }

    let x = parts[0].trim().parse::<i32>().map_err(|_| {
        crate::core::NibError::Other(format!("Invalid x coordinate: {}", parts[0]))
    })?;
    let y = parts[1].trim().parse::<i32>().map_err(|_| {
        crate::core::NibError::Other(format!("Invalid y coordinate: {}", parts[1]))
    })?;
    let width = parts[2].trim().parse::<i32>().map_err(|_| {
        crate::core::NibError::Other(format!("Invalid width: {}", parts[2]))
    })?;
    let height = parts[3].trim().parse::<i32>().map_err(|_| {
        crate::core::NibError::Other(format!("Invalid height: {}", parts[3]))
    })?;

    Ok(crate::ocr::Region::new(x, y, width, height))
}

/// Execute the find-text command (OCR-based text search with coordinates)
#[cfg(feature = "ocr")]
pub fn run_find_text(args: &FindTextArgs) -> Result<()> {
    tracing::info!(?args, "Running find-text");

    // Verify the image file exists
    if !args.file.exists() {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::NotFound(format!(
                "File not found: {}",
                args.file.display()
            )),
        ));
    }

    // Parse region if provided
    let region = match &args.region {
        Some(region_str) => Some(parse_region(region_str)?),
        None => None,
    };

    // Use OCRS for text detection
    let regions = crate::ocr::find_text(&args.file, args.search.as_deref(), region)?;

    // Convert to TextMatch for compatibility with existing output logic
    let results: Vec<TextMatch> = regions
        .into_iter()
        .map(|r| TextMatch {
            text: r.text,
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            confidence: (r.confidence * 100.0) as i32,
        })
        .collect();

    if args.json {
        // JSON output
        let region_json = region.map(|r| {
            serde_json::json!({
                "x": r.x,
                "y": r.y,
                "width": r.width,
                "height": r.height
            })
        });
        let json_output = serde_json::json!({
            "file": args.file.to_string_lossy(),
            "search": args.search,
            "region": region_json,
            "matches": results.iter().map(|r| {
                serde_json::json!({
                    "text": r.text,
                    "x": r.x,
                    "y": r.y,
                    "width": r.width,
                    "height": r.height,
                    "confidence": r.confidence
                })
            }).collect::<Vec<_>>()
        });
        println!("{}", serde_json::to_string_pretty(&json_output).unwrap_or_default());
    } else {
        // Human-readable output
        if let Some(ref search) = args.search {
            println!("Searching for \"{}\" in: {}", search, args.file.display());
        } else {
            println!("All text found in: {}", args.file.display());
        }
        if let Some(r) = region {
            println!("Region filter: x={}, y={}, width={}, height={}", r.x, r.y, r.width, r.height);
        }
        println!("{}", "─".repeat(70));

        if results.is_empty() {
            println!("No text found matching criteria.");
        } else {
            println!("Found {} match(es):\n", results.len());
            for (i, m) in results.iter().enumerate() {
                println!(
                    "  {}. \"{}\"",
                    i + 1,
                    m.text
                );
                println!(
                    "     x={}, y={}, width={}, height={} (confidence: {}%)",
                    m.x, m.y, m.width, m.height, m.confidence
                );
                println!();
            }
        }
    }

    // If --highlight flag is set, add annotations for found text
    if args.highlight && !results.is_empty() {
        use crate::core::{Annotation, AnnotationType, Region};

        let nib_path = args.file.with_extension("nib");

        // Open existing .nib or create new one from the image
        let nib = if nib_path.exists() {
            NibFile::open(&nib_path)?
        } else {
            // Create new .nib file from image
            let image_data = std::fs::read(&args.file)?;
            let img = image::load_from_memory(&image_data).map_err(|e| {
                crate::core::NibError::Image(crate::core::ImageError::DecodeError(e.to_string()))
            })?;
            let extension = args.file
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("png")
                .to_lowercase();
            let format = match extension.as_str() {
                "jpg" | "jpeg" => "jpeg",
                "webp" => "webp",
                _ => "png",
            };
            NibFile::create(&nib_path, &image_data, format, img.width(), img.height())?
        };

        // Parse the color
        let color = parse_hex_color(&args.color).unwrap_or(crate::core::Color::rgba(255, 255, 0, 128));

        // Add highlight for each match
        for m in &results {
            let annotation = Annotation::new(AnnotationType::Highlight {
                region: Region::new(m.x as f64, m.y as f64, m.width as f64, m.height as f64),
                corner_radius: 0.0,
            }).with_color(color);
            nib.add_annotation(&annotation)?;
        }

        nib.save()?;
        println!("Added {} highlight annotation(s) to: {}", results.len(), nib_path.display());
    }

    Ok(())
}

/// Text match result from OCR
#[derive(Debug)]
struct TextMatch {
    text: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    confidence: i32,
}

/// Index a capture in the database
fn index_capture(image: &NibImage, path: &Path) -> Result<()> {
    let index = Index::open()?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let entry = storage::index::ImageEntry {
        id: 0, // Will be assigned by database
        path: path.to_string_lossy().to_string(),
        width: image.width,
        height: image.height,
        created_at: now,
        modified_at: now,
        title: image.title.clone(),
        tags: image.tags.clone(),
        annotation_count: image.annotations.len(),
    };

    index.upsert_image(&entry)?;
    Ok(())
}

/// Execute the render command (bake annotations onto image for viewing)
pub fn run_render(args: &RenderArgs) -> Result<()> {
    tracing::info!(?args, "Running render");

    // Verify the image file exists
    if !args.file.exists() {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::NotFound(format!(
                "File not found: {}",
                args.file.display()
            )),
        ));
    }

    // Check if this is a .nib file or an image file
    let is_nib_file = args.file.extension().map(|e| e == "nib").unwrap_or(false);

    let (image_data, width, height, annotations) = if is_nib_file {
        // Load directly from .nib file
        let nib = NibFile::open(&args.file)?;
        let (data, info) = nib.get_image()?;
        let anns = nib.list_annotations()?;
        (data, info.width, info.height, anns)
    } else {
        // For image files, look for corresponding .nib file
        let nib_path = args.file.with_extension("nib");

        if nib_path.exists() {
            // Load annotations from .nib file
            let nib = NibFile::open(&nib_path)?;
            let anns = nib.list_annotations()?;
            // But use the image data from the original file for freshness
            let image_data = std::fs::read(&args.file)?;
            let img = image::load_from_memory(&image_data)
                .map_err(|e| crate::core::NibError::Image(crate::core::ImageError::DecodeError(e.to_string())))?;
            (image_data, img.width(), img.height(), anns)
        } else {
            // No .nib file exists - render with no annotations
            let image_data = std::fs::read(&args.file)?;
            let img = image::load_from_memory(&image_data)
                .map_err(|e| crate::core::NibError::Image(crate::core::ImageError::DecodeError(e.to_string())))?;
            (image_data, img.width(), img.height(), Vec::new())
        }
    };

    // Create NibImage with annotations
    let nib_image = NibImage {
        image_data,
        width,
        height,
        source: crate::core::ImageSource::File(args.file.clone()),
        annotations,
        assets: std::collections::HashMap::new(),
        title: None,
        description: None,
        tags: Vec::new(),
        file_path: Some(args.file.clone()),
        created_at: SystemTime::now(),
        modified_at: SystemTime::now(),
    };

    // Determine output path
    let output_path = args.output.clone().unwrap_or_else(|| {
        if is_nib_file {
            // For .nib files, output as .rendered.png
            let stem = args.file.file_stem().unwrap_or_default().to_string_lossy();
            args.file.with_file_name(format!("{}.rendered.png", stem))
        } else {
            let stem = args.file.file_stem().unwrap_or_default().to_string_lossy();
            let ext = args.file.extension().unwrap_or_default().to_string_lossy();
            args.file.with_file_name(format!("{}.rendered.{}", stem, ext))
        }
    });

    // Export with baked annotations
    let options = export::ExportOptions {
        bake_annotations: true,
        ..Default::default()
    };
    export::export_image(&nib_image, &output_path, &options)?;

    println!("Rendered {} annotation(s) to: {}", nib_image.annotations.len(), output_path.display());

    Ok(())
}

/// Remove a specific annotation by ID
pub fn run_annotation_remove(args: &AnnotationRemoveArgs) -> Result<()> {
    tracing::info!(?args, "Running remove-annotation");

    // Verify the file exists
    if !args.file.exists() {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::NotFound(format!(
                "File not found: {}",
                args.file.display()
            )),
        ));
    }

    // Check if this is a .nib file or an image file
    let is_nib_file = args.file.extension().map(|e| e == "nib").unwrap_or(false);

    let nib_path = if is_nib_file {
        args.file.clone()
    } else {
        args.file.with_extension("nib")
    };

    // Verify the .nib file exists
    if !nib_path.exists() {
        return Err(crate::core::NibError::Other(format!(
            "No .nib file found: {}",
            nib_path.display()
        )));
    }

    // Open the .nib file
    let nib = NibFile::open(&nib_path)?;

    // Delete the annotation
    let deleted = nib.delete_annotation(&args.id)?;

    if !deleted {
        return Err(crate::core::NibError::Other(format!(
            "Annotation not found: {}",
            args.id
        )));
    }

    nib.save()?;

    let remaining = nib.annotation_count()?;
    println!("Removed annotation [{}]", args.id);
    println!("Remaining annotations: {}", remaining);

    Ok(())
}

/// Clear all annotations from an image
pub fn run_annotation_clear(args: &AnnotationClearArgs) -> Result<()> {
    tracing::info!(?args, "Running clear-annotations");

    // Verify the file exists
    if !args.file.exists() {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::NotFound(format!(
                "File not found: {}",
                args.file.display()
            )),
        ));
    }

    // Check if this is a .nib file or an image file
    let is_nib_file = args.file.extension().map(|e| e == "nib").unwrap_or(false);

    let nib_path = if is_nib_file {
        args.file.clone()
    } else {
        args.file.with_extension("nib")
    };

    // Check if .nib file exists
    if !nib_path.exists() {
        println!("No annotations to clear");
        return Ok(());
    }

    // Open the .nib file
    let nib = NibFile::open(&nib_path)?;

    // Get count before clearing
    let annotations = nib.list_annotations()?;
    let removed_count = annotations.len();

    // Delete all annotations
    for ann in &annotations {
        let id = format!("a{}", ann.id.0);
        nib.delete_annotation(&id)?;
    }

    nib.save()?;

    println!("Cleared {} annotation(s)", removed_count);

    Ok(())
}

/// Execute the grid command (overlay coordinate grid on image)
pub fn run_grid(args: &GridArgs) -> Result<()> {
    use crate::core::tile::TileBounds;
    use crate::grid::{self, GridColor, GridConfig, GridMetadata};
    use crate::grid::types::RegionJson;
    use image::GenericImageView;

    tracing::info!(?args, "Running grid");

    // Verify the file exists
    if !args.file.exists() {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::NotFound(format!(
                "File not found: {}",
                args.file.display()
            )),
        ));
    }

    // Load the image
    let image_data = std::fs::read(&args.file)?;
    let img = image::load_from_memory(&image_data)
        .map_err(|e| crate::core::NibError::Image(crate::core::ImageError::DecodeError(e.to_string())))?;
    let (width, height) = img.dimensions();

    // Parse region if provided
    let region = if let Some(ref region_str) = args.region {
        Some(parse_grid_region(region_str)?)
    } else {
        None
    };

    // Parse colors
    let color = GridColor::from_hex(&args.color)
        .map_err(|e| crate::core::NibError::Other(format!("Invalid color: {}", e)))?;
    let major_color = GridColor::from_hex(&args.major_color)
        .map_err(|e| crate::core::NibError::Other(format!("Invalid major color: {}", e)))?;

    // Create grid config
    let config = GridConfig {
        spacing: args.spacing,
        major_interval: args.major_interval,
        color,
        major_color,
        label_font_size: 12.0,
        show_labels: true,
    };

    // Build grid spatial index
    let index = grid::build_grid_index(width, height, &config, region.as_ref());

    if args.json {
        // JSON output mode - formula-based for compact representation
        // Labels on image show base36 indices (col,row)
        // Use formula to convert: pixel_x = origin[0] + col * spacing
        let render_bounds = region.unwrap_or_else(|| {
            TileBounds::from_corners(0.0, 0.0, width as f64, height as f64)
        });

        let entries = grid::lines_in_region(&index, &render_bounds);

        // Collect unique coordinates to determine grid dimensions
        let mut vertical_coords: Vec<f64> = Vec::new();
        let mut horizontal_coords: Vec<f64> = Vec::new();

        for entry in entries {
            match entry.line.orientation {
                grid::GridOrientation::Vertical => vertical_coords.push(entry.line.coordinate),
                grid::GridOrientation::Horizontal => horizontal_coords.push(entry.line.coordinate),
            }
        }

        vertical_coords.sort_by(|a, b| a.partial_cmp(b).unwrap());
        horizontal_coords.sort_by(|a, b| a.partial_cmp(b).unwrap());
        vertical_coords.dedup();
        horizontal_coords.dedup();

        let origin_x = vertical_coords.first().copied().unwrap_or(0.0);
        let origin_y = horizontal_coords.first().copied().unwrap_or(0.0);
        let cols = vertical_coords.len();
        let rows = horizontal_coords.len();

        let metadata = GridMetadata::new(
            width,
            height,
            origin_x,
            origin_y,
            args.spacing,
            cols,
            rows,
            args.major_interval,
            region.as_ref().map(RegionJson::from),
        );

        let json = serde_json::to_string_pretty(&metadata)
            .map_err(|e| crate::core::NibError::Other(format!("JSON error: {}", e)))?;
        println!("{}", json);
    } else {
        // Image output mode
        let mut output_img = img.to_rgba8();

        // Determine render bounds
        let render_bounds = region.unwrap_or_else(|| {
            TileBounds::from_corners(0.0, 0.0, width as f64, height as f64)
        });

        // Render grid
        grid::render_grid(&mut output_img, &index, &render_bounds, &config);

        // If region specified, crop the output
        let final_img = if let Some(ref bounds) = region {
            let x = bounds.min_x.max(0.0) as u32;
            let y = bounds.min_y.max(0.0) as u32;
            let w = (bounds.width() as u32).min(width - x);
            let h = (bounds.height() as u32).min(height - y);
            image::imageops::crop_imm(&output_img, x, y, w, h).to_image()
        } else {
            output_img
        };

        // Determine output path
        let output_path = args.output.clone().unwrap_or_else(|| {
            let stem = args.file.file_stem().unwrap_or_default().to_string_lossy();
            args.file.with_file_name(format!("{}.grid.png", stem))
        });

        // Save output
        final_img.save(&output_path)
            .map_err(|e| crate::core::NibError::Image(crate::core::ImageError::EncodeError(e.to_string())))?;

        println!("Grid overlay saved to: {}", output_path.display());
        println!("Image size: {}x{}", final_img.width(), final_img.height());
        println!("Grid spacing: {}px (major every {} lines)", args.spacing, args.major_interval);
    }

    Ok(())
}

/// Execute the pick-color command (sample color from image)
pub fn run_pick_color(args: &super::args::PickColorArgs) -> Result<()> {
    use image::GenericImageView;

    tracing::info!(?args, "Running pick-color");

    // Verify the file exists
    if !args.file.exists() {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::NotFound(format!(
                "File not found: {}",
                args.file.display()
            )),
        ));
    }

    // Load the image
    let image_data = std::fs::read(&args.file)?;
    let img = image::load_from_memory(&image_data)
        .map_err(|e| crate::core::NibError::Image(crate::core::ImageError::DecodeError(e.to_string())))?;
    let (width, height) = img.dimensions();

    // Validate coordinates
    if args.x >= width || args.y >= height {
        return Err(crate::core::NibError::Other(format!(
            "Coordinates ({}, {}) out of bounds for image {}x{}",
            args.x, args.y, width, height
        )));
    }

    // Sample color(s)
    let rgba = if args.radius == 0 {
        // Single pixel sample
        let pixel = img.get_pixel(args.x, args.y);
        [pixel[0], pixel[1], pixel[2], pixel[3]]
    } else {
        // Average pixels within radius
        let mut r_sum: u64 = 0;
        let mut g_sum: u64 = 0;
        let mut b_sum: u64 = 0;
        let mut a_sum: u64 = 0;
        let mut count: u64 = 0;

        let x_center = args.x as i64;
        let y_center = args.y as i64;
        let radius = args.radius as i64;

        for dy in -radius..=radius {
            for dx in -radius..=radius {
                // Check if within circular radius
                if dx * dx + dy * dy > radius * radius {
                    continue;
                }

                let px = x_center + dx;
                let py = y_center + dy;

                // Bounds check
                if px >= 0 && px < width as i64 && py >= 0 && py < height as i64 {
                    let pixel = img.get_pixel(px as u32, py as u32);
                    r_sum += pixel[0] as u64;
                    g_sum += pixel[1] as u64;
                    b_sum += pixel[2] as u64;
                    a_sum += pixel[3] as u64;
                    count += 1;
                }
            }
        }

        if count == 0 {
            return Err(crate::core::NibError::Other(
                "No pixels sampled within radius".to_string(),
            ));
        }

        [
            (r_sum / count) as u8,
            (g_sum / count) as u8,
            (b_sum / count) as u8,
            (a_sum / count) as u8,
        ]
    };

    // Format colors
    let hex = format!("#{:02x}{:02x}{:02x}", rgba[0], rgba[1], rgba[2]);
    let hex_alpha = format!("#{:02x}{:02x}{:02x}{:02x}", rgba[0], rgba[1], rgba[2], rgba[3]);

    if args.json {
        let output = serde_json::json!({
            "hex": hex,
            "hex_alpha": hex_alpha,
            "rgb": [rgba[0], rgba[1], rgba[2]],
            "rgba": rgba,
            "r": rgba[0],
            "g": rgba[1],
            "b": rgba[2],
            "a": rgba[3],
            "x": args.x,
            "y": args.y,
            "radius": args.radius,
            "file": args.file.display().to_string(),
        });
        println!("{}", serde_json::to_string_pretty(&output).unwrap());
    } else {
        println!("{}", hex);
        if args.radius > 0 {
            println!("(averaged from {} radius)", args.radius);
        }
    }

    Ok(())
}

/// Execute the info command (show .nib file info)
pub fn run_info(args: &super::args::InfoArgs) -> Result<()> {
    tracing::info!(?args, "Running info");

    // Verify the file exists
    if !args.file.exists() {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::NotFound(format!(
                "File not found: {}",
                args.file.display()
            )),
        ));
    }

    // Open the .nib file
    let nib = NibFile::open(&args.file)?;

    // Get image info
    let (_image_data, image_info) = nib.get_image()?;

    // Get annotations
    let annotations = nib.list_annotations()?;
    let annotation_count = annotations.len();

    // Count annotations by type
    let mut type_counts = std::collections::HashMap::new();
    for ann in &annotations {
        *type_counts
            .entry(ann.annotation_type.type_name().to_string())
            .or_insert(0usize) += 1;
    }

    // Check OCR cache (query directly from connection since NibFile doesn't expose this)
    // For now, we'll get this info from a separate query
    let ocr_cached = nib_has_ocr_cache(&args.file)?;

    // Check session status
    let session_info = get_nib_session_info(&args.file)?;

    if args.json {
        // JSON output
        let by_type: serde_json::Map<String, serde_json::Value> = type_counts
            .into_iter()
            .map(|(k, v)| (k, serde_json::Value::Number(v.into())))
            .collect();

        let json_output = serde_json::json!({
            "path": args.file.canonicalize().unwrap_or_else(|_| args.file.clone()).to_string_lossy(),
            "dimensions": {
                "width": image_info.width,
                "height": image_info.height
            },
            "format": image_info.format,
            "annotations": {
                "count": annotation_count,
                "by_type": by_type
            },
            "ocr": {
                "cached": ocr_cached.0,
                "text_regions": ocr_cached.1
            },
            "session": session_info
        });

        println!(
            "{}",
            serde_json::to_string_pretty(&json_output).unwrap_or_default()
        );
    } else {
        // Text output
        let canonical_path = args
            .file
            .canonicalize()
            .unwrap_or_else(|_| args.file.clone());

        println!("Path: {}", canonical_path.display());
        println!("Dimensions: {}x{}", image_info.width, image_info.height);
        println!("Format: {}", image_info.format);

        // Annotations summary
        if annotation_count == 0 {
            println!("Annotations: 0");
        } else {
            let type_summary: Vec<String> = type_counts
                .iter()
                .map(|(t, c)| format!("{} {}", c, t))
                .collect();
            println!("Annotations: {} ({})", annotation_count, type_summary.join(", "));
        }

        // OCR cache status
        if ocr_cached.0 {
            println!("OCR cached: yes ({} regions)", ocr_cached.1);
        } else {
            println!("OCR cached: no");
        }

        // Session status
        if let Some(ref info) = session_info {
            if let Some(pid) = info.get("pid").and_then(|p| p.as_u64()) {
                println!("Session: open in GUI (PID {})", pid);
            }
        } else {
            println!("Session: not open");
        }
    }

    Ok(())
}

/// Execute the import command (create .nib file without opening GUI)
///
/// Supports --migrate-sidecar to import JSON sidecar annotations and
/// --recursive for directory processing.
pub fn run_import(args: &ImportArgs) -> Result<()> {
    tracing::info!(?args, "Running import");

    // Handle directory migration mode
    if args.file.is_dir() {
        if args.migrate_sidecar || args.recursive {
            migrate_directory(&args.file, args.recursive, args.delete_sidecar)?;
            return Ok(());
        } else {
            return Err(crate::core::NibError::Other(
                "Cannot import a directory. Use --recursive to migrate all images.".to_string(),
            ));
        }
    }

    // Handle single file migration
    if args.migrate_sidecar {
        migrate_single_file(&args.file, args.output.as_ref(), args.delete_sidecar)?;
    } else {
        let nib_path = import_image_to_nib(&args.file, args.output.as_ref())?;
        println!("Created: {}", nib_path.display());
    }

    Ok(())
}

/// Wait for annotation submit event from GUI
///
/// Watches a .nib file for annotation changes and outputs events.
/// In default mode, exits after first event. Use --stream for continuous output.
pub async fn run_await_submit(args: &super::args::AwaitSubmitArgs) -> Result<()> {
    tracing::info!(?args, "Running await-submit");

    // Verify the file exists
    if !args.file.exists() {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::NotFound(format!(
                "File not found: {}",
                args.file.display()
            )),
        ));
    }

    // Verify it's a .nib file
    if args.file.extension().map(|e| e != "nib").unwrap_or(true) {
        return Err(crate::core::NibError::Other(format!(
            "Expected a .nib file, got: {}",
            args.file.display()
        )));
    }

    // Open the .nib file to get initial state
    let nib = NibFile::open(&args.file)?;
    let mut last_modified_at = nib.latest_annotation_modified_at()?.unwrap_or(0);
    let initial_count = nib.annotation_count()?;
    drop(nib);

    // In stream mode, show human-friendly header
    if !args.json && args.stream {
        println!("Watching: {}", args.file.display());
        println!("Initial annotations: {}", initial_count);
        println!("Poll interval: {}ms", args.interval);
        println!("Press Ctrl+C to stop.\n");
    }

    let poll_duration = Duration::from_millis(args.interval);
    let start_time = std::time::Instant::now();
    let timeout_duration = if args.timeout > 0 {
        Some(Duration::from_secs(args.timeout))
    } else {
        None
    };

    // Watch loop
    loop {
        // Check timeout (only in blocking mode, not stream mode)
        if !args.stream {
            if let Some(timeout) = timeout_duration {
                if start_time.elapsed() >= timeout {
                    if args.json {
                        println!(r#"{{"event":"timeout","reason":"no_events"}}"#);
                    } else {
                        println!("Timeout: no events after {}s", args.timeout);
                    }
                    return Ok(());
                }
            }
        }

        tokio::time::sleep(poll_duration).await;

        // Reopen the file to check for changes (WAL mode allows concurrent access)
        let nib = match NibFile::open(&args.file) {
            Ok(n) => n,
            Err(e) => {
                tracing::warn!("Error opening .nib file: {}", e);
                continue;
            }
        };

        // Check for new/modified annotations since last check
        let new_annotations = match nib.list_annotations_since(last_modified_at) {
            Ok(a) => a,
            Err(e) => {
                tracing::warn!("Error listing annotations: {}", e);
                continue;
            }
        };

        if !new_annotations.is_empty() {
            // Update the high-water mark
            if let Some(latest) = nib.latest_annotation_modified_at()? {
                last_modified_at = latest;
            }

            for annotation in &new_annotations {
                if args.json {
                    // JSON output for each change
                    let modified_unix = annotation
                        .modified_at
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);

                    let json_output = serde_json::json!({
                        "event": "annotation_changed",
                        "id": format!("a{}", annotation.id.0),
                        "type": annotation.annotation_type.type_name(),
                        "color": format!("#{:02x}{:02x}{:02x}", annotation.color.r, annotation.color.g, annotation.color.b),
                        "modified_at": modified_unix,
                        "visible": annotation.visible,
                        "locked": annotation.locked
                    });
                    println!("{}", serde_json::to_string(&json_output).unwrap_or_default());
                } else {
                    // Human-readable output
                    let timestamp = DateTime::<Local>::from(annotation.modified_at);
                    println!(
                        "[{}] a{} {} updated",
                        timestamp.format("%H:%M:%S"),
                        annotation.id.0,
                        annotation.annotation_type.type_name()
                    );
                }
            }

            // In blocking mode (default), exit after first event batch
            if !args.stream {
                return Ok(());
            }
        }
    }
}

/// Import an image file to create a .nib file
fn import_image_to_nib(image_path: &PathBuf, output: Option<&PathBuf>) -> Result<PathBuf> {
    // Verify the image file exists
    if !image_path.exists() {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::NotFound(format!(
                "File not found: {}",
                image_path.display()
            )),
        ));
    }

    // Read the image
    let image_data = std::fs::read(image_path)?;
    let img = image::load_from_memory(&image_data).map_err(|e| {
        crate::core::NibError::Image(crate::core::ImageError::DecodeError(e.to_string()))
    })?;

    // Determine format from extension
    let extension = image_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();

    let format = match extension.as_str() {
        "jpg" | "jpeg" => "jpeg",
        "webp" => "webp",
        _ => "png",
    };

    // Determine output path
    let nib_path = output.cloned().unwrap_or_else(|| {
        let stem = image_path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy();
        image_path.with_file_name(format!("{}.nib", stem))
    });

    // Check if .nib file already exists
    if nib_path.exists() {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::InvalidFormat(format!(
                "File already exists: {}. Use `nib info` to inspect or delete and retry.",
                nib_path.display()
            )),
        ));
    }

    // Create the .nib file
    let nib = NibFile::create(
        &nib_path,
        &image_data,
        format,
        img.width(),
        img.height(),
    )?;

    // Set original path metadata
    if let Ok(canonical) = image_path.canonicalize() {
        nib.set_original_path(&canonical.to_string_lossy())?;
    }

    // Save to ensure all data is written
    nib.save()?;

    Ok(nib_path)
}

/// Check if a .nib file has OCR cache entries
/// Returns (has_cache, count)
fn nib_has_ocr_cache(path: &PathBuf) -> Result<(bool, usize)> {
    use rusqlite::Connection;

    let conn = Connection::open(path).map_err(|e| {
        crate::core::NibError::Storage(crate::core::StorageError::Database(e.to_string()))
    })?;

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM ocr_cache", [], |row| row.get(0))
        .unwrap_or(0);

    Ok((count > 0, count as usize))
}

/// Get session info for a .nib file
fn get_nib_session_info(path: &PathBuf) -> Result<Option<serde_json::Value>> {
    use rusqlite::{Connection, OptionalExtension};

    let conn = Connection::open(path).map_err(|e| {
        crate::core::NibError::Storage(crate::core::StorageError::Database(e.to_string()))
    })?;

    let result: Option<(Option<i64>, Option<i64>, Option<i64>)> = conn
        .query_row(
            "SELECT gui_pid, opened_at, last_activity FROM session WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| {
            crate::core::NibError::Storage(crate::core::StorageError::Database(e.to_string()))
        })?;

    match result {
        Some((Some(pid), opened_at, last_activity)) => {
            // Check if the process is still alive
            if crate::storage::sessions::is_process_alive(pid as u32) {
                Ok(Some(serde_json::json!({
                    "open_in_gui": true,
                    "pid": pid,
                    "opened_at": opened_at,
                    "last_activity": last_activity
                })))
            } else {
                Ok(None)
            }
        }
        _ => Ok(None),
    }
}

/// Parse a grid region string in "x1,y1,x2,y2" format
fn parse_grid_region(region_str: &str) -> Result<crate::core::tile::TileBounds> {
    use crate::core::tile::TileBounds;

    let parts: Vec<&str> = region_str.split(',').collect();
    if parts.len() != 4 {
        return Err(crate::core::NibError::Other(format!(
            "Invalid region format '{}'. Expected 'x1,y1,x2,y2'",
            region_str
        )));
    }

    let x1 = parts[0].trim().parse::<f64>().map_err(|_| {
        crate::core::NibError::Other(format!("Invalid x1 coordinate: {}", parts[0]))
    })?;
    let y1 = parts[1].trim().parse::<f64>().map_err(|_| {
        crate::core::NibError::Other(format!("Invalid y1 coordinate: {}", parts[1]))
    })?;
    let x2 = parts[2].trim().parse::<f64>().map_err(|_| {
        crate::core::NibError::Other(format!("Invalid x2 coordinate: {}", parts[2]))
    })?;
    let y2 = parts[3].trim().parse::<f64>().map_err(|_| {
        crate::core::NibError::Other(format!("Invalid y2 coordinate: {}", parts[3]))
    })?;

    Ok(TileBounds::from_corners(x1, y1, x2, y2))
}

/// Migrate a single image file to .nib format
fn migrate_single_file(
    image_path: &PathBuf,
    output: Option<&PathBuf>,
    delete_sidecar: bool,
) -> Result<()> {
    // Verify it's an image file (not already a .nib)
    let extension = image_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if extension == "nib" {
        println!("Skipping {}: already a .nib file", image_path.display());
        return Ok(());
    }

    if !["png", "jpg", "jpeg", "webp"].contains(&extension.as_str()) {
        return Err(crate::core::NibError::Other(format!(
            "Unsupported image format: {}. Supported: png, jpg, jpeg, webp",
            extension
        )));
    }

    // Read the image
    let image_data = std::fs::read(image_path)?;
    let img = image::load_from_memory(&image_data).map_err(|e| {
        crate::core::NibError::Image(crate::core::ImageError::DecodeError(e.to_string()))
    })?;

    // Determine format from extension
    let format = match extension.as_str() {
        "jpg" | "jpeg" => "jpeg",
        "webp" => "webp",
        _ => "png",
    };

    // Determine output path
    let nib_path = output.cloned().unwrap_or_else(|| {
        let stem = image_path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy();
        image_path.with_file_name(format!("{}.nib", stem))
    });

    // Check if .nib file already exists
    if nib_path.exists() {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::InvalidFormat(format!(
                "Output file already exists: {}",
                nib_path.display()
            )),
        ));
    }

    // Create the .nib file
    let nib = NibFile::create(&nib_path, &image_data, format, img.width(), img.height())?;

    // Set original path metadata
    if let Ok(canonical) = image_path.canonicalize() {
        nib.set_original_path(&canonical.to_string_lossy())?;
    }

    // Load annotations from sidecar file if it exists
    let sidecar_path = convert::sidecar_path_for_image(image_path);
    let mut annotation_count = 0;

    if sidecar_path.exists() {
        let annotations = convert::load_sidecar_annotations(image_path);
        annotation_count = annotations.len();

        for annotation in annotations {
            nib.add_annotation(&annotation)?;
        }
    }

    // Save to ensure all data is written
    nib.save()?;

    println!(
        "Migrated: {} -> {} ({} annotations)",
        image_path.display(),
        nib_path.display(),
        annotation_count
    );

    // Delete sidecar file if requested and migration was successful
    if delete_sidecar && sidecar_path.exists() {
        std::fs::remove_file(&sidecar_path)?;
        println!("  Deleted sidecar: {}", sidecar_path.display());
    }

    Ok(())
}

/// Migrate all images in a directory to .nib format
fn migrate_directory(dir: &PathBuf, recursive: bool, delete_sidecar: bool) -> Result<()> {
    let entries = std::fs::read_dir(dir)?;

    let mut migrated = 0;
    let mut skipped = 0;
    let mut errors = 0;

    for entry in entries {
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            if recursive {
                println!("Entering directory: {}", path.display());
                migrate_directory(&path, recursive, delete_sidecar)?;
            }
            continue;
        }

        // Check if it's an image file
        let extension = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        // Skip non-image files and sidecar files
        if !["png", "jpg", "jpeg", "webp"].contains(&extension.as_str()) {
            continue;
        }

        // Check if sidecar exists (only migrate files with annotations)
        let sidecar_path = convert::sidecar_path_for_image(&path);
        if !sidecar_path.exists() {
            skipped += 1;
            continue;
        }

        match migrate_single_file(&path, None, delete_sidecar) {
            Ok(_) => migrated += 1,
            Err(e) => {
                eprintln!("Error migrating {}: {}", path.display(), e);
                errors += 1;
            }
        }
    }

    println!(
        "\nMigration complete: {} migrated, {} skipped (no sidecar), {} errors",
        migrated, skipped, errors
    );

    Ok(())
}

// =============================================================================
// Tiled capture CLI commands
// =============================================================================

/// Execute the query command (query tiled capture for point or region)
pub fn run_tile_query(args: &TileQueryArgs, format: &OutputFormat) -> Result<()> {
    tracing::info!(?args, "Running query");

    // Open the tiled capture
    let capture = TiledCapture::open(&args.capture_dir).map_err(|e| {
        crate::core::NibError::Other(format!("Failed to open tiled capture: {}", e))
    })?;

    let max_zoom = capture.manifest.tile_config.max_zoom;
    let zoom = args.zoom.unwrap_or(max_zoom);

    // Parse and execute query
    if let Some(ref point_str) = args.point {
        // Point query
        let (x, y) = parse_point(point_str)?;

        let tile_id = capture.tile_at_point(x, y, zoom).ok_or_else(|| {
            crate::core::NibError::Other(format!(
                "Point ({}, {}) is outside image bounds",
                x, y
            ))
        })?;

        let bounds = capture.tile_bounds(tile_id);

        // Build response
        let response = serde_json::json!({
            "type": "point",
            "x": x,
            "y": y,
            "zoom": zoom,
            "tile": {
                "id": format!("z{}/{}_{}", tile_id.zoom, tile_id.x, tile_id.y),
                "zoom": tile_id.zoom,
                "x": tile_id.x,
                "y": tile_id.y
            },
            "bounds": {
                "min_x": bounds.min_x,
                "min_y": bounds.min_y,
                "max_x": bounds.max_x,
                "max_y": bounds.max_y
            }
        });

        match format {
            OutputFormat::Json => {
                println!("{}", serde_json::to_string_pretty(&response).unwrap_or_default());
            }
            OutputFormat::Text => {
                println!("Point ({}, {}) at zoom {}", x, y, zoom);
                println!("  Tile: z{}/{}_{}", tile_id.zoom, tile_id.x, tile_id.y);
                println!(
                    "  Bounds: ({:.0},{:.0}) - ({:.0},{:.0})",
                    bounds.min_x, bounds.min_y, bounds.max_x, bounds.max_y
                );
            }
        }
    } else if let Some(ref region_str) = args.region {
        // Region query
        let bounds = parse_tile_region(region_str)?;
        let tiles = capture.tiles_intersecting(&bounds, zoom);

        let tile_info: Vec<serde_json::Value> = tiles
            .iter()
            .map(|entry| {
                let b = &entry.bounds;
                serde_json::json!({
                    "id": format!("z{}/{}_{}", entry.tile_id.zoom, entry.tile_id.x, entry.tile_id.y),
                    "zoom": entry.tile_id.zoom,
                    "x": entry.tile_id.x,
                    "y": entry.tile_id.y,
                    "bounds": {
                        "min_x": b.min_x,
                        "min_y": b.min_y,
                        "max_x": b.max_x,
                        "max_y": b.max_y
                    }
                })
            })
            .collect();

        let response = serde_json::json!({
            "type": "region",
            "bounds": {
                "min_x": bounds.min_x,
                "min_y": bounds.min_y,
                "max_x": bounds.max_x,
                "max_y": bounds.max_y,
                "width": bounds.width(),
                "height": bounds.height()
            },
            "zoom": zoom,
            "tile_count": tiles.len(),
            "tiles": tile_info
        });

        match format {
            OutputFormat::Json => {
                println!("{}", serde_json::to_string_pretty(&response).unwrap_or_default());
            }
            OutputFormat::Text => {
                println!(
                    "Region ({:.0},{:.0}) - ({:.0},{:.0}) at zoom {}",
                    bounds.min_x, bounds.min_y, bounds.max_x, bounds.max_y, zoom
                );
                println!("  Tiles: {}", tiles.len());
                for entry in &tiles {
                    println!(
                        "    z{}/{}_{}: ({:.0},{:.0}) - ({:.0},{:.0})",
                        entry.tile_id.zoom,
                        entry.tile_id.x,
                        entry.tile_id.y,
                        entry.bounds.min_x,
                        entry.bounds.min_y,
                        entry.bounds.max_x,
                        entry.bounds.max_y
                    );
                }
            }
        }
    } else {
        // No query specified - show capture info
        let (width, height) = capture.image_dimensions();
        let response = serde_json::json!({
            "type": "info",
            "capture_id": capture.manifest.capture_id,
            "dimensions": {
                "width": width,
                "height": height
            },
            "tile_config": {
                "tile_size": capture.manifest.tile_config.tile_size,
                "max_zoom": max_zoom,
                "zoom_levels": capture.manifest.levels.len()
            },
            "total_tiles": capture.total_tile_count()
        });

        match format {
            OutputFormat::Json => {
                println!("{}", serde_json::to_string_pretty(&response).unwrap_or_default());
            }
            OutputFormat::Text => {
                println!("Tiled capture: {}", capture.manifest.capture_id);
                println!("  Dimensions: {}x{}", width, height);
                println!(
                    "  Tile size: {}px, {} zoom levels",
                    capture.manifest.tile_config.tile_size,
                    capture.manifest.levels.len()
                );
                println!("  Total tiles: {}", capture.total_tile_count());
            }
        }
    }

    Ok(())
}

/// Execute the extract command (extract region from tiled capture)
pub fn run_tile_extract(args: &TileExtractArgs) -> Result<()> {
    tracing::info!(?args, "Running extract");

    // Open the tiled capture
    let mut capture = TiledCapture::open(&args.capture_dir).map_err(|e| {
        crate::core::NibError::Other(format!("Failed to open tiled capture: {}", e))
    })?;

    // Parse region
    let bounds = parse_tile_region(&args.region)?;

    // Extract region
    let extracted = capture.extract_region(&bounds).map_err(|e| {
        crate::core::NibError::Other(format!("Failed to extract region: {}", e))
    })?;

    // Save to output
    extracted.save(&args.output).map_err(|e| {
        crate::core::NibError::Image(crate::core::ImageError::EncodeError(e.to_string()))
    })?;

    println!("Extracted region to: {}", args.output.display());
    println!("  Region: ({:.0},{:.0}) - ({:.0},{:.0})",
        bounds.min_x, bounds.min_y, bounds.max_x, bounds.max_y);
    println!("  Size: {}x{}", extracted.width(), extracted.height());

    Ok(())
}

/// Execute the tiles command (list tiles in a tiled capture)
pub fn run_tile_list(args: &TileListArgs, format: &OutputFormat) -> Result<()> {
    tracing::info!(?args, "Running tiles");

    // Open the tiled capture
    let capture = TiledCapture::open(&args.capture_dir).map_err(|e| {
        crate::core::NibError::Other(format!("Failed to open tiled capture: {}", e))
    })?;

    let max_zoom = capture.manifest.tile_config.max_zoom;
    let zoom = args.zoom.unwrap_or(max_zoom);

    let level = capture
        .manifest
        .levels
        .get(zoom as usize)
        .ok_or_else(|| {
            crate::core::NibError::Other(format!(
                "Invalid zoom level {}. Max is {}",
                zoom, max_zoom
            ))
        })?;

    // Build tile list
    let mut tiles: Vec<serde_json::Value> = Vec::new();

    for y in 0..level.grid_height {
        for x in 0..level.grid_width {
            let tile_id = TileId::new(zoom, x, y);
            let bounds = capture.tile_bounds(tile_id);

            let tile_info = if args.verbose {
                serde_json::json!({
                    "id": format!("z{}/{}_{}", zoom, x, y),
                    "x": x,
                    "y": y,
                    "bounds": {
                        "min_x": bounds.min_x,
                        "min_y": bounds.min_y,
                        "max_x": bounds.max_x,
                        "max_y": bounds.max_y
                    }
                })
            } else {
                serde_json::json!({
                    "id": format!("z{}/{}_{}", zoom, x, y),
                    "x": x,
                    "y": y
                })
            };

            tiles.push(tile_info);
        }
    }

    let response = serde_json::json!({
        "zoom": zoom,
        "scale": level.scale,
        "grid": {
            "width": level.grid_width,
            "height": level.grid_height
        },
        "tile_count": level.tile_count,
        "tiles": tiles
    });

    match format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&response).unwrap_or_default());
        }
        OutputFormat::Text => {
            println!("Tiles at zoom level {}:", zoom);
            println!("  Scale: {:.2}x", level.scale);
            println!("  Grid: {}x{}", level.grid_width, level.grid_height);
            println!("  Total: {} tiles", level.tile_count);

            if args.verbose {
                println!();
                for y in 0..level.grid_height {
                    for x in 0..level.grid_width {
                        let tile_id = TileId::new(zoom, x, y);
                        let bounds = capture.tile_bounds(tile_id);
                        println!(
                            "  z{}/{}_{}: ({:.0},{:.0}) - ({:.0},{:.0})",
                            zoom, x, y, bounds.min_x, bounds.min_y, bounds.max_x, bounds.max_y
                        );
                    }
                }
            }
        }
    }

    Ok(())
}

/// Parse a point string "x,y" into coordinates
fn parse_point(point_str: &str) -> Result<(f64, f64)> {
    let parts: Vec<&str> = point_str.split(',').collect();
    if parts.len() != 2 {
        return Err(crate::core::NibError::Other(format!(
            "Invalid point format '{}'. Expected 'x,y'",
            point_str
        )));
    }

    let x = parts[0].trim().parse::<f64>().map_err(|_| {
        crate::core::NibError::Other(format!("Invalid x coordinate: {}", parts[0]))
    })?;
    let y = parts[1].trim().parse::<f64>().map_err(|_| {
        crate::core::NibError::Other(format!("Invalid y coordinate: {}", parts[1]))
    })?;

    Ok((x, y))
}

/// Parse a region string "x,y,width,height" into TileBounds
fn parse_tile_region(region_str: &str) -> Result<TileBounds> {
    let parts: Vec<&str> = region_str.split(',').collect();
    if parts.len() != 4 {
        return Err(crate::core::NibError::Other(format!(
            "Invalid region format '{}'. Expected 'x,y,width,height'",
            region_str
        )));
    }

    let x = parts[0].trim().parse::<f64>().map_err(|_| {
        crate::core::NibError::Other(format!("Invalid x coordinate: {}", parts[0]))
    })?;
    let y = parts[1].trim().parse::<f64>().map_err(|_| {
        crate::core::NibError::Other(format!("Invalid y coordinate: {}", parts[1]))
    })?;
    let width = parts[2].trim().parse::<f64>().map_err(|_| {
        crate::core::NibError::Other(format!("Invalid width: {}", parts[2]))
    })?;
    let height = parts[3].trim().parse::<f64>().map_err(|_| {
        crate::core::NibError::Other(format!("Invalid height: {}", parts[3]))
    })?;

    Ok(TileBounds::from_corners(x, y, x + width, y + height))
}

/// Execute the export command (export .nib to PNG/JSON/QML)
pub fn run_export(args: &super::args::ExportArgs) -> Result<()> {
    use super::args::ExportFormat as CliExportFormat;

    tracing::info!(?args, "Running export");

    // Verify the file exists
    if !args.file.exists() {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::NotFound(format!(
                "File not found: {}",
                args.file.display()
            )),
        ));
    }

    // Verify it's a .nib file
    if args.file.extension().map(|e| e != "nib").unwrap_or(true) {
        return Err(crate::core::NibError::Other(format!(
            "Expected a .nib file, got: {}",
            args.file.display()
        )));
    }

    // Open the .nib file
    let nib = NibFile::open(&args.file)?;

    // Get the image and annotations
    let (image_data, image_info) = nib.get_image()?;
    let annotations = nib.list_annotations()?;

    // Determine output path
    let output_path = args.output.clone().unwrap_or_else(|| {
        let stem = args.file.file_stem().unwrap_or_default().to_string_lossy();
        args.file.with_file_name(format!("{}.png", stem))
    });

    match args.export_format {
        CliExportFormat::Rendered => {
            // Export with annotations baked onto the image
            let nib_image = NibImage {
                image_data,
                width: image_info.width,
                height: image_info.height,
                source: crate::core::ImageSource::File(args.file.clone()),
                annotations,
                assets: std::collections::HashMap::new(),
                title: None,
                description: None,
                tags: Vec::new(),
                file_path: Some(args.file.clone()),
                created_at: SystemTime::now(),
                modified_at: SystemTime::now(),
            };

            let options = export::ExportOptions {
                bake_annotations: true,
                ..Default::default()
            };
            export::export_image(&nib_image, &output_path, &options)?;

            println!(
                "Exported (rendered): {} ({} annotations baked)",
                output_path.display(),
                nib_image.annotations.len()
            );
        }
        CliExportFormat::Json => {
            // Export PNG + JSON sidecar file
            // First, save the raw image data
            std::fs::write(&output_path, &image_data)?;

            // Then save the annotations as a sidecar
            convert::save_sidecar_annotations(&output_path, &annotations)?;

            let sidecar_path = convert::sidecar_path_for_image(&output_path);
            println!("Exported (json):");
            println!("  Image: {}", output_path.display());
            println!("  Sidecar: {}", sidecar_path.display());
            println!("  Annotations: {}", annotations.len());
        }
        CliExportFormat::Qml => {
            // Export PNG with embedded QML tEXt chunk
            let nib_image = NibImage {
                image_data,
                width: image_info.width,
                height: image_info.height,
                source: crate::core::ImageSource::File(args.file.clone()),
                annotations,
                assets: std::collections::HashMap::new(),
                title: None,
                description: None,
                tags: Vec::new(),
                file_path: Some(args.file.clone()),
                created_at: SystemTime::now(),
                modified_at: SystemTime::now(),
            };

            qml_file::save_qml_image(&nib_image, &output_path)?;

            println!(
                "Exported (qml): {} ({} annotations embedded)",
                output_path.display(),
                nib_image.annotations.len()
            );
        }
    }

    Ok(())
}

/// Execute the generate command — shells out to the configured generator
/// (default: imago) to produce an image, then optionally imports it to
/// .nib and/or hands it to the human via the feedback flow.
pub async fn run_generate(args: &super::args::GenerateArgs, format: &OutputFormat) -> Result<()> {
    tracing::info!(?args, "Running generate");

    let config = crate::config::load();
    let out_path = args
        .out
        .clone()
        .unwrap_or_else(crate::external::default_output_path);

    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let request = crate::external::GenerateRequest {
        prompt: &args.prompt,
        width: args.width,
        height: args.height,
        out: &out_path,
        references: &args.reference,
        crop: args.crop,
        timeout: args.timeout.as_deref(),
    };

    // No kill timer: generation can legitimately take 12+ minutes.
    let mut result = crate::external::generate(&config, &request)?;

    // The generator's `cta` suggests its own follow-up commands (e.g. "imago
    // compare"); through nib the next step is `nib judge`, so drop it.
    if let Some(obj) = result.as_object_mut() {
        obj.remove("cta");
    }

    match format {
        OutputFormat::Json => println!("{}", serde_json::to_string(&result).unwrap_or_default()),
        OutputFormat::Text => println!("Generated: {}", out_path.display()),
    }

    if args.nib {
        let nib_path = import_image_to_nib(&out_path, None)?;
        if matches!(format, OutputFormat::Text) {
            println!("Imported: {}", nib_path.display());
        }
    }

    if args.feedback {
        let feedback_args = super::args::FeedbackArgs {
            file: out_path.clone(),
            message: args.message.clone(),
            annotations: None,
            timeout: 0,
        };
        run_feedback(&feedback_args).await?;
    }

    Ok(())
}

/// Execute the judge command — shells out to the configured judge tool
/// (default: imago compare) and passes its verdict through. Exit code
/// mirrors the verdict: 0 for READY, 2 for BLOCKED, non-zero for any
/// other tool failure.
pub fn run_judge(args: &super::args::JudgeArgs, format: &OutputFormat) -> Result<()> {
    tracing::info!(?args, "Running judge");

    let config = crate::config::load();
    let request = crate::external::JudgeRequest {
        expected: &args.expected,
        actual: &args.actual,
        timeout: args.timeout.as_deref(),
        open: args.open,
    };

    let result = crate::external::judge(&config, &request)?;

    let verdict = result
        .get("verdict")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            crate::core::NibError::Other(format!(
                "Judge output missing 'verdict' field: {}",
                result
            ))
        })?
        .to_string();

    match format {
        OutputFormat::Json => println!("{}", serde_json::to_string(&result).unwrap_or_default()),
        OutputFormat::Text => println!("Verdict: {}", verdict),
    }

    match verdict.as_str() {
        "READY" => Ok(()),
        "BLOCKED" => std::process::exit(2),
        other => Err(crate::core::NibError::Other(format!(
            "Unexpected verdict: {}",
            other
        ))),
    }
}

/// Execute the windows command (list capturable windows)
pub fn run_windows(args: &WindowsArgs) -> Result<()> {
    tracing::info!(?args, "Running windows");

    let windows = crate::capture::window::list_windows()
        .map_err(|e| crate::core::NibError::Other(format!("Failed to list windows: {}", e)))?;

    // Filter by app name if provided
    let filtered: Vec<_> = if let Some(ref app) = args.app {
        let app_lower = app.to_lowercase();
        windows
            .into_iter()
            .filter(|w| w.app_name.to_lowercase().contains(&app_lower))
            .collect()
    } else {
        windows
    };

    if args.json {
        let json_windows: Vec<serde_json::Value> = filtered
            .iter()
            .map(|w| {
                serde_json::json!({
                    "id": w.id,
                    "app_name": w.app_name,
                    "title": w.title,
                    "x": w.x,
                    "y": w.y,
                    "width": w.width,
                    "height": w.height,
                    "focused": w.is_focused,
                })
            })
            .collect();
        println!(
            "{}",
            serde_json::to_string_pretty(&json_windows).unwrap()
        );
    } else {
        if filtered.is_empty() {
            println!("No windows found.");
            return Ok(());
        }
        for w in &filtered {
            let focus = if w.is_focused { " [FOCUSED]" } else { "" };
            println!(
                "{}: \"{}\" ({}x{} at {},{}){}",
                w.app_name, w.title, w.width, w.height, w.x, w.y, focus
            );
        }
        println!("\n{} window(s) found", filtered.len());
    }

    Ok(())
}

/// Run the MCP server for Claude Code integration
#[cfg(feature = "mcp")]
pub async fn run_mcp_server(args: &McpServerArgs) -> Result<()> {
    tracing::info!(?args, "Starting MCP server");

    crate::mcp::run_mcp_server(args.image.clone()).await
}

/// Ask human for visual feedback via GUI
///
/// This command is optimized for Claude-human collaboration:
/// 1. Try connecting to existing GUI session
/// 2. If no session and not --no-gui, spawn GUI subprocess
/// 3. Retry connection with backoff
/// 4. Send annotations (--annotations) and message (-m) if provided
/// 5. Request quit after response if --quit-after
/// 6. Wait for SendToAgent response
/// 7. Print JSON and optionally render
pub async fn run_feedback(args: &super::args::FeedbackArgs) -> Result<()> {
    use super::annotation_json;

    tracing::info!(?args, "Running feedback");

    // Verify file exists
    if !args.file.exists() {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::NotFound(format!(
                "File not found: {}",
                args.file.display()
            )),
        ));
    }

    // Determine if this is an image or .nib file
    let extension = args.file.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let is_image = matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif");
    let is_nib = extension == "nib";

    if !is_image && !is_nib {
        return Err(crate::core::NibError::Other(format!(
            "Unsupported file type: {}. Expected .nib or image (.png, .jpg, .webp)",
            args.file.display()
        )));
    }

    // Get or create the .nib file path
    let nib_path = if is_image {
        let nib_path = args.file.with_extension("nib");
        if !nib_path.exists() {
            let image_data = std::fs::read(&args.file)?;
            let img = image::load_from_memory(&image_data).map_err(|e| {
                crate::core::NibError::Image(crate::core::ImageError::DecodeError(e.to_string()))
            })?;
            let (width, height) = (img.width(), img.height());
            NibFile::create(&nib_path, &image_data, &extension, width, height)?;
        }
        nib_path
    } else {
        args.file.clone()
    };

    let timeout_duration = if args.timeout > 0 {
        Duration::from_secs(args.timeout)
    } else {
        Duration::from_secs(3600) // 1 hour default
    };

    // Step 1: Try connecting to an existing GUI session first
    let session = match Session::connect(&nib_path, ClientType::Cli).await {
        Ok(session) => {
            tracing::info!("Connected to existing collab session");
            session
        }
        Err(e) => {
            tracing::debug!("No existing session: {}", e);

            // Step 2: Spawn GUI subprocess
            let exe_path = std::env::current_exe().map_err(|e| {
                crate::core::NibError::Other(format!("Failed to get executable path: {}", e))
            })?;

            let _child = std::process::Command::new(&exe_path)
                .arg("gui")
                .arg(&nib_path)
                .spawn()
                .map_err(|e| {
                    crate::core::NibError::Other(format!("Failed to spawn GUI: {}", e))
                })?;

            // Step 4: Retry connection with backoff (200ms intervals, 25 attempts = 5 seconds)
            let mut session_result = Err("No connection".to_string());
            for attempt in 1..=25 {
                tokio::time::sleep(Duration::from_millis(200)).await;
                match Session::connect(&nib_path, ClientType::Cli).await {
                    Ok(s) => {
                        tracing::info!("Connected to collab session on attempt {}", attempt);
                        session_result = Ok(s);
                        break;
                    }
                    Err(e) => {
                        tracing::debug!("Connection attempt {} failed: {}", attempt, e);
                    }
                }
            }

            session_result.map_err(|e| {
                crate::core::NibError::Other(format!(
                    "Failed to connect to GUI session after 25 attempts: {}",
                    e
                ))
            })?
        }
    };

    // Step 5: Parse and send annotations if provided
    if let Some(ref annotations_json) = args.annotations {
        let inputs = annotation_json::parse_annotations(annotations_json)
            .map_err(crate::core::NibError::Other)?;

        let annotation_data: Vec<_> = inputs.iter().map(|i| i.to_annotation_data()).collect();

        if !annotation_data.is_empty() {
            session.send_annotations(annotation_data).map_err(crate::core::NibError::Other)?;
            tracing::info!("Sent {} annotations to GUI", inputs.len());
        }
    }

    // Step 6: Send message if provided
    if let Some(ref message) = args.message {
        session
            .send_message(message.clone(), "claude")
            .map_err(crate::core::NibError::Other)?;
        tracing::info!("Sent message to GUI: {}", message);
    }

    // Step 7: Wait for SendToAgent response
    match session.wait_for_send(timeout_duration) {
        Ok(payload) => {
            // GUI already prepared the JSON payload with delta annotations
            println!("{}", payload);

            // Render the annotations onto the image
            let nib = NibFile::open(&nib_path)?;
            let all_annotations = nib.list_annotations()?;
            let (image_data, image_info) = nib.get_image()?;

            let stem = nib_path.file_stem().unwrap_or_default().to_string_lossy();
            let rendered_path = nib_path.with_file_name(format!("{}.rendered.png", stem));

            let nib_image = NibImage {
                image_data,
                width: image_info.width,
                height: image_info.height,
                source: crate::core::ImageSource::File(nib_path.clone()),
                annotations: all_annotations,
                assets: std::collections::HashMap::new(),
                title: None,
                description: None,
                tags: Vec::new(),
                file_path: Some(nib_path.clone()),
                created_at: SystemTime::now(),
                modified_at: SystemTime::now(),
            };

            let options = export::ExportOptions {
                bake_annotations: true,
                ..Default::default()
            };
            let _ = export::export_image(&nib_image, &rendered_path, &options);

            Ok(())
        }
        Err(e) => {
            if e.contains("Timeout") {
                let output = serde_json::json!({"event": "timeout"});
                println!("{}", serde_json::to_string(&output).unwrap_or_default());
                Ok(())
            } else {
                tracing::warn!("Collab wait failed: {}", e);
                Err(crate::core::NibError::Other(format!("Wait failed: {}", e)))
            }
        }
    }
}

