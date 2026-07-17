//! Pure geometry helper for rendering dashed/dotted strokes.
//!
//! Shared by nib-gui (canvas/PathBuilder rendering) and nib-storage (flattened
//! PNG export) so both renderers draw dashed/dotted lines identically.

use crate::{Point, StrokeStyle};

/// Break a straight line from `start` to `end` into the segments that should be
/// stroked for `style`. `Solid` returns the whole line as one segment. `Dashed`
/// and `Dotted` return a series of shorter segments separated by gaps, sized
/// relative to `stroke_width` (thicker strokes get proportionally longer dashes).
///
/// Returns `vec![(start, end)]` for a degenerate (zero-length) line regardless
/// of `style`, since there's nothing to dash.
pub fn dash_segments(
    start: Point,
    end: Point,
    style: StrokeStyle,
    stroke_width: f64,
) -> Vec<(Point, Point)> {
    if style == StrokeStyle::Solid {
        return vec![(start, end)];
    }

    let dx = end.x - start.x;
    let dy = end.y - start.y;
    let len = (dx * dx + dy * dy).sqrt();
    if len < f64::EPSILON {
        return vec![(start, end)];
    }

    let width = stroke_width.max(1.0);
    let (dash_len, gap_len) = match style {
        StrokeStyle::Dotted => (width, width * 1.5),
        _ => (width * 3.0, width * 2.0),
    };

    let ux = dx / len;
    let uy = dy / len;
    let step = dash_len + gap_len;

    let mut segments = Vec::new();
    let mut pos = 0.0;
    while pos < len {
        let seg_end = (pos + dash_len).min(len);
        segments.push((
            Point::new(start.x + ux * pos, start.y + uy * pos),
            Point::new(start.x + ux * seg_end, start.y + uy * seg_end),
        ));
        pos += step;
    }
    segments
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solid_returns_single_full_segment() {
        let start = Point::new(0.0, 0.0);
        let end = Point::new(100.0, 0.0);
        let segments = dash_segments(start, end, StrokeStyle::Solid, 2.0);
        assert_eq!(segments, vec![(start, end)]);
    }

    #[test]
    fn dashed_returns_multiple_shorter_segments() {
        let start = Point::new(0.0, 0.0);
        let end = Point::new(100.0, 0.0);
        let segments = dash_segments(start, end, StrokeStyle::Dashed, 2.0);
        assert!(segments.len() > 1, "expected multiple dashes, got {segments:?}");
        for (s, e) in &segments {
            let seg_len = s.distance_to(*e);
            assert!(seg_len < 100.0, "dash segment should be shorter than the full line");
            assert!(seg_len > 0.0);
        }
    }

    #[test]
    fn dotted_produces_shorter_dashes_than_dashed() {
        let start = Point::new(0.0, 0.0);
        let end = Point::new(100.0, 0.0);
        let dashed = dash_segments(start, end, StrokeStyle::Dashed, 2.0);
        let dotted = dash_segments(start, end, StrokeStyle::Dotted, 2.0);
        let dashed_len = dashed[0].0.distance_to(dashed[0].1);
        let dotted_len = dotted[0].0.distance_to(dotted[0].1);
        assert!(dotted_len < dashed_len);
    }

    #[test]
    fn zero_length_line_returns_single_segment() {
        let point = Point::new(5.0, 5.0);
        let segments = dash_segments(point, point, StrokeStyle::Dashed, 2.0);
        assert_eq!(segments, vec![(point, point)]);
    }

    #[test]
    fn segments_stay_within_line_bounds() {
        let start = Point::new(10.0, 20.0);
        let end = Point::new(10.0, 120.0);
        let segments = dash_segments(start, end, StrokeStyle::Dotted, 4.0);
        for (s, e) in &segments {
            assert!(s.y >= start.y - f64::EPSILON && s.y <= end.y + f64::EPSILON);
            assert!(e.y >= start.y - f64::EPSILON && e.y <= end.y + f64::EPSILON);
        }
    }
}
