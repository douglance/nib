//! Pure z-order swap logic for ⌘] (bring forward) / ⌘[ (send backward).
//!
//! Keyboard-only v1 (no toolbar button, to protect the toolbar width budget):
//! operates on the single selected annotation, swapping its `z_index` with
//! its immediate neighbor in z-order rather than renumbering the whole list.

use gpui::Context;
use nib_core::{Annotation, AnnotationId};

use crate::app::EditorView;
use crate::history::Edit;

/// Which way to move an annotation in z-order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// ⌘] -- move toward the front (higher z_index, rendered/hit-tested last)
    Forward,
    /// ⌘[ -- move toward the back (lower z_index)
    Backward,
}

/// Compute the z_index swap needed to move `id` one step in `direction`
/// among its z-order-sorted neighbors. Returns `None` if `id` doesn't exist,
/// or is already at that edge (already frontmost/backmost) -- a no-op.
pub fn reorder(
    annotations: &[Annotation],
    id: AnnotationId,
    direction: Direction,
) -> Option<[(AnnotationId, i32); 2]> {
    let mut sorted: Vec<&Annotation> = annotations.iter().collect();
    sorted.sort_by_key(|a| a.z_index);

    let pos = sorted.iter().position(|a| a.id == id)?;
    let neighbor_pos = match direction {
        Direction::Forward => {
            let next = pos + 1;
            if next < sorted.len() {
                next
            } else {
                return None;
            }
        }
        Direction::Backward => pos.checked_sub(1)?,
    };

    let a = sorted[pos];
    let b = sorted[neighbor_pos];
    Some([(a.id, b.z_index), (b.id, a.z_index)])
}

impl EditorView {
    /// Move the selected annotation one step forward/backward in z-order
    /// (⌘]/⌘[), recorded as a `Batch` of two `Replaced` edits. Operates on
    /// the first selected id; no-op if nothing is selected, or the
    /// annotation is already at that edge.
    pub(crate) fn reorder_selected(&mut self, direction: Direction, cx: &mut Context<Self>) {
        let Some(id) = self.selected_annotation_ids().into_iter().next() else {
            return;
        };
        let Some([(id_a, z_a), (id_b, z_b)]) = reorder(&self.annotations, id, direction) else {
            return;
        };

        let before_a = self.annotations.iter().find(|a| a.id == id_a).cloned();
        let before_b = self.annotations.iter().find(|a| a.id == id_b).cloned();
        let (Some(before_a), Some(before_b)) = (before_a, before_b) else {
            return;
        };

        if let Some(a) = self.annotations.iter_mut().find(|a| a.id == id_a) {
            a.z_index = z_a;
            a.touch();
        }
        if let Some(b) = self.annotations.iter_mut().find(|a| a.id == id_b) {
            b.z_index = z_b;
            b.touch();
        }

        let after_a = self.annotations.iter().find(|a| a.id == id_a).cloned().unwrap();
        let after_b = self.annotations.iter().find(|a| a.id == id_b).cloned().unwrap();

        self.record_edit(Edit::Batch(vec![
            Edit::Replaced { before: before_a, after: after_a },
            Edit::Replaced { before: before_b, after: after_b },
        ]));
        self.save_annotations(cx);
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nib_core::{AnnotationType, Color, Region};

    fn box_with_z(z: i32) -> Annotation {
        let mut ann = Annotation::new(AnnotationType::Box {
            region: Region::new(0.0, 0.0, 10.0, 10.0),
            stroke_width: 2.0,
            stroke_style: nib_core::StrokeStyle::Solid,
            filled: false,
            corner_radius: 0.0,
        })
        .with_color(Color::RED);
        ann.z_index = z;
        ann
    }

    #[test]
    fn forward_swaps_with_next_higher_neighbor() {
        let a = box_with_z(0);
        let b = box_with_z(1);
        let c = box_with_z(2);
        let annotations = vec![a.clone(), b.clone(), c.clone()];

        let swap = reorder(&annotations, a.id, Direction::Forward).unwrap();
        assert_eq!(swap, [(a.id, 1), (b.id, 0)]);
    }

    #[test]
    fn backward_swaps_with_next_lower_neighbor() {
        let a = box_with_z(0);
        let b = box_with_z(1);
        let annotations = vec![a.clone(), b.clone()];

        let swap = reorder(&annotations, b.id, Direction::Backward).unwrap();
        assert_eq!(swap, [(b.id, 0), (a.id, 1)]);
    }

    #[test]
    fn no_op_when_already_frontmost() {
        let a = box_with_z(0);
        let b = box_with_z(1);
        let annotations = vec![a.clone(), b.clone()];

        assert_eq!(reorder(&annotations, b.id, Direction::Forward), None);
    }

    #[test]
    fn no_op_when_already_backmost() {
        let a = box_with_z(0);
        let b = box_with_z(1);
        let annotations = vec![a.clone(), b.clone()];

        assert_eq!(reorder(&annotations, a.id, Direction::Backward), None);
    }

    #[test]
    fn missing_id_returns_none() {
        let a = box_with_z(0);
        let annotations = vec![a];
        let missing = nib_core::AnnotationId::new();

        assert_eq!(reorder(&annotations, missing, Direction::Forward), None);
    }

    #[test]
    fn forward_then_backward_round_trips_to_original_z_index() {
        let a = box_with_z(0);
        let b = box_with_z(1);
        let mut annotations = vec![a.clone(), b.clone()];

        let swap = reorder(&annotations, a.id, Direction::Forward).unwrap();
        for (id, z) in swap {
            annotations.iter_mut().find(|x| x.id == id).unwrap().z_index = z;
        }
        assert_eq!(annotations.iter().find(|x| x.id == a.id).unwrap().z_index, 1);
        assert_eq!(annotations.iter().find(|x| x.id == b.id).unwrap().z_index, 0);

        let swap_back = reorder(&annotations, a.id, Direction::Backward).unwrap();
        for (id, z) in swap_back {
            annotations.iter_mut().find(|x| x.id == id).unwrap().z_index = z;
        }
        assert_eq!(annotations.iter().find(|x| x.id == a.id).unwrap().z_index, 0);
        assert_eq!(annotations.iter().find(|x| x.id == b.id).unwrap().z_index, 1);
    }
}
