//! CLI command implementations

use super::args::*;
use crate::capture::screen;
use crate::collab::{
    log::SessionManager,
    session::Session,
    types::ClientType,
};
use crate::core::{qml, NibImage, Result};
use crate::gui::{NibApp, annotations_file_path, AnnotationsFile};
use crate::storage::{self, export, index::Index, qml_file};
use arboard::Clipboard;
use chrono::{DateTime, Local};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Execute the capture command
pub fn run_capture(args: &CaptureArgs) -> Result<()> {
    tracing::info!(?args, "Running capture");

    // Handle delay
    if args.delay > 0 {
        println!("Capturing in {} seconds...", args.delay);
        std::thread::sleep(Duration::from_secs(args.delay as u64));
    }

    // Capture based on mode
    let image = match args.mode {
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
            // TODO: Implement window capture
            println!("Window capture not yet implemented, capturing full screen...");
            screen::capture_primary()?
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
    } else {
        let output_path = args.output.clone().unwrap_or_else(|| generate_filename());
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

/// Execute the annotate command
pub fn run_annotate(args: &AnnotateArgs) -> Result<()> {
    tracing::info!(?args, "Running annotate");

    // Load image
    let mut image = if args.clipboard {
        load_from_clipboard()?
    } else if let Some(ref path) = args.file {
        qml_file::load_qml_image(path)?
    } else {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::NotFound("No input specified".into()),
        ));
    };

    // Add annotations from QML file if provided
    if let Some(ref qml_path) = args.qml_file {
        let new_annotations = qml_file::load_qml_file(qml_path)?;
        for annotation in new_annotations {
            image.add_annotation(annotation);
        }
        println!("Added {} annotations from {}", image.annotations.len(), qml_path.display());
    }
    // Or from QML string if provided
    else if let Some(ref qml_str) = args.add {
        let new_annotations = qml::parse_qml_str(qml_str)?;
        for annotation in new_annotations {
            image.add_annotation(annotation);
        }
        println!("Added {} annotations", image.annotations.len());
    }

    if args.export_only {
        // Headless mode: export immediately
        if let Some(ref output) = args.output {
            // Use export to bake annotations onto image
            let options = export::ExportOptions {
                bake_annotations: true,
                ..Default::default()
            };
            export::export_image(&image, output, &options)?;

            // Also save QML metadata version
            let qml_path = output.with_extension("qml.png");
            qml_file::save_qml_image(&image, &qml_path)?;

            println!("Exported to: {}", output.display());
            println!("QML version: {}", qml_path.display());
        } else {
            // Print QML to stdout
            let qml_output = qml::serialize_qml_string(&image.annotations)?;
            println!("{}", qml_output);
        }
    } else {
        // GUI mode
        println!("GUI editor not yet implemented");
        println!("Use --export-only for headless mode");
    }

    Ok(())
}

/// Execute the edit command (collaborative editing)
pub async fn run_edit(args: &EditArgs) -> Result<()> {
    tracing::info!(?args, "Running edit");

    // Load existing image and annotations
    let image = qml_file::load_qml_image(&args.file)?;

    println!("Opening collaborative session for: {}", args.file.display());
    println!("Image: {}x{}", image.width, image.height);
    println!("Existing annotations: {}", image.annotations.len());

    // Open session (checks for existing sessions and connects if found)
    let session = Session::open(&args.file, ClientType::Cli)
        .await
        .map_err(|e| crate::core::NibError::Other(e))?;

    let is_owner = session.is_owner();
    println!(
        "\nSession started ({})",
        if is_owner { "owner" } else { "joined" }
    );
    println!("Session ID: {}", session.session_id());

    // Add annotations from QML file if provided
    if let Some(ref qml_path) = args.qml_file {
        let new_annotations = qml_file::load_qml_file(qml_path)?;
        for annotation in new_annotations {
            session
                .add_annotation(annotation)
                .map_err(|e| crate::core::NibError::Other(e))?;
        }
        println!("Added annotations from: {}", qml_path.display());
    }

    // Add annotations from QML string if provided
    if let Some(ref qml_str) = args.add {
        let new_annotations = qml::parse_qml_str(qml_str)?;
        for annotation in new_annotations {
            session
                .add_annotation(annotation)
                .map_err(|e| crate::core::NibError::Other(e))?;
        }
        println!("Added annotations from command line");
    }

    let annotations = session.annotations();
    println!("\nCurrent annotations: {}", annotations.len());

    if args.watch {
        println!("\nWatching for changes (Ctrl+C to stop)...");
        println!("Other clients can connect and edit this image.");
        println!("Changes will sync in real-time.\n");

        // Watch loop
        loop {
            match session.process_messages() {
                Ok(count) => {
                    if count > 0 {
                        let annotations = session.annotations();
                        println!(
                            "Received {} update(s). Total annotations: {}",
                            count,
                            annotations.len()
                        );
                    }
                }
                Err(e) => {
                    tracing::warn!("Error processing messages: {}", e);
                }
            }

            // Check for connected clients
            let clients = session.connected_clients();
            if clients.len() > 1 {
                // Show connected clients periodically
            }

            std::thread::sleep(Duration::from_millis(100));
        }
    } else {
        // Non-watch mode: apply changes and save
        let output_path = args.output.clone().unwrap_or_else(|| args.file.clone());

        // Reload annotations (may have been modified)
        let annotations = session.annotations();

        // Create NibImage with updated annotations
        let mut updated_image = image.clone();
        updated_image.annotations = annotations;

        // Save with baked annotations
        let options = export::ExportOptions {
            bake_annotations: true,
            ..Default::default()
        };
        export::export_image(&updated_image, &output_path, &options)?;

        // Also save QML version for future editing
        let qml_path = output_path.with_extension("qml.png");
        qml_file::save_qml_image(&updated_image, &qml_path)?;

        println!("\nSaved to: {}", output_path.display());
        println!("QML version: {}", qml_path.display());

        // Close session
        session
            .close()
            .map_err(|e| crate::core::NibError::Other(e))?;
    }

    Ok(())
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
        println!("\nStart a session with: nib edit <image.png> --watch");
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

/// Execute the read command
pub fn run_read(args: &ReadArgs) -> Result<()> {
    tracing::info!(?args, "Running read");

    // Determine if input is PNG or QML file
    let annotations = if args
        .file
        .extension()
        .map(|e| e == "qml")
        .unwrap_or(false)
    {
        qml_file::load_qml_file(&args.file)?
    } else {
        let image = qml_file::load_qml_image(&args.file)?;
        image.annotations
    };

    if args.raw {
        // Output raw QML
        let qml_output = qml::serialize_qml_string(&annotations)?;
        print!("{}", qml_output);
    } else {
        // Formatted output
        println!("QML Annotations from: {}", args.file.display());
        println!("{}", "─".repeat(50));

        if annotations.is_empty() {
            println!("No annotations found.");
        } else {
            println!("Found {} annotation(s):\n", annotations.len());

            for (i, annotation) in annotations.iter().enumerate() {
                let type_name = annotation.annotation_type.type_name();
                let label = annotation
                    .label
                    .as_ref()
                    .map(|l| format!(" \"{}\"", l))
                    .unwrap_or_default();
                let severity = if annotation.severity != crate::core::Severity::None {
                    format!(" [{}]", annotation.severity.as_str())
                } else {
                    String::new()
                };

                println!("  {}. {}{}{}", i + 1, type_name.to_uppercase(), label, severity);
            }
        }
    }

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

    if entries.is_empty() {
        println!("No captures found.");
        println!("Use 'nib capture' to take a screenshot.");
        return Ok(());
    }

    println!("Recent captures ({}):", entries.len());
    println!("{}", "─".repeat(60));

    for entry in &entries {
        let created = DateTime::<Local>::from(
            UNIX_EPOCH + Duration::from_secs(entry.created_at as u64),
        );
        let date_str = created.format("%Y-%m-%d %H:%M").to_string();

        let path = std::path::Path::new(&entry.path);
        let filename = path.file_name().unwrap_or_default().to_string_lossy();

        let annotations = if entry.annotation_count > 0 {
            format!(" ({} annotations)", entry.annotation_count)
        } else {
            String::new()
        };

        println!(
            "  {} │ {}x{} │ {}{}",
            date_str, entry.width, entry.height, filename, annotations
        );
    }

    println!("{}", "─".repeat(60));
    println!("Storage: {}", storage::captures_dir().display());

    Ok(())
}

/// Execute the folder command
pub fn run_folder() -> Result<()> {
    tracing::info!("Running folder");

    let nib_dir = storage::storage_dir();

    println!("Nib storage folder:");
    println!("  {}", nib_dir.display());
    println!();
    println!("Contents:");
    println!("  captures/  - Screenshot files");
    println!("  nib.db     - Search index");

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&nib_dir)
            .spawn()
            .ok();
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&nib_dir)
            .spawn()
            .ok();
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&nib_dir)
            .spawn()
            .ok();
    }

    Ok(())
}

/// Execute the gui command (launch the graphical editor)
pub fn run_gui(args: &GuiArgs) -> Result<()> {
    tracing::info!(?args, "Launching GUI");

    let app = if let Some(ref file_path) = args.file {
        // Verify file exists
        if !file_path.exists() {
            return Err(crate::core::NibError::Storage(
                crate::core::StorageError::NotFound(format!(
                    "File not found: {}",
                    file_path.display()
                )),
            ));
        }
        println!("Opening {} in Nib editor...", file_path.display());
        NibApp::with_file(file_path.clone())
    } else {
        println!("Launching Nib editor...");
        NibApp::new()
    };

    app.run().map_err(|e| crate::core::NibError::Other(e.to_string()))?;

    Ok(())
}

/// Execute the annotations command (read annotations from sidecar JSON file)
pub fn run_annotations(args: &AnnotationsArgs) -> Result<()> {
    tracing::info!(?args, "Running annotations");

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
                            crate::gui::AnnotationGeometry::Rectangle { x, y, width, height } => {
                                format!("x={:.0}, y={:.0}, w={:.0}, h={:.0}", x, y, width, height)
                            }
                            crate::gui::AnnotationGeometry::Line { start_x, start_y, end_x, end_y } => {
                                format!("({:.0},{:.0}) -> ({:.0},{:.0})", start_x, start_y, end_x, end_y)
                            }
                            crate::gui::AnnotationGeometry::Ellipse { center_x, center_y, radius_x, radius_y } => {
                                format!("center=({:.0},{:.0}), rx={:.0}, ry={:.0}", center_x, center_y, radius_x, radius_y)
                            }
                            crate::gui::AnnotationGeometry::Point { x, y, value, content } => {
                                let mut info = format!("({:.0},{:.0})", x, y);
                                if let Some(v) = value {
                                    info.push_str(&format!(" value={}", v));
                                }
                                if let Some(c) = content {
                                    info.push_str(&format!(" \"{}\"", c));
                                }
                                info
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

/// Execute the add-annotation command (add annotation to sidecar file)
pub fn run_add_annotation(args: &AddAnnotationArgs) -> Result<()> {
    tracing::info!(?args, "Running add-annotation");

    // Verify the image file exists
    if !args.file.exists() {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::NotFound(format!(
                "File not found: {}",
                args.file.display()
            )),
        ));
    }

    let annotations_path = annotations_file_path(&args.file);

    // Load existing annotations or create empty file
    let mut annotations_file = if annotations_path.exists() {
        let json_content = std::fs::read_to_string(&annotations_path)?;
        serde_json::from_str::<AnnotationsFile>(&json_content).unwrap_or_else(|_| {
            AnnotationsFile::new(&args.file.to_string_lossy(), Vec::new())
        })
    } else {
        AnnotationsFile::new(&args.file.to_string_lossy(), Vec::new())
    };

    // Determine next annotation ID (a1, a2, etc.)
    let next_id = annotations_file
        .annotations
        .iter()
        .filter_map(|a| {
            a.id.strip_prefix('a')
                .and_then(|n| n.parse::<u32>().ok())
        })
        .max()
        .unwrap_or(0) + 1;

    // Create the geometry based on annotation type
    let geometry = match args.annotation_type.as_str() {
        "rectangle" | "highlight" | "blur" | "crop" => {
            crate::gui::AnnotationGeometry::Rectangle {
                x: args.x,
                y: args.y,
                width: args.width,
                height: args.height,
            }
        }
        "arrow" | "line" => {
            crate::gui::AnnotationGeometry::Line {
                start_x: args.x,
                start_y: args.y,
                end_x: args.x + args.width,
                end_y: args.y + args.height,
            }
        }
        "ellipse" => {
            crate::gui::AnnotationGeometry::Ellipse {
                center_x: args.x + args.width / 2.0,
                center_y: args.y + args.height / 2.0,
                radius_x: args.width / 2.0,
                radius_y: args.height / 2.0,
            }
        }
        "text" => {
            crate::gui::AnnotationGeometry::Point {
                x: args.x,
                y: args.y,
                value: None,
                content: args.text.clone().or_else(|| Some("Text".to_string())),
            }
        }
        "number" => {
            crate::gui::AnnotationGeometry::Point {
                x: args.x,
                y: args.y,
                value: args.value.or(Some(next_id)),
                content: None,
            }
        }
        _ => {
            return Err(crate::core::NibError::Other(format!(
                "Unknown annotation type: {}. Valid types: rectangle, arrow, line, ellipse, highlight, blur, text, number",
                args.annotation_type
            )));
        }
    };

    // Create the new annotation
    let new_annotation = crate::gui::SerializedAnnotation {
        id: format!("a{}", next_id),
        annotation_type: args.annotation_type.clone(),
        geometry,
        color: args.color.clone(),
    };

    // Add to annotations list
    annotations_file.annotations.push(new_annotation.clone());

    // Write back to sidecar file
    let json = serde_json::to_string_pretty(&annotations_file).map_err(|e| {
        crate::core::NibError::Other(format!("Failed to serialize annotations: {}", e))
    })?;

    std::fs::write(&annotations_path, json)?;

    println!("Added annotation [{}] {} at ({}, {})",
        new_annotation.id,
        args.annotation_type,
        args.x,
        args.y
    );
    println!("Saved to: {}", annotations_path.display());

    Ok(())
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

/// Load image from clipboard
fn load_from_clipboard() -> Result<NibImage> {
    let mut clipboard = Clipboard::new().map_err(|e| {
        crate::core::NibError::Capture(crate::core::CaptureError::CaptureFailed(e.to_string()))
    })?;

    let img_data = clipboard.get_image().map_err(|e| {
        crate::core::NibError::Capture(crate::core::CaptureError::CaptureFailed(format!(
            "No image in clipboard: {}",
            e
        )))
    })?;

    // Convert to PNG
    let img = image::RgbaImage::from_raw(
        img_data.width as u32,
        img_data.height as u32,
        img_data.bytes.into_owned(),
    )
    .ok_or_else(|| {
        crate::core::NibError::Image(crate::core::ImageError::DecodeError(
            "Invalid clipboard image data".into(),
        ))
    })?;

    let mut png_data = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut png_data);
    image::ImageEncoder::write_image(
        encoder,
        &img,
        img_data.width as u32,
        img_data.height as u32,
        image::ExtendedColorType::Rgba8,
    )
    .map_err(|e| crate::core::NibError::Image(crate::core::ImageError::EncodeError(e.to_string())))?;

    Ok(NibImage::new(
        png_data,
        img_data.width as u32,
        img_data.height as u32,
        crate::core::ImageSource::Clipboard {
            pasted_at: SystemTime::now(),
        },
    ))
}

/// Parse a region string in "x,y,width,height" format.
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
        let annotations_path = annotations_file_path(&args.file);

        // Load existing annotations or create empty file
        let mut annotations_file = if annotations_path.exists() {
            let json_content = std::fs::read_to_string(&annotations_path)?;
            serde_json::from_str::<AnnotationsFile>(&json_content).unwrap_or_else(|_| {
                AnnotationsFile::new(&args.file.to_string_lossy(), Vec::new())
            })
        } else {
            AnnotationsFile::new(&args.file.to_string_lossy(), Vec::new())
        };

        // Determine next annotation ID
        let mut next_id = annotations_file
            .annotations
            .iter()
            .filter_map(|a| {
                a.id.strip_prefix('a')
                    .and_then(|n| n.parse::<u32>().ok())
            })
            .max()
            .unwrap_or(0) + 1;

        // Add highlight for each match
        for m in &results {
            let new_annotation = crate::gui::SerializedAnnotation {
                id: format!("a{}", next_id),
                annotation_type: "highlight".to_string(),
                geometry: crate::gui::AnnotationGeometry::Rectangle {
                    x: m.x as f64,
                    y: m.y as f64,
                    width: m.width as f64,
                    height: m.height as f64,
                },
                color: args.color.clone(),
            };
            annotations_file.annotations.push(new_annotation);
            next_id += 1;
        }

        // Write back to sidecar file
        let json = serde_json::to_string_pretty(&annotations_file).map_err(|e| {
            crate::core::NibError::Other(format!("Failed to serialize annotations: {}", e))
        })?;

        std::fs::write(&annotations_path, json)?;
        println!("Added {} highlight annotation(s) to: {}", results.len(), annotations_path.display());
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
fn index_capture(image: &NibImage, path: &PathBuf) -> Result<()> {
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

    let annotations_path = annotations_file_path(&args.file);

    // Load annotations from sidecar file
    let annotations: Vec<crate::core::Annotation> = if annotations_path.exists() {
        let json_content = std::fs::read_to_string(&annotations_path)?;
        match serde_json::from_str::<AnnotationsFile>(&json_content) {
            Ok(file) => {
                file.annotations
                    .iter()
                    .filter_map(|sa| crate::gui::deserialize_annotation(sa))
                    .collect()
            }
            Err(_) => Vec::new(),
        }
    } else {
        Vec::new()
    };

    // Load the base image
    let image_data = std::fs::read(&args.file)?;
    let img = image::load_from_memory(&image_data)
        .map_err(|e| crate::core::NibError::Image(crate::core::ImageError::DecodeError(e.to_string())))?;

    // Create NibImage with annotations
    let nib_image = NibImage {
        image_data,
        width: img.width(),
        height: img.height(),
        source: crate::core::ImageSource::File(args.file.clone()),
        annotations,
        title: None,
        description: None,
        tags: Vec::new(),
        file_path: Some(args.file.clone()),
        created_at: SystemTime::now(),
        modified_at: SystemTime::now(),
    };

    // Determine output path
    let output_path = args.output.clone().unwrap_or_else(|| {
        let stem = args.file.file_stem().unwrap_or_default().to_string_lossy();
        let ext = args.file.extension().unwrap_or_default().to_string_lossy();
        args.file.with_file_name(format!("{}.rendered.{}", stem, ext))
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

/// Execute the remove-annotation command
pub fn run_remove_annotation(args: &RemoveAnnotationArgs) -> Result<()> {
    tracing::info!(?args, "Running remove-annotation");

    // Verify the image file exists
    if !args.file.exists() {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::NotFound(format!(
                "File not found: {}",
                args.file.display()
            )),
        ));
    }

    let annotations_path = annotations_file_path(&args.file);

    // Load existing annotations
    if !annotations_path.exists() {
        return Err(crate::core::NibError::Other(format!(
            "No annotations file found: {}",
            annotations_path.display()
        )));
    }

    let json_content = std::fs::read_to_string(&annotations_path)?;
    let mut annotations_file = serde_json::from_str::<AnnotationsFile>(&json_content)
        .map_err(|e| crate::core::NibError::Other(format!("Failed to parse annotations: {}", e)))?;

    // Find and remove the annotation
    let original_count = annotations_file.annotations.len();
    annotations_file.annotations.retain(|a| a.id != args.id);

    if annotations_file.annotations.len() == original_count {
        return Err(crate::core::NibError::Other(format!(
            "Annotation not found: {}",
            args.id
        )));
    }

    // Write back to file
    let json = serde_json::to_string_pretty(&annotations_file)
        .map_err(|e| crate::core::NibError::Other(format!("Failed to serialize: {}", e)))?;
    std::fs::write(&annotations_path, json)?;

    println!("Removed annotation [{}]", args.id);
    println!("Remaining annotations: {}", annotations_file.annotations.len());

    Ok(())
}

/// Execute the clear-annotations command
pub fn run_clear_annotations(args: &ClearAnnotationsArgs) -> Result<()> {
    tracing::info!(?args, "Running clear-annotations");

    // Verify the image file exists
    if !args.file.exists() {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::NotFound(format!(
                "File not found: {}",
                args.file.display()
            )),
        ));
    }

    let annotations_path = annotations_file_path(&args.file);

    if !annotations_path.exists() {
        println!("No annotations to clear");
        return Ok(());
    }

    // Load to get count, then clear
    let json_content = std::fs::read_to_string(&annotations_path)?;
    let old_file = serde_json::from_str::<AnnotationsFile>(&json_content).ok();
    let removed_count = old_file.map(|f| f.annotations.len()).unwrap_or(0);

    // Create empty annotations file
    let empty_file = AnnotationsFile::new(&args.file.to_string_lossy(), Vec::new());
    let json = serde_json::to_string_pretty(&empty_file)
        .map_err(|e| crate::core::NibError::Other(format!("Failed to serialize: {}", e)))?;
    std::fs::write(&annotations_path, json)?;

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
        let render_bounds = region.clone().unwrap_or_else(|| {
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
        let render_bounds = region.clone().unwrap_or_else(|| {
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
