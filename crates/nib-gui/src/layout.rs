//! Pure snapping and alignment geometry for the Select tool and style panel.
//!
//! Deliberately free of GPUI/tool-trait dependencies (only `nib_core::Region`)
//! so it's testable as plain arithmetic, mirroring the `zorder`/`history`
//! module pattern.

use gpui::Context;
use nib_core::Region;

use crate::app::EditorView;
use crate::history::Edit;

/// Screen-space snap distance in pixels. Callers convert to an image-space
/// threshold via the canvas scale: `threshold = SNAP_PX / scale`.
pub const SNAP_PX: f64 = 8.0;

/// A snap guide line to render as visual feedback, in image-space coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Guide {
    Vertical(f64),
    Horizontal(f64),
}

/// Result of a snap attempt: the (possibly adjusted) delta plus any guide
/// lines that should be drawn to explain the snap.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SnapResult {
    pub dx: f64,
    pub dy: f64,
    pub guides: Vec<Guide>,
}

/// Snap a proposed move delta so the moving region's edges/center align with
/// another region's edges/center (from `others` or the canvas bounds) when
/// within `threshold` image-space pixels of each other.
///
/// Only the single nearest candidate-target pair is honored per axis, so this
/// returns at most one vertical and one horizontal guide. If nothing is
/// within `threshold` on an axis, that axis's delta passes through unchanged.
pub fn snap_delta(
    moving: Region,
    others: &[Region],
    canvas: (f64, f64),
    dx: f64,
    dy: f64,
    threshold: f64,
) -> SnapResult {
    let proposed_x = moving.x + dx;
    let proposed_y = moving.y + dy;

    let x_candidates = [
        proposed_x,
        proposed_x + moving.width / 2.0,
        proposed_x + moving.width,
    ];
    let y_candidates = [
        proposed_y,
        proposed_y + moving.height / 2.0,
        proposed_y + moving.height,
    ];

    let mut x_targets = Vec::with_capacity(others.len() * 3 + 3);
    let mut y_targets = Vec::with_capacity(others.len() * 3 + 3);
    for r in others {
        x_targets.extend([r.x, r.x + r.width / 2.0, r.x + r.width]);
        y_targets.extend([r.y, r.y + r.height / 2.0, r.y + r.height]);
    }
    x_targets.extend([0.0, canvas.0 / 2.0, canvas.0]);
    y_targets.extend([0.0, canvas.1 / 2.0, canvas.1]);

    let mut guides = Vec::new();
    let snap_dx = match nearest_snap(&x_candidates, &x_targets, threshold) {
        Some((adjustment, guide)) => {
            guides.push(Guide::Vertical(guide));
            adjustment
        }
        None => 0.0,
    };
    let snap_dy = match nearest_snap(&y_candidates, &y_targets, threshold) {
        Some((adjustment, guide)) => {
            guides.push(Guide::Horizontal(guide));
            adjustment
        }
        None => 0.0,
    };

    SnapResult {
        dx: dx + snap_dx,
        dy: dy + snap_dy,
        guides,
    }
}

/// Find the smallest-distance (candidate, target) pair within `threshold`.
/// Returns `(target - candidate, target)`: the adjustment to add to the
/// proposed delta, and the guide-line position (always equal to `target`).
fn nearest_snap(candidates: &[f64], targets: &[f64], threshold: f64) -> Option<(f64, f64)> {
    let mut best: Option<(f64, f64, f64)> = None; // (abs_distance, adjustment, guide)
    for &c in candidates {
        for &t in targets {
            let d = t - c;
            let ad = d.abs();
            if ad <= threshold && best.is_none_or(|(bd, _, _)| ad < bd) {
                best = Some((ad, d, t));
            }
        }
    }
    best.map(|(_, adjustment, guide)| (adjustment, guide))
}

/// Bounding box of a set of regions, or `None` if empty.
pub fn union(bounds: &[Region]) -> Option<Region> {
    if bounds.is_empty() {
        return None;
    }
    let min_x = bounds.iter().map(|b| b.x).fold(f64::INFINITY, f64::min);
    let max_x = bounds
        .iter()
        .map(|b| b.x + b.width)
        .fold(f64::NEG_INFINITY, f64::max);
    let min_y = bounds.iter().map(|b| b.y).fold(f64::INFINITY, f64::min);
    let max_y = bounds
        .iter()
        .map(|b| b.y + b.height)
        .fold(f64::NEG_INFINITY, f64::max);
    Some(Region::new(min_x, min_y, max_x - min_x, max_y - min_y))
}

/// Alignment mode for multi-selection alignment (style panel "Align" row).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlignMode {
    Left,
    CenterHorizontal,
    Right,
    Top,
    CenterVertical,
    Bottom,
}

/// Compute aligned bounds for a set of regions, derived from their combined
/// bounding box. Widths and heights are preserved -- only x/y move.
/// Idempotent: re-aligning the result with the same mode is a no-op, since
/// every region already shares the target edge/center the second time.
pub fn align(bounds: &[Region], mode: AlignMode) -> Vec<Region> {
    let Some(bbox) = union(bounds) else {
        return Vec::new();
    };
    let min_x = bbox.x;
    let max_x = bbox.x + bbox.width;
    let min_y = bbox.y;
    let max_y = bbox.y + bbox.height;
    let center_x = (min_x + max_x) / 2.0;
    let center_y = (min_y + max_y) / 2.0;

    bounds
        .iter()
        .map(|b| match mode {
            AlignMode::Left => Region::new(min_x, b.y, b.width, b.height),
            AlignMode::Right => Region::new(max_x - b.width, b.y, b.width, b.height),
            AlignMode::Top => Region::new(b.x, min_y, b.width, b.height),
            AlignMode::Bottom => Region::new(b.x, max_y - b.height, b.width, b.height),
            AlignMode::CenterHorizontal => {
                Region::new(center_x - b.width / 2.0, b.y, b.width, b.height)
            }
            AlignMode::CenterVertical => {
                Region::new(b.x, center_y - b.height / 2.0, b.width, b.height)
            }
        })
        .collect()
}

impl EditorView {
    /// Align every selected annotation's bounds per `mode` (style panel Align
    /// row, shown only when ≥2 annotations are selected). Repositions via
    /// `move_annotation_type` -- the same delta-based move every other
    /// variant (including point-based Text/Number) already uses -- so this
    /// needs no per-`AnnotationType` alignment logic of its own. Recorded as
    /// one `Batch` undo edit.
    pub(crate) fn align_selected(&mut self, mode: AlignMode, cx: &mut Context<Self>) {
        let ids = self.selected_annotation_ids();
        if ids.len() < 2 {
            return;
        }

        let bounds: Vec<Region> = ids
            .iter()
            .filter_map(|id| {
                self.annotations
                    .iter()
                    .find(|a| a.id == *id)
                    .map(|a| a.bounds())
            })
            .collect();
        if bounds.len() != ids.len() {
            return;
        }

        let aligned = align(&bounds, mode);
        let mut edits = Vec::new();
        for ((id, original), target) in ids.iter().zip(bounds.iter()).zip(aligned.iter()) {
            let dx = target.x - original.x;
            let dy = target.y - original.y;
            if dx.abs() < f64::EPSILON && dy.abs() < f64::EPSILON {
                continue;
            }
            if let Some(annotation) = self.annotations.iter_mut().find(|a| a.id == *id) {
                let before = annotation.clone();
                Self::move_annotation_type(&mut annotation.annotation_type, dx, dy);
                annotation.touch();
                edits.push(Edit::Replaced {
                    before,
                    after: annotation.clone(),
                });
            }
        }

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

    fn r(x: f64, y: f64, w: f64, h: f64) -> Region {
        Region::new(x, y, w, h)
    }

    // --- snap_delta ---

    #[test]
    fn snap_within_threshold_aligns_exactly_and_emits_guide() {
        let moving = r(10.0, 10.0, 20.0, 20.0); // right edge at 30
        let other = r(33.0, 100.0, 10.0, 10.0); // left edge at 33 -- 3px from 30
        let result = snap_delta(moving, &[other], (1000.0, 1000.0), 0.0, 0.0, 8.0);
        // moving's right edge (30) should land exactly on other's left edge (33)
        assert_eq!(result.dx, 3.0);
        assert_eq!(result.dy, 0.0);
        assert!(result.guides.contains(&Guide::Vertical(33.0)));
    }

    #[test]
    fn snap_outside_threshold_leaves_delta_unchanged_and_emits_no_guide() {
        let moving = r(10.0, 10.0, 20.0, 20.0);
        let other = r(200.0, 200.0, 10.0, 10.0);
        let result = snap_delta(moving, &[other], (1000.0, 1000.0), 5.0, 7.0, 8.0);
        assert_eq!(result.dx, 5.0);
        assert_eq!(result.dy, 7.0);
        assert!(result.guides.is_empty());
    }

    #[test]
    fn snap_picks_nearest_candidate_when_multiple_within_threshold() {
        let moving = r(100.0, 100.0, 10.0, 10.0); // x candidates: 100, 105, 110
                                                  // Two targets within threshold of the right edge (110): 112 (dist 2) and 114 (dist 4).
        let other_a = r(112.0, 150.0, 1.0, 1.0);
        let other_b = r(114.0, 160.0, 1.0, 1.0);
        let result = snap_delta(moving, &[other_a, other_b], (1000.0, 1000.0), 0.0, 0.0, 8.0);
        assert_eq!(
            result.dx, 2.0,
            "must snap to the closer target (112), not the farther (114)"
        );
    }

    #[test]
    fn snap_bypass_with_no_candidates_within_threshold_on_either_axis() {
        let moving = r(200.0, 200.0, 10.0, 10.0);
        let result = snap_delta(moving, &[], (1000.0, 1000.0), 3.0, -4.0, 8.0);
        assert_eq!(result.dx, 3.0);
        assert_eq!(result.dy, -4.0);
        assert!(result.guides.is_empty());
    }

    #[test]
    fn snap_against_canvas_center() {
        // Canvas is 100x100, its horizontal center line is x=50.
        // Moving a 10-wide region so its center (proposed_x + 5) lands near 50.
        let moving = r(0.0, 0.0, 10.0, 10.0);
        let result = snap_delta(moving, &[], (100.0, 100.0), 44.0, 0.0, 8.0);
        // proposed center = 0 + 44 + 5 = 49, within 8px of canvas center 50
        assert_eq!(
            result.dx, 45.0,
            "center should land exactly on canvas center (50)"
        );
        assert!(result.guides.contains(&Guide::Vertical(50.0)));
    }

    #[test]
    fn snap_result_never_exceeds_threshold_adjustment() {
        // Property: whatever gets snapped, the adjustment magnitude itself
        // must never exceed `threshold` (otherwise it isn't "nearby" anymore).
        let moving = r(0.0, 0.0, 10.0, 10.0);
        let cases = [
            (r(7.0, 50.0, 1.0, 1.0), 8.0),
            (r(-3.0, 50.0, 1.0, 1.0), 8.0),
            (r(1000.0, 50.0, 1.0, 1.0), 8.0),
        ];
        for (other, threshold) in cases {
            let result = snap_delta(moving, &[other], (1000.0, 1000.0), 0.0, 0.0, threshold);
            assert!(
                result.dx.abs() <= threshold,
                "adjustment {} exceeded threshold {}",
                result.dx,
                threshold
            );
        }
    }

    #[test]
    fn union_of_empty_is_none() {
        assert_eq!(union(&[]), None);
    }

    #[test]
    fn union_combines_bounding_box() {
        let combined = union(&[r(0.0, 0.0, 10.0, 10.0), r(20.0, -5.0, 5.0, 5.0)]).unwrap();
        assert_eq!(combined, r(0.0, -5.0, 25.0, 15.0));
    }

    // --- align ---

    #[test]
    fn align_empty_is_empty() {
        assert_eq!(align(&[], AlignMode::Left), Vec::<Region>::new());
    }

    #[test]
    fn align_left_sets_common_min_x() {
        let bounds = [
            r(10.0, 0.0, 5.0, 5.0),
            r(30.0, 20.0, 8.0, 8.0),
            r(2.0, 40.0, 3.0, 3.0),
        ];
        let aligned = align(&bounds, AlignMode::Left);
        for b in &aligned {
            assert_eq!(b.x, 2.0);
        }
        // y/width/height untouched
        assert_eq!(aligned[0].y, 0.0);
        assert_eq!(aligned[0].width, 5.0);
    }

    #[test]
    fn align_right_sets_common_max_x_edge() {
        let bounds = [r(10.0, 0.0, 5.0, 5.0), r(30.0, 20.0, 8.0, 8.0)];
        let aligned = align(&bounds, AlignMode::Right);
        for b in &aligned {
            assert_eq!(b.x + b.width, 38.0); // max(15, 38) = 38
        }
    }

    #[test]
    fn align_top_and_bottom() {
        let bounds = [r(0.0, 10.0, 5.0, 5.0), r(0.0, 30.0, 8.0, 8.0)];
        let top = align(&bounds, AlignMode::Top);
        for b in &top {
            assert_eq!(b.y, 10.0);
        }
        let bottom = align(&bounds, AlignMode::Bottom);
        for b in &bottom {
            assert_eq!(b.y + b.height, 38.0);
        }
    }

    #[test]
    fn align_center_horizontal_and_vertical() {
        let bounds = [r(0.0, 0.0, 10.0, 10.0), r(40.0, 40.0, 20.0, 20.0)];
        // bbox: x in [0, 60], y in [0, 60] -> center (30, 30)
        let ch = align(&bounds, AlignMode::CenterHorizontal);
        for b in &ch {
            assert_eq!(b.x + b.width / 2.0, 30.0);
        }
        let cv = align(&bounds, AlignMode::CenterVertical);
        for b in &cv {
            assert_eq!(b.y + b.height / 2.0, 30.0);
        }
    }

    #[test]
    fn align_is_idempotent_for_all_modes() {
        let bounds = vec![
            r(3.0, 100.0, 7.0, 22.0),
            r(-40.0, 5.0, 15.0, 9.0),
            r(60.0, 60.0, 4.0, 4.0),
        ];
        for mode in [
            AlignMode::Left,
            AlignMode::CenterHorizontal,
            AlignMode::Right,
            AlignMode::Top,
            AlignMode::CenterVertical,
            AlignMode::Bottom,
        ] {
            let once = align(&bounds, mode);
            let twice = align(&once, mode);
            assert_eq!(once, twice, "align({:?}) must be idempotent", mode);
        }
    }

    #[test]
    fn align_preserves_widths_and_heights() {
        let bounds = [r(1.0, 2.0, 30.0, 40.0), r(5.0, 6.0, 7.0, 8.0)];
        for mode in [
            AlignMode::Left,
            AlignMode::CenterHorizontal,
            AlignMode::Right,
            AlignMode::Top,
            AlignMode::CenterVertical,
            AlignMode::Bottom,
        ] {
            let aligned = align(&bounds, mode);
            for (original, result) in bounds.iter().zip(aligned.iter()) {
                assert_eq!(result.width, original.width);
                assert_eq!(result.height, original.height);
            }
        }
    }
}
