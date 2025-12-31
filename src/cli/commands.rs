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
use crate::gui::{NibApp, annotations_file_path, AnnotationsFile};
use crate::storage::{
    self, convert, export, index::Index, nib_file::NibFile, qml_file, sessions::SessionRegistry,
};
use arboard::Clipboard;
use chrono::{DateTime, Local};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Default mode: nib <file> - watch for annotation changes (blocking mode with JSON output)
///
/// If file is an image (.png, .jpg, .webp), creates a .nib file first.
/// Then watches for annotation changes and exits after first event.
pub async fn run_default_watch(file: &PathBuf, timeout: u64) -> Result<()> {
    // Verify file exists
    if !file.exists() {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::NotFound(format!(
                "File not found: {}",
                file.display()
            )),
        ));
    }

    // Determine if this is an image or .nib file
    let extension = file.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let is_image = matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif");
    let is_nib = extension == "nib";

    if !is_image && !is_nib {
        return Err(crate::core::NibError::Other(format!(
            "Unsupported file type: {}. Expected .nib or image (.png, .jpg, .webp)",
            file.display()
        )));
    }

    // Get or create the .nib file path
    let nib_path = if is_image {
        // Create .nib from image
        let nib_path = file.with_extension("nib");
        if !nib_path.exists() {
            // Read and create .nib file
            let image_data = std::fs::read(file)?;
            let img = image::load_from_memory(&image_data).map_err(|e| {
                crate::core::NibError::Image(crate::core::ImageError::DecodeError(e.to_string()))
            })?;
            let (width, height) = (img.width(), img.height());
            NibFile::create(&nib_path, &image_data, &extension, width, height)?;
            // Output the created path as JSON for the agent
            let json = serde_json::json!({
                "event": "nib_created",
                "path": nib_path.display().to_string()
            });
            println!("{}", serde_json::to_string(&json).unwrap_or_default());
        }
        nib_path
    } else {
        file.clone()
    };

    // Now watch the .nib file using the standard watch logic
    let watch_args = WatchArgs {
        file: nib_path,
        json: true,
        interval: 100,
        stream: false,
        timeout,
    };

    run_watch(&watch_args).await
}

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
        .map_err(crate::core::NibError::Other)?;

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
                .map_err(crate::core::NibError::Other)?;
        }
        println!("Added annotations from: {}", qml_path.display());
    }

    // Add annotations from QML string if provided
    if let Some(ref qml_str) = args.add {
        let new_annotations = qml::parse_qml_str(qml_str)?;
        for annotation in new_annotations {
            session
                .add_annotation(annotation)
                .map_err(crate::core::NibError::Other)?;
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
            .map_err(crate::core::NibError::Other)?;
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

/// Execute the annotations command (read annotations from sidecar JSON file or .nib file)
pub fn run_annotations(args: &AnnotationsArgs) -> Result<()> {
    tracing::info!(?args, "Running annotations");

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
                            crate::gui::AnnotationGeometry::Path { points } => {
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
fn run_annotations_nib(args: &AnnotationsArgs) -> Result<()> {
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

/// Execute the add-annotation command (add annotation to sidecar file or .nib file)
pub fn run_add_annotation(args: &AddAnnotationArgs) -> Result<()> {
    use crate::core::{Annotation, AnnotationType, ArrowHead, BlurIntensity, Color, Point, Region, StrokeStyle, TextAlign};

    tracing::info!(?args, "Running add-annotation");

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

    // Handle regular image files with JSON sidecar format
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

    println!("[NIB {}] claude added [{}] {} at ({}, {})",
        crate::events::timestamp_ms(),
        new_annotation.id,
        args.annotation_type,
        args.x,
        args.y
    );
    println!("Saved to: {}", annotations_path.display());

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

    let annotations_path = annotations_file_path(&args.file);

    // Load annotations from sidecar file
    let annotations: Vec<crate::core::Annotation> = if annotations_path.exists() {
        let json_content = std::fs::read_to_string(&annotations_path)?;
        match serde_json::from_str::<AnnotationsFile>(&json_content) {
            Ok(file) => {
                file.annotations
                    .iter()
                    .filter_map(crate::gui::deserialize_annotation)
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

/// Execute the open command (import image, create .nib, open in GUI)
pub fn run_open(args: &super::args::OpenArgs) -> Result<()> {
    tracing::info!(?args, "Running open");

    // Import the image to create .nib file
    let nib_path = import_image_to_nib(&args.file, args.output.as_ref())?;

    println!("Created: {}", nib_path.display());

    // Register session
    let pid = std::process::id();
    let mut registry = SessionRegistry::load()?;
    registry.register(&nib_path, pid)?;

    println!("Opening in GUI...");

    // Launch GUI with the .nib file
    let gui_args = super::args::GuiArgs {
        file: Some(nib_path.clone()),
    };
    run_gui(&gui_args)?;

    // Unregister session when GUI exits (run_gui is blocking)
    let mut registry = SessionRegistry::load()?;
    registry.unregister(&nib_path)?;

    Ok(())
}

/// Execute the import command (create .nib file without opening GUI)
pub fn run_import(args: &super::args::ImportArgs) -> Result<()> {
    tracing::info!(?args, "Running import");

    let nib_path = import_image_to_nib(&args.file, args.output.as_ref())?;

    println!("Created: {}", nib_path.display());

    Ok(())
}

/// Execute the watch command (stream annotation changes in real-time)
pub async fn run_watch(args: &super::args::WatchArgs) -> Result<()> {
    tracing::info!(?args, "Running watch");

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

/// Execute the migrate command (convert JSON sidecar to .nib SQLite format)
pub fn run_migrate(args: &super::args::MigrateArgs) -> Result<()> {
    tracing::info!(?args, "Running migrate");

    // Verify the path exists
    if !args.path.exists() {
        return Err(crate::core::NibError::Storage(
            crate::core::StorageError::NotFound(format!(
                "Path not found: {}",
                args.path.display()
            )),
        ));
    }

    if args.path.is_dir() {
        // Migrate all images in directory
        migrate_directory(&args.path, args.recursive, args.delete_sidecar)?;
    } else {
        // Migrate single file
        migrate_single_file(&args.path, args.output.as_ref(), args.delete_sidecar)?;
    }

    Ok(())
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
pub fn run_query(args: &QueryArgs, format: &OutputFormat) -> Result<()> {
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
pub fn run_extract(args: &ExtractArgs) -> Result<()> {
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
pub fn run_tiles(args: &TilesArgs, format: &OutputFormat) -> Result<()> {
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


/// Run the MCP server for Claude Code integration
pub async fn run_mcp_server(args: &McpServerArgs) -> Result<()> {
    tracing::info!(?args, "Starting MCP server");
    
    crate::mcp::run_mcp_server(args.image.clone()).await
}
