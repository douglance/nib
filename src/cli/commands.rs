//! CLI command implementations

use super::args::*;
use crate::capture::screen;
use crate::collab::{
    log::SessionManager,
    session::Session,
    types::ClientType,
};
use crate::core::{qml, QuillImage, Result};
use crate::gui::QuillApp;
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
        return Err(crate::core::QuillError::Storage(
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
        .map_err(|e| crate::core::QuillError::Other(e))?;

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
                .map_err(|e| crate::core::QuillError::Other(e))?;
        }
        println!("Added annotations from: {}", qml_path.display());
    }

    // Add annotations from QML string if provided
    if let Some(ref qml_str) = args.add {
        let new_annotations = qml::parse_qml_str(qml_str)?;
        for annotation in new_annotations {
            session
                .add_annotation(annotation)
                .map_err(|e| crate::core::QuillError::Other(e))?;
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

        // Create QuillImage with updated annotations
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
            .map_err(|e| crate::core::QuillError::Other(e))?;
    }

    Ok(())
}

/// Execute the sessions command (list active sessions)
pub fn run_sessions() -> Result<()> {
    tracing::info!("Running sessions");

    let manager = SessionManager::new(SessionManager::default_dir())
        .map_err(|e| crate::core::QuillError::Other(e.to_string()))?;

    let sessions = manager
        .list_sessions()
        .map_err(|e| crate::core::QuillError::Other(e.to_string()))?;

    if sessions.is_empty() {
        println!("No active collaboration sessions.");
        println!("\nStart a session with: quill edit <image.png> --watch");
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
        println!("Use 'quill capture' to take a screenshot.");
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

    let quill_dir = storage::storage_dir();

    println!("Quill storage folder:");
    println!("  {}", quill_dir.display());
    println!();
    println!("Contents:");
    println!("  captures/  - Screenshot files");
    println!("  quill.db   - Search index");

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&quill_dir)
            .spawn()
            .ok();
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&quill_dir)
            .spawn()
            .ok();
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&quill_dir)
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
            return Err(crate::core::QuillError::Storage(
                crate::core::StorageError::NotFound(format!(
                    "File not found: {}",
                    file_path.display()
                )),
            ));
        }
        println!("Opening {} in Quill editor...", file_path.display());
        QuillApp::with_file(file_path.clone())
    } else {
        println!("Launching Quill editor...");
        QuillApp::new()
    };

    app.run().map_err(|e| crate::core::QuillError::Other(e.to_string()))?;

    Ok(())
}

// =============================================================================
// Helper functions
// =============================================================================

/// Generate a unique filename for captures
fn generate_filename() -> PathBuf {
    let now = chrono::Local::now();
    let filename = format!("quill_{}.png", now.format("%Y%m%d_%H%M%S"));
    storage::captures_dir().join(filename)
}

/// Save a capture to disk
fn save_capture(image: &QuillImage, path: &PathBuf) -> Result<()> {
    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    qml_file::save_qml_image(image, path)?;
    Ok(())
}

/// Copy image to clipboard
fn copy_to_clipboard(image: &QuillImage) -> Result<()> {
    let mut clipboard = Clipboard::new().map_err(|e| {
        crate::core::QuillError::Capture(crate::core::CaptureError::CaptureFailed(e.to_string()))
    })?;

    // Load image to get raw RGBA data
    let img = image::load_from_memory(&image.image_data).map_err(|e| {
        crate::core::QuillError::Image(crate::core::ImageError::DecodeError(e.to_string()))
    })?;

    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();

    let img_data = arboard::ImageData {
        width: width as usize,
        height: height as usize,
        bytes: std::borrow::Cow::Owned(rgba.into_raw()),
    };

    clipboard.set_image(img_data).map_err(|e| {
        crate::core::QuillError::Capture(crate::core::CaptureError::CaptureFailed(e.to_string()))
    })?;

    Ok(())
}

/// Load image from clipboard
fn load_from_clipboard() -> Result<QuillImage> {
    let mut clipboard = Clipboard::new().map_err(|e| {
        crate::core::QuillError::Capture(crate::core::CaptureError::CaptureFailed(e.to_string()))
    })?;

    let img_data = clipboard.get_image().map_err(|e| {
        crate::core::QuillError::Capture(crate::core::CaptureError::CaptureFailed(format!(
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
        crate::core::QuillError::Image(crate::core::ImageError::DecodeError(
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
    .map_err(|e| crate::core::QuillError::Image(crate::core::ImageError::EncodeError(e.to_string())))?;

    Ok(QuillImage::new(
        png_data,
        img_data.width as u32,
        img_data.height as u32,
        crate::core::ImageSource::Clipboard {
            pasted_at: SystemTime::now(),
        },
    ))
}

/// Index a capture in the database
fn index_capture(image: &QuillImage, path: &PathBuf) -> Result<()> {
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
