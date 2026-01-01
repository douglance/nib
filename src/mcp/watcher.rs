//! File watcher for annotation changes
//!
//! Watches .annotations.json sidecar files and generates events when
//! annotations are created, modified, or deleted.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex as SyncMutex;
use tokio::sync::broadcast;

use crate::{annotations_file_path, AnnotationsFile, AnnotationGeometry, SerializedAnnotation};

use super::tools::{AnnotationEvent, EventAnnotation};

/// Global sequence counter for events
static SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn next_seq() -> u64 {
    SEQUENCE.fetch_add(1, Ordering::SeqCst)
}

/// Event store for a single image
#[derive(Debug, Default)]
struct ImageEventStore {
    /// All events for this image
    events: Vec<AnnotationEvent>,
    /// Last known state of annotations (by ID)
    last_known: HashMap<String, SerializedAnnotation>,
}

/// Annotation watcher that tracks changes and generates events
pub struct AnnotationWatcher {
    /// Event stores per image path (sync mutex for use in notify callback)
    stores: Arc<SyncMutex<HashMap<PathBuf, ImageEventStore>>>,
    /// Broadcast channel for notifying waiters
    sender: broadcast::Sender<PathBuf>,
    /// File watcher handle
    _watcher: RecommendedWatcher,
}

impl AnnotationWatcher {
    /// Create a new annotation watcher
    pub fn new() -> Result<Self, notify::Error> {
        let stores: Arc<SyncMutex<HashMap<PathBuf, ImageEventStore>>> =
            Arc::new(SyncMutex::new(HashMap::new()));
        let (sender, _) = broadcast::channel(100);

        let stores_clone = stores.clone();
        let sender_clone = sender.clone();

        let watcher = notify::recommended_watcher(move |res: Result<notify::Event, _>| {
            if let Ok(event) = res {
                // Only care about modifications and creates
                if !matches!(
                    event.kind,
                    notify::EventKind::Modify(_) | notify::EventKind::Create(_)
                ) {
                    return;
                }

                for path in &event.paths {
                    // Check if this is an annotations file
                    if path.extension().map_or(false, |ext| ext == "json")
                        && path
                            .file_name()
                            .map_or(false, |n| n.to_string_lossy().contains(".annotations."))
                    {
                        // Extract the image path from the annotations path
                        if let Some(image_path) = annotations_path_to_image(path) {
                            // Process the change synchronously
                            process_annotation_change_sync(
                                &stores_clone,
                                path,
                                &image_path,
                                &sender_clone,
                            );
                        }
                    }
                }
            }
        })?;

        Ok(Self {
            stores,
            sender,
            _watcher: watcher,
        })
    }

    /// Start watching an image's annotations file
    pub fn watch(&mut self, image_path: &Path) -> Result<(), notify::Error> {
        let annotations_path = annotations_file_path(image_path);

        // Watch the parent directory (notify doesn't always work with specific files)
        if let Some(parent) = annotations_path.parent() {
            self._watcher.watch(parent, RecursiveMode::NonRecursive)?;
        }

        Ok(())
    }

    /// Get events since a sequence number
    pub async fn get_events_since(&self, image_path: &Path, since_seq: u64) -> Vec<AnnotationEvent> {
        // Canonicalize path to handle symlinks
        let image_path = image_path.canonicalize().unwrap_or_else(|_| image_path.to_path_buf());
        let stores = self.stores.lock();
        if let Some(store) = stores.get(&image_path) {
            store
                .events
                .iter()
                .filter(|e| e.seq > since_seq)
                .cloned()
                .collect()
        } else {
            Vec::new()
        }
    }

    /// Get current sequence number
    pub fn current_seq(&self) -> u64 {
        SEQUENCE.load(Ordering::SeqCst)
    }

    /// Wait for events on an image
    pub async fn wait_for_events(
        &self,
        image_path: &Path,
        timeout: Duration,
        since_seq: u64,
    ) -> (Vec<AnnotationEvent>, String) {
        // Canonicalize path to handle symlinks
        let image_path = image_path.canonicalize().unwrap_or_else(|_| image_path.to_path_buf());

        // First check if there are already events
        let events = self.get_events_since(&image_path, since_seq).await;
        if !events.is_empty() {
            return (events, "events".to_string());
        }

        // Subscribe to notifications
        let mut receiver = self.sender.subscribe();

        // Wait for notification or timeout
        let result = tokio::time::timeout(timeout, async {
            loop {
                match receiver.recv().await {
                    Ok(changed_path) => {
                        if changed_path == image_path {
                            // Check for events
                            let events = self.get_events_since(&image_path, since_seq).await;
                            if !events.is_empty() {
                                return events;
                            }
                        }
                    }
                    Err(_) => {
                        // Channel closed, return empty
                        return Vec::new();
                    }
                }
            }
        })
        .await;

        match result {
            Ok(events) if !events.is_empty() => (events, "events".to_string()),
            _ => (Vec::new(), "timeout".to_string()),
        }
    }

    /// Initialize the store with current annotations (call before watching)
    pub async fn init_store(&self, image_path: &Path) {
        // Canonicalize path to handle symlinks (e.g., /tmp -> /private/tmp on macOS)
        let image_path = image_path.canonicalize().unwrap_or_else(|_| image_path.to_path_buf());
        let annotations_path = annotations_file_path(&image_path);
        let current = load_annotations(&annotations_path);

        let mut stores = self.stores.lock();
        let store = stores.entry(image_path).or_default();
        store.last_known = current
            .into_iter()
            .map(|a| (a.id.clone(), a))
            .collect();
    }
}

/// Convert annotations file path back to image path
fn annotations_path_to_image(annotations_path: &Path) -> Option<PathBuf> {
    let filename = annotations_path.file_name()?.to_string_lossy();
    // Format is: {image_filename}.annotations.json (e.g., test.png.annotations.json)
    let image_filename = filename.strip_suffix(".annotations.json")?;
    let parent = annotations_path.parent()?;

    let image_path = parent.join(image_filename);
    if image_path.exists() {
        return Some(image_path);
    }

    // Fall back: image_filename might be just the stem, try common extensions
    for ext in ["png", "jpg", "jpeg", "webp"] {
        let image_path = parent.join(format!("{}.{}", image_filename, ext));
        if image_path.exists() {
            return Some(image_path);
        }
    }

    // Return the path anyway (might be useful for the key)
    Some(parent.join(image_filename))
}

/// Load annotations from file
fn load_annotations(path: &Path) -> Vec<SerializedAnnotation> {
    if !path.exists() {
        return Vec::new();
    }

    std::fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<AnnotationsFile>(&content).ok())
        .map(|f| f.annotations)
        .unwrap_or_default()
}

/// Process an annotation file change (synchronous version for notify callback)
fn process_annotation_change_sync(
    stores: &Arc<SyncMutex<HashMap<PathBuf, ImageEventStore>>>,
    annotations_path: &Path,
    image_path: &Path,
    sender: &broadcast::Sender<PathBuf>,
) {
    let current = load_annotations(annotations_path);
    let current_map: HashMap<String, SerializedAnnotation> =
        current.into_iter().map(|a| (a.id.clone(), a)).collect();

    let mut stores = stores.lock();
    let store = stores.entry(image_path.to_path_buf()).or_default();

    let mut new_events = Vec::new();

    // Find created and modified annotations
    for (id, annotation) in &current_map {
        if let Some(old) = store.last_known.get(id) {
            // Check if modified
            if annotation != old {
                new_events.push(AnnotationEvent {
                    event_type: "annotation.modified".to_string(),
                    seq: next_seq(),
                    annotation: Some(serialized_to_event(annotation)),
                    annotation_id: None,
                });
            }
        } else {
            // New annotation
            new_events.push(AnnotationEvent {
                event_type: "annotation.created".to_string(),
                seq: next_seq(),
                annotation: Some(serialized_to_event(annotation)),
                annotation_id: None,
            });
        }
    }

    // Find deleted annotations
    for id in store.last_known.keys() {
        if !current_map.contains_key(id) {
            new_events.push(AnnotationEvent {
                event_type: "annotation.deleted".to_string(),
                seq: next_seq(),
                annotation: None,
                annotation_id: Some(id.clone()),
            });
        }
    }

    // Update state
    store.last_known = current_map;
    store.events.extend(new_events);

    // Notify waiters
    let _ = sender.send(image_path.to_path_buf());
}

/// Convert SerializedAnnotation to EventAnnotation
fn serialized_to_event(ann: &SerializedAnnotation) -> EventAnnotation {
    let (position, size, end_position, text, number) = match &ann.geometry {
        AnnotationGeometry::Rectangle { x, y, width, height } => {
            ([*x, *y], Some([*width, *height]), None, None, None)
        }
        AnnotationGeometry::Line {
            start_x,
            start_y,
            end_x,
            end_y,
        } => (
            [*start_x, *start_y],
            None,
            Some([*end_x, *end_y]),
            None,
            None,
        ),
        AnnotationGeometry::Ellipse {
            center_x,
            center_y,
            radius_x,
            radius_y,
        } => (
            [*center_x - *radius_x, *center_y - *radius_y],
            Some([*radius_x * 2.0, *radius_y * 2.0]),
            None,
            None,
            None,
        ),
        AnnotationGeometry::Point { x, y, value, content } => {
            ([*x, *y], None, None, content.clone(), *value)
        }
        AnnotationGeometry::Path { points } => {
            let first = points.first().map(|p| [p.0, p.1]).unwrap_or([0.0, 0.0]);
            (first, None, None, None, None)
        }
    };

    EventAnnotation {
        id: ann.id.clone(),
        annotation_type: ann.annotation_type.clone(),
        position,
        size,
        end_position,
        text,
        number,
        color: ann.color.clone(),
    }
}
