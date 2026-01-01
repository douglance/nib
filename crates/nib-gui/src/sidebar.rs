//! Layers/annotations sidebar

use nib_core::{Annotation, AnnotationId};

/// Sidebar state for annotation list
pub struct Sidebar {
    /// Selected annotation IDs
    pub selection: Vec<AnnotationId>,
    /// Whether sidebar is visible
    pub visible: bool,
    /// Width of sidebar in pixels
    pub width: f64,
}

impl Sidebar {
    pub fn new() -> Self {
        Self {
            selection: Vec::new(),
            visible: true,
            width: 250.0,
        }
    }

    pub fn select(&mut self, id: AnnotationId) {
        self.selection.clear();
        self.selection.push(id);
    }

    pub fn add_to_selection(&mut self, id: AnnotationId) {
        if !self.selection.contains(&id) {
            self.selection.push(id);
        }
    }

    pub fn clear_selection(&mut self) {
        self.selection.clear();
    }

    pub fn is_selected(&self, id: AnnotationId) -> bool {
        self.selection.contains(&id)
    }

    pub fn toggle(&mut self) {
        self.visible = !self.visible;
    }
}

impl Default for Sidebar {
    fn default() -> Self {
        Self::new()
    }
}

/// Annotation list item for display
pub struct AnnotationListItem<'a> {
    pub annotation: &'a Annotation,
    pub selected: bool,
    pub index: usize,
}
