//! ⌘G (group) / ⇧⌘G (ungroup) -- flat (non-nested) grouping via
//! `Annotation::group_id`.
//!
//! Grouping only mints/clears the shared id here; click-to-select-whole-group
//! happens in `SelectTool` itself (it expands a click target to its group at
//! selection time), so every other operation -- move, duplicate, delete,
//! align, undo -- works unmodified against whatever's already selected.

use gpui::Context;
use nib_core::{Annotation, AnnotationId};

use crate::app::EditorView;
use crate::history::Edit;

/// Set `group_id` on every annotation in `ids` that doesn't already have it,
/// mutating `annotations` in place and returning one `Replaced` edit per
/// annotation actually changed. Empty if every matching id already had the
/// target `group_id` (e.g. ungrouping an already-ungrouped selection).
pub fn set_group_id(
    annotations: &mut [Annotation],
    ids: &[AnnotationId],
    group_id: Option<u64>,
) -> Vec<Edit> {
    let mut edits = Vec::new();
    for annotation in annotations.iter_mut() {
        if !ids.contains(&annotation.id) || annotation.group_id == group_id {
            continue;
        }
        let before = annotation.clone();
        annotation.group_id = group_id;
        annotation.touch();
        edits.push(Edit::Replaced {
            before,
            after: annotation.clone(),
        });
    }
    edits
}

impl EditorView {
    /// Assign a fresh shared `group_id` to every selected annotation (⌘G).
    /// No-op below 2 selected -- nothing to group.
    pub(crate) fn group_selected(&mut self, cx: &mut Context<Self>) {
        let ids = self.selected_annotation_ids();
        if ids.len() < 2 {
            return;
        }
        let group_id = Some(AnnotationId::new().0);
        let edits = set_group_id(&mut self.annotations, &ids, group_id);
        if edits.is_empty() {
            return;
        }
        self.record_edit(Edit::Batch(edits));
        self.save_annotations(cx);
        cx.notify();
    }

    /// Clear group membership for every selected annotation (⇧⌘G).
    pub(crate) fn ungroup_selected(&mut self, cx: &mut Context<Self>) {
        let ids = self.selected_annotation_ids();
        let edits = set_group_id(&mut self.annotations, &ids, None);
        if edits.is_empty() {
            return;
        }
        self.record_edit(Edit::Batch(edits));
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
    fn set_group_id_assigns_shared_id_to_every_matching_annotation() {
        let a = box_at(0.0, 0.0);
        let b = box_at(10.0, 10.0);
        let c = box_at(20.0, 20.0); // not in `ids`, must be left untouched
        let mut annotations = vec![a.clone(), b.clone(), c.clone()];

        let edits = set_group_id(&mut annotations, &[a.id, b.id], Some(99));

        assert_eq!(edits.len(), 2);
        assert_eq!(annotations[0].group_id, Some(99));
        assert_eq!(annotations[1].group_id, Some(99));
        assert_eq!(
            annotations[2].group_id, None,
            "annotation not in `ids` must be untouched"
        );
    }

    #[test]
    fn set_group_id_is_a_no_op_when_already_at_target() {
        let mut a = box_at(0.0, 0.0);
        a.group_id = Some(5);
        let mut annotations = vec![a.clone()];

        let edits = set_group_id(&mut annotations, &[a.id], Some(5));
        assert!(
            edits.is_empty(),
            "already-grouped-to-5 must produce no edit"
        );
    }

    #[test]
    fn set_group_id_none_clears_membership() {
        let mut a = box_at(0.0, 0.0);
        a.group_id = Some(5);
        let mut annotations = vec![a.clone()];

        let edits = set_group_id(&mut annotations, &[a.id], None);
        assert_eq!(edits.len(), 1);
        assert_eq!(annotations[0].group_id, None);
    }

    #[test]
    fn set_group_id_edit_carries_correct_before_and_after() {
        let a = box_at(0.0, 0.0);
        let mut annotations = vec![a.clone()];

        let edits = set_group_id(&mut annotations, &[a.id], Some(7));
        match &edits[0] {
            Edit::Replaced { before, after } => {
                assert_eq!(before.group_id, None);
                assert_eq!(after.group_id, Some(7));
            }
            other => panic!("expected Replaced, got {other:?}"),
        }
    }
}
