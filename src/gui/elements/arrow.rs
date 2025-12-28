//! Arrow annotation rendering

use crate::core::{ArrowHead, Color, Point};

/// Render parameters for an arrow
pub struct ArrowRender {
    pub start: Point,
    pub end: Point,
    pub color: Color,
    pub stroke_width: f64,
    pub head: ArrowHead,
    pub head_size: f64,
}

impl ArrowRender {
    pub fn new(start: Point, end: Point, color: Color, stroke_width: f64) -> Self {
        Self {
            start,
            end,
            color,
            stroke_width,
            head: ArrowHead::End,
            head_size: 12.0,
        }
    }

    /// Calculate angle from start to end
    pub fn angle(&self) -> f64 {
        let dx = self.end.x - self.start.x;
        let dy = self.end.y - self.start.y;
        dy.atan2(dx)
    }

    /// Calculate length of arrow line
    pub fn length(&self) -> f64 {
        self.start.distance_to(self.end)
    }

    /// Get arrow head points for end
    pub fn end_head_points(&self) -> [Point; 3] {
        let angle = self.angle();
        let head_angle = std::f64::consts::PI / 6.0; // 30 degrees

        let tip = self.end;
        let left = Point::new(
            tip.x - self.head_size * (angle + head_angle).cos(),
            tip.y - self.head_size * (angle + head_angle).sin(),
        );
        let right = Point::new(
            tip.x - self.head_size * (angle - head_angle).cos(),
            tip.y - self.head_size * (angle - head_angle).sin(),
        );

        [tip, left, right]
    }
}
