//! GUI-side undo/redo: a command stack of snapshot `Edit`s.
//!
//! Deliberately NOT built on `AnnotationOp` inversion: ops aren't invertible
//! (`Remove{id}` carries no payload to restore, `Update` is stringly-typed),
//! and GUI mutations don't route through ops anyway -- `process_tool_result`
//! mutates `self.annotations` directly. Each `Edit` instead carries a full
//! snapshot of what it touched, so it can apply itself forward (redo) or
//! backward (undo) against the annotations `Vec` directly. Remote collab ops
//! are never recorded here, so undo/redo only ever touches local edits.

use gpui::Context;
use nib_core::{Annotation, AnnotationId};

use crate::app::EditorView;
use crate::tools::{SelectTool, ToolId};

/// A single undoable change to the annotation list. `Batch` groups several
/// edits (e.g. duplicating N annotations, or a style change applied to a
/// multi-selection) into one undo/redo step.
#[derive(Debug, Clone, PartialEq)]
pub enum Edit {
    /// An annotation was created; undo removes it, redo re-adds it.
    Added(Annotation),
    /// An annotation was deleted; undo re-adds it, redo removes it.
    Removed(Annotation),
    /// An annotation was mutated in place (move/resize/text/style edit);
    /// undo restores `before`, redo restores `after`.
    Replaced { before: Annotation, after: Annotation },
    /// Multiple edits applied/undone/redone together as one unit.
    Batch(Vec<Edit>),
}

impl Edit {
    /// Apply this edit backward. No-op for any id no longer present (e.g. it
    /// was removed by a remote collab op since the edit was recorded) --
    /// undo of a vanished annotation is a graceful no-op, not a panic.
    fn undo(&self, annotations: &mut Vec<Annotation>) {
        match self {
            Edit::Added(annotation) => {
                annotations.retain(|a| a.id != annotation.id);
            }
            Edit::Removed(annotation) => {
                if !annotations.iter().any(|a| a.id == annotation.id) {
                    annotations.push(annotation.clone());
                }
            }
            Edit::Replaced { before, .. } => {
                if let Some(annotation) = annotations.iter_mut().find(|a| a.id == before.id) {
                    *annotation = before.clone();
                }
            }
            Edit::Batch(edits) => {
                for edit in edits.iter().rev() {
                    edit.undo(annotations);
                }
            }
        }
    }

    /// Apply this edit forward. Mirrors `undo`'s no-op-on-missing-id behavior.
    fn redo(&self, annotations: &mut Vec<Annotation>) {
        match self {
            Edit::Added(annotation) => {
                if !annotations.iter().any(|a| a.id == annotation.id) {
                    annotations.push(annotation.clone());
                }
            }
            Edit::Removed(annotation) => {
                annotations.retain(|a| a.id != annotation.id);
            }
            Edit::Replaced { after, .. } => {
                if let Some(annotation) = annotations.iter_mut().find(|a| a.id == after.id) {
                    *annotation = after.clone();
                }
            }
            Edit::Batch(edits) => {
                for edit in edits {
                    edit.redo(annotations);
                }
            }
        }
    }

    /// Every annotation id this edit touches, for post-undo/redo selection sync.
    fn touched_ids(&self, out: &mut Vec<AnnotationId>) {
        match self {
            Edit::Added(annotation) | Edit::Removed(annotation) => out.push(annotation.id),
            Edit::Replaced { before, .. } => out.push(before.id),
            Edit::Batch(edits) => {
                for edit in edits {
                    edit.touched_ids(out);
                }
            }
        }
    }

    /// True for a `Batch` with no edits inside it (nothing to record).
    fn is_empty_batch(&self) -> bool {
        matches!(self, Edit::Batch(edits) if edits.is_empty())
    }
}

/// GUI-side undo/redo command stack.
#[derive(Debug)]
pub struct History {
    undo: Vec<Edit>,
    redo: Vec<Edit>,
    cap: usize,
}

impl History {
    pub fn new(cap: usize) -> Self {
        Self {
            undo: Vec::new(),
            redo: Vec::new(),
            cap,
        }
    }

    /// Record a new edit. A new edit after an undo invalidates whatever was
    /// undone, so this clears the redo stack.
    pub fn record(&mut self, edit: Edit) {
        if edit.is_empty_batch() {
            return;
        }
        self.undo.push(edit);
        if self.undo.len() > self.cap {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    /// Undo the most recent edit, applying it to `annotations`. Returns the
    /// ids it touched (for selection sync), or `None` if there's nothing to undo.
    pub fn undo(&mut self, annotations: &mut Vec<Annotation>) -> Option<Vec<AnnotationId>> {
        let edit = self.undo.pop()?;
        edit.undo(annotations);
        let mut ids = Vec::new();
        edit.touched_ids(&mut ids);
        self.redo.push(edit);
        Some(ids)
    }

    /// Redo the most recently undone edit, applying it to `annotations`.
    pub fn redo(&mut self, annotations: &mut Vec<Annotation>) -> Option<Vec<AnnotationId>> {
        let edit = self.redo.pop()?;
        edit.redo(annotations);
        let mut ids = Vec::new();
        edit.touched_ids(&mut ids);
        self.undo.push(edit);
        Some(ids)
    }

    #[cfg(test)]
    pub(crate) fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    #[cfg(test)]
    pub(crate) fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }
}

impl EditorView {
    /// Record a new edit onto the undo stack (see `History::record`).
    pub(crate) fn record_edit(&mut self, edit: Edit) {
        self.history.record(edit);
    }

    /// Undo the most recent edit (⌘Z): applies it, syncs the Select tool's
    /// selection to whatever it touched (dropping ids that no longer exist),
    /// saves, and repaints.
    pub(crate) fn undo(&mut self, cx: &mut Context<Self>) {
        if let Some(ids) = self.history.undo(&mut self.annotations) {
            self.sync_selection_to(&ids);
            self.save_annotations(cx);
            cx.notify();
        }
    }

    /// Redo the most recently undone edit (⇧⌘Z). Mirrors `undo`.
    pub(crate) fn redo(&mut self, cx: &mut Context<Self>) {
        if let Some(ids) = self.history.redo(&mut self.annotations) {
            self.sync_selection_to(&ids);
            self.save_annotations(cx);
            cx.notify();
        }
    }

    /// Point the Select tool's selection at `ids`, dropping any that no
    /// longer exist in `self.annotations`.
    pub(crate) fn sync_selection_to(&mut self, ids: &[AnnotationId]) {
        let existing: Vec<AnnotationId> = ids
            .iter()
            .copied()
            .filter(|id| self.annotations.iter().any(|a| a.id == *id))
            .collect();
        if let Some(select_tool) = self.tool_manager.get_tool_as_mut::<SelectTool>(ToolId::Select) {
            select_tool.set_selection(existing);
        }
    }

    /// Duplicate the current selection (⌘D): fresh ids, +8px offset, placed
    /// on top of the z-order, recorded as one `Batch(Added)` undo step, and
    /// the clones become the new selection.
    pub(crate) fn duplicate_selection(&mut self, cx: &mut Context<Self>) {
        let ids = self.selected_annotation_ids();
        if ids.is_empty() {
            return;
        }

        let mut next_z = self.annotations.iter().map(|a| a.z_index).max().unwrap_or(0);
        let mut clones = Vec::new();
        for annotation in self.annotations.iter().filter(|a| ids.contains(&a.id)) {
            let mut clone = annotation.clone();
            clone.id = AnnotationId::new();
            Self::move_annotation_type(&mut clone.annotation_type, 8.0, 8.0);
            next_z += 1;
            clone.z_index = next_z;
            clone.touch();
            clones.push(clone);
        }

        let clone_ids: Vec<AnnotationId> = clones.iter().map(|a| a.id).collect();
        let edits: Vec<Edit> = clones.iter().cloned().map(Edit::Added).collect();
        self.annotations.extend(clones);

        self.record_edit(Edit::Batch(edits));
        self.sync_selection_to(&clone_ids);
        self.save_annotations(cx);
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nib_core::{AnnotationType, Color, Region};

    fn box_at(x: f64, y: f64) -> Annotation {
        Annotation::new(AnnotationType::Box {
            region: Region::new(x, y, 10.0, 10.0),
            stroke_width: 2.0,
            stroke_style: nib_core::StrokeStyle::Solid,
            filled: false,
            corner_radius: 0.0,
        })
        .with_color(Color::RED)
    }

    #[test]
    fn added_apply_undo_restores_exact_pre_state() {
        let ann = box_at(0.0, 0.0);
        let edit = Edit::Added(ann.clone());
        let mut history = History::new(10);
        let mut annotations = vec![ann.clone()];

        history.record(edit);
        let pre_state = Vec::new();
        history.undo(&mut annotations);
        assert_eq!(annotations, pre_state);
    }

    #[test]
    fn removed_apply_undo_restores_exact_pre_state() {
        let ann = box_at(0.0, 0.0);
        let mut annotations: Vec<Annotation> = Vec::new();
        let edit = Edit::Removed(ann.clone());
        let mut history = History::new(10);

        history.record(edit);
        history.undo(&mut annotations);
        assert_eq!(annotations, vec![ann]);
    }

    #[test]
    fn replaced_apply_undo_restores_exact_pre_state() {
        let before = box_at(0.0, 0.0);
        let mut after = before.clone();
        after.color = Color::rgb(0, 255, 0);
        let mut annotations = vec![after.clone()];
        let edit = Edit::Replaced { before: before.clone(), after };
        let mut history = History::new(10);

        history.record(edit);
        history.undo(&mut annotations);
        assert_eq!(annotations, vec![before]);
    }

    #[test]
    fn batch_apply_undo_restores_exact_pre_state() {
        let a = box_at(0.0, 0.0);
        let b = box_at(10.0, 10.0);
        let edit = Edit::Batch(vec![Edit::Added(a.clone()), Edit::Added(b.clone())]);
        let mut history = History::new(10);
        let mut annotations = vec![a.clone(), b.clone()];

        history.record(edit);
        history.undo(&mut annotations);
        assert_eq!(annotations, Vec::new());
    }

    #[test]
    fn undo_then_redo_restores_final_state() {
        let ann = box_at(0.0, 0.0);
        let mut annotations = vec![ann.clone()];
        let mut history = History::new(10);
        history.record(Edit::Added(ann));

        let final_state = annotations.clone();
        history.undo(&mut annotations);
        history.redo(&mut annotations);
        assert_eq!(annotations, final_state);
    }

    #[test]
    fn property_n_random_edits_undo_then_redo_round_trips() {
        let mut annotations = Vec::new();
        let mut history = History::new(100);
        let initial = annotations.clone();

        // Deterministic pseudo-random sequence of Added/Removed/Replaced edits
        let seeds = [1u64, 7, 13, 42, 99, 5, 21, 8];
        for (i, seed) in seeds.iter().enumerate() {
            let ann = box_at(*seed as f64, i as f64);
            match seed % 3 {
                0 => {
                    annotations.push(ann.clone());
                    history.record(Edit::Added(ann));
                }
                1 if !annotations.is_empty() => {
                    let removed = annotations.remove(0);
                    history.record(Edit::Removed(removed));
                }
                _ => {
                    annotations.push(ann.clone());
                    history.record(Edit::Added(ann));
                }
            }
        }

        let final_state = annotations.clone();
        let n = seeds.len();

        for _ in 0..n {
            history.undo(&mut annotations);
        }
        assert_eq!(annotations, initial, "undo x N must restore the initial state");

        for _ in 0..n {
            history.redo(&mut annotations);
        }
        assert_eq!(annotations, final_state, "redo x N must restore the final state");
    }

    #[test]
    fn undo_of_stale_id_is_a_graceful_no_op() {
        let ann = box_at(0.0, 0.0);
        let mut history = History::new(10);
        history.record(Edit::Removed(ann.clone()));

        // The annotation was independently deleted by something else (e.g. a
        // remote collab op) before the undo runs -- nothing to remove, so
        // undoing "Removed" (which re-adds) still succeeds...
        let mut annotations = Vec::new();
        history.undo(&mut annotations);
        assert_eq!(annotations, vec![ann.clone()]);

        // ...but undoing an Added edit whose annotation is already gone
        // must not panic and must leave the list untouched.
        let mut history = History::new(10);
        history.record(Edit::Added(ann));
        let mut annotations: Vec<Annotation> = Vec::new();
        history.undo(&mut annotations);
        assert_eq!(annotations, Vec::new());
    }

    #[test]
    fn record_clears_redo_stack() {
        let a = box_at(0.0, 0.0);
        let b = box_at(1.0, 1.0);
        let mut history = History::new(10);
        let mut annotations = vec![a.clone()];

        history.record(Edit::Added(a));
        history.undo(&mut annotations);
        assert!(history.can_redo());

        history.record(Edit::Added(b));
        assert!(!history.can_redo(), "a new edit after undo must clear redo");
    }

    #[test]
    fn cap_evicts_oldest_undo_entry() {
        let mut history = History::new(2);
        let mut annotations = Vec::new();
        for i in 0..3 {
            let ann = box_at(i as f64, 0.0);
            annotations.push(ann.clone());
            history.record(Edit::Added(ann));
        }
        assert!(history.can_undo());
        // Only 2 entries remembered; the oldest (first Added) fell off, so
        // undoing twice can't remove the very first annotation via history.
        history.undo(&mut annotations);
        history.undo(&mut annotations);
        assert!(!history.can_undo());
        assert_eq!(annotations.len(), 1, "the evicted edit's annotation stays put");
    }
}
