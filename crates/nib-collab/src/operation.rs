//! Operation conversion and conflict resolution

use nib_core::{
    Annotation, AnnotationId, AnnotationType, ArrowHead, BlurIntensity, Color, Point, Region,
    Severity, StrokeStyle, TextAlign,
};

use super::types::*;

/// Convert a core Annotation to serializable AnnotationData
pub fn annotation_to_data(annotation: &Annotation) -> AnnotationData {
    let annotation_type = match &annotation.annotation_type {
        AnnotationType::Arrow {
            start,
            end,
            head,
            stroke_width,
        } => AnnotationTypeData::Arrow {
            start_x: start.x,
            start_y: start.y,
            end_x: end.x,
            end_y: end.y,
            head: match head {
                ArrowHead::End => "end",
                ArrowHead::Start => "start",
                ArrowHead::Both => "both",
                ArrowHead::None => "none",
            }
            .to_string(),
            stroke_width: *stroke_width,
        },

        AnnotationType::Box {
            region,
            stroke_width,
            stroke_style,
            filled,
            corner_radius,
        } => AnnotationTypeData::Box {
            x: region.x,
            y: region.y,
            width: region.width,
            height: region.height,
            stroke_width: *stroke_width,
            stroke_style: match stroke_style {
                StrokeStyle::Solid => "solid",
                StrokeStyle::Dashed => "dashed",
                StrokeStyle::Dotted => "dotted",
            }
            .to_string(),
            filled: *filled,
            corner_radius: *corner_radius,
        },

        AnnotationType::Text {
            position,
            content,
            font_size,
            align,
            background,
            max_width,
        } => AnnotationTypeData::Text {
            x: position.x,
            y: position.y,
            content: content.clone(),
            font_size: *font_size,
            align: match align {
                TextAlign::Left => "left",
                TextAlign::Center => "center",
                TextAlign::Right => "right",
            }
            .to_string(),
            background: background.map(|c| [c.r, c.g, c.b, c.a]),
            max_width: *max_width,
        },

        AnnotationType::Number {
            position,
            value,
            radius,
        } => AnnotationTypeData::Number {
            x: position.x,
            y: position.y,
            value: *value,
            radius: *radius,
        },

        AnnotationType::Blur { region, intensity } => AnnotationTypeData::Blur {
            x: region.x,
            y: region.y,
            width: region.width,
            height: region.height,
            intensity: match intensity {
                BlurIntensity::Light => "light",
                BlurIntensity::Medium => "medium",
                BlurIntensity::Heavy => "heavy",
                BlurIntensity::Pixelate => "pixelate",
            }
            .to_string(),
        },

        AnnotationType::Highlight {
            region,
            corner_radius,
        } => AnnotationTypeData::Highlight {
            x: region.x,
            y: region.y,
            width: region.width,
            height: region.height,
            corner_radius: *corner_radius,
        },

        AnnotationType::Line {
            start,
            end,
            stroke_width,
            stroke_style,
        } => AnnotationTypeData::Line {
            start_x: start.x,
            start_y: start.y,
            end_x: end.x,
            end_y: end.y,
            stroke_width: *stroke_width,
            stroke_style: match stroke_style {
                StrokeStyle::Solid => "solid",
                StrokeStyle::Dashed => "dashed",
                StrokeStyle::Dotted => "dotted",
            }
            .to_string(),
        },

        AnnotationType::Ellipse {
            center,
            radius_x,
            radius_y,
            stroke_width,
            filled,
        } => AnnotationTypeData::Ellipse {
            center_x: center.x,
            center_y: center.y,
            radius_x: *radius_x,
            radius_y: *radius_y,
            stroke_width: *stroke_width,
            filled: *filled,
        },

        AnnotationType::Crop { region } => AnnotationTypeData::Crop {
            x: region.x,
            y: region.y,
            width: region.width,
            height: region.height,
        },

        AnnotationType::Path {
            points,
            stroke_width,
            stroke_style,
        } => AnnotationTypeData::Path {
            points: points.iter().map(|p| (p.x, p.y)).collect(),
            stroke_width: *stroke_width,
            stroke_style: match stroke_style {
                StrokeStyle::Solid => "solid",
                StrokeStyle::Dashed => "dashed",
                StrokeStyle::Dotted => "dotted",
            }
            .to_string(),
        },

        AnnotationType::Image {
            region,
            asset,
            opacity,
        } => AnnotationTypeData::Image {
            x: region.x,
            y: region.y,
            width: region.width,
            height: region.height,
            asset_hash: asset.0.clone(),
            // Bytes aren't reachable from an Annotation alone (they live in the
            // caller's asset cache, out-of-band) -- callers that have them
            // patch this field on the returned AnnotationTypeData before
            // sending it over the wire.
            asset_base64: String::new(),
            opacity: *opacity,
        },
    };

    AnnotationData {
        annotation_type,
        color: [
            annotation.color.r,
            annotation.color.g,
            annotation.color.b,
            annotation.color.a,
        ],
        severity: annotation.severity.as_str().to_string(),
        label: annotation.label.clone(),
        z_index: annotation.z_index,
        owner: annotation.owner.clone(),
        group_id: annotation.group_id,
    }
}

/// Convert serializable AnnotationData back to core types
pub fn data_to_annotation(id: u64, data: &AnnotationData) -> Annotation {
    let annotation_type = match &data.annotation_type {
        AnnotationTypeData::Arrow {
            start_x,
            start_y,
            end_x,
            end_y,
            head,
            stroke_width,
        } => AnnotationType::Arrow {
            start: Point::new(*start_x, *start_y),
            end: Point::new(*end_x, *end_y),
            head: match head.as_str() {
                "start" => ArrowHead::Start,
                "both" => ArrowHead::Both,
                "none" => ArrowHead::None,
                _ => ArrowHead::End,
            },
            stroke_width: *stroke_width,
        },

        AnnotationTypeData::Box {
            x,
            y,
            width,
            height,
            stroke_width,
            stroke_style,
            filled,
            corner_radius,
        } => AnnotationType::Box {
            region: Region::new(*x, *y, *width, *height),
            stroke_width: *stroke_width,
            stroke_style: match stroke_style.as_str() {
                "dashed" => StrokeStyle::Dashed,
                "dotted" => StrokeStyle::Dotted,
                _ => StrokeStyle::Solid,
            },
            filled: *filled,
            corner_radius: *corner_radius,
        },

        AnnotationTypeData::Text {
            x,
            y,
            content,
            font_size,
            align,
            background,
            max_width,
        } => AnnotationType::Text {
            position: Point::new(*x, *y),
            content: content.clone(),
            font_size: *font_size,
            align: match align.as_str() {
                "center" => TextAlign::Center,
                "right" => TextAlign::Right,
                _ => TextAlign::Left,
            },
            background: background.map(|c| Color::rgba(c[0], c[1], c[2], c[3])),
            max_width: *max_width,
        },

        AnnotationTypeData::Number {
            x,
            y,
            value,
            radius,
        } => AnnotationType::Number {
            position: Point::new(*x, *y),
            value: *value,
            radius: *radius,
        },

        AnnotationTypeData::Blur {
            x,
            y,
            width,
            height,
            intensity,
        } => AnnotationType::Blur {
            region: Region::new(*x, *y, *width, *height),
            intensity: match intensity.as_str() {
                "light" => BlurIntensity::Light,
                "heavy" => BlurIntensity::Heavy,
                "pixelate" => BlurIntensity::Pixelate,
                _ => BlurIntensity::Medium,
            },
        },

        AnnotationTypeData::Highlight {
            x,
            y,
            width,
            height,
            corner_radius,
        } => AnnotationType::Highlight {
            region: Region::new(*x, *y, *width, *height),
            corner_radius: *corner_radius,
        },

        AnnotationTypeData::Line {
            start_x,
            start_y,
            end_x,
            end_y,
            stroke_width,
            stroke_style,
        } => AnnotationType::Line {
            start: Point::new(*start_x, *start_y),
            end: Point::new(*end_x, *end_y),
            stroke_width: *stroke_width,
            stroke_style: match stroke_style.as_str() {
                "dashed" => StrokeStyle::Dashed,
                "dotted" => StrokeStyle::Dotted,
                _ => StrokeStyle::Solid,
            },
        },

        AnnotationTypeData::Ellipse {
            center_x,
            center_y,
            radius_x,
            radius_y,
            stroke_width,
            filled,
        } => AnnotationType::Ellipse {
            center: Point::new(*center_x, *center_y),
            radius_x: *radius_x,
            radius_y: *radius_y,
            stroke_width: *stroke_width,
            filled: *filled,
        },

        AnnotationTypeData::Crop {
            x,
            y,
            width,
            height,
        } => AnnotationType::Crop {
            region: Region::new(*x, *y, *width, *height),
        },

        AnnotationTypeData::Path {
            points,
            stroke_width,
            stroke_style,
        } => AnnotationType::Path {
            points: points.iter().map(|(x, y)| Point::new(*x, *y)).collect(),
            stroke_width: *stroke_width,
            stroke_style: match stroke_style.as_str() {
                "dashed" => StrokeStyle::Dashed,
                "dotted" => StrokeStyle::Dotted,
                _ => StrokeStyle::Solid,
            },
        },

        AnnotationTypeData::Image {
            x,
            y,
            width,
            height,
            asset_hash,
            opacity,
            // `asset_base64` isn't decoded here -- see `annotation_to_data`'s
            // doc comment; a caller that needs the bytes reads
            // `data.annotation_type`'s field directly and decodes it.
            asset_base64: _,
        } => AnnotationType::Image {
            region: Region::new(*x, *y, *width, *height),
            asset: nib_core::AssetRef(asset_hash.clone()),
            opacity: *opacity,
        },
    };

    let severity = match data.severity.as_str() {
        "info" => Severity::Info,
        "warning" => Severity::Warning,
        "error" => Severity::Error,
        "success" => Severity::Success,
        _ => Severity::None,
    };

    let mut annotation = Annotation::new(annotation_type);
    annotation.id = AnnotationId(id);
    annotation.color = Color::rgba(data.color[0], data.color[1], data.color[2], data.color[3]);
    annotation.severity = severity;
    annotation.label = data.label.clone();
    annotation.z_index = data.z_index;
    annotation.owner = data.owner.clone();
    annotation.group_id = data.group_id;

    annotation
}

/// Apply an AnnotationOp to a list of annotations
pub fn apply_operation(annotations: &mut Vec<Annotation>, op: &AnnotationOp) {
    match op {
        AnnotationOp::Add { id, data } => {
            let annotation = data_to_annotation(*id, data);
            annotations.push(annotation);
        }

        AnnotationOp::Remove { id } => {
            annotations.retain(|a| a.id.0 != *id);
        }

        AnnotationOp::Update { id, changes } => {
            if let Some(annotation) = annotations.iter_mut().find(|a| a.id.0 == *id) {
                for change in changes {
                    apply_property_change(annotation, change);
                }
                annotation.touch();
            }
        }

        AnnotationOp::Move {
            id,
            delta_x,
            delta_y,
        } => {
            if let Some(annotation) = annotations.iter_mut().find(|a| a.id.0 == *id) {
                move_annotation(&mut annotation.annotation_type, *delta_x, *delta_y);
                annotation.touch();
            }
        }

        AnnotationOp::Reorder { id, new_z } => {
            if let Some(annotation) = annotations.iter_mut().find(|a| a.id.0 == *id) {
                annotation.z_index = *new_z;
                annotation.touch();
            }
        }

        AnnotationOp::SetVisible { id, visible } => {
            if let Some(annotation) = annotations.iter_mut().find(|a| a.id.0 == *id) {
                annotation.visible = *visible;
                annotation.touch();
            }
        }

        AnnotationOp::SetLocked { id, locked } => {
            if let Some(annotation) = annotations.iter_mut().find(|a| a.id.0 == *id) {
                annotation.locked = *locked;
                annotation.touch();
            }
        }

        // SendToAgent is a signal, not a state mutation - no-op for annotation list
        AnnotationOp::SendToAgent { .. } => {}
    }
}

/// Apply a property change to an annotation
fn apply_property_change(annotation: &mut Annotation, change: &PropertyChange) {
    match change.property.as_str() {
        "color" => {
            if let Some(arr) = change.new_value.as_array() {
                if arr.len() == 4 {
                    annotation.color = Color::rgba(
                        arr[0].as_u64().unwrap_or(255) as u8,
                        arr[1].as_u64().unwrap_or(0) as u8,
                        arr[2].as_u64().unwrap_or(0) as u8,
                        arr[3].as_u64().unwrap_or(255) as u8,
                    );
                }
            }
        }
        "label" => {
            annotation.label = change.new_value.as_str().map(|s| s.to_string());
        }
        "z_index" => {
            if let Some(z) = change.new_value.as_i64() {
                annotation.z_index = z as i32;
            }
        }
        "severity" => {
            if let Some(s) = change.new_value.as_str() {
                annotation.severity = match s {
                    "info" => Severity::Info,
                    "warning" => Severity::Warning,
                    "error" => Severity::Error,
                    "success" => Severity::Success,
                    _ => Severity::None,
                };
            }
        }
        _ => {
            // Unknown property, ignore
        }
    }
}

/// Move an annotation type by delta
fn move_annotation(annotation_type: &mut AnnotationType, delta_x: f64, delta_y: f64) {
    match annotation_type {
        AnnotationType::Arrow { start, end, .. } => {
            start.x += delta_x;
            start.y += delta_y;
            end.x += delta_x;
            end.y += delta_y;
        }
        AnnotationType::Box { region, .. }
        | AnnotationType::Blur { region, .. }
        | AnnotationType::Highlight { region, .. }
        | AnnotationType::Image { region, .. }
        | AnnotationType::Crop { region } => {
            region.x += delta_x;
            region.y += delta_y;
        }
        AnnotationType::Text { position, .. } | AnnotationType::Number { position, .. } => {
            position.x += delta_x;
            position.y += delta_y;
        }
        AnnotationType::Line { start, end, .. } => {
            start.x += delta_x;
            start.y += delta_y;
            end.x += delta_x;
            end.y += delta_y;
        }
        AnnotationType::Ellipse { center, .. } => {
            center.x += delta_x;
            center.y += delta_y;
        }
        AnnotationType::Path { points, .. } => {
            for point in points.iter_mut() {
                point.x += delta_x;
                point.y += delta_y;
            }
        }
    }
}

/// Compose two Move operations on the same annotation
pub fn compose_moves(op1: &AnnotationOp, op2: &AnnotationOp) -> Option<AnnotationOp> {
    match (op1, op2) {
        (
            AnnotationOp::Move {
                id: id1,
                delta_x: dx1,
                delta_y: dy1,
            },
            AnnotationOp::Move {
                id: id2,
                delta_x: dx2,
                delta_y: dy2,
            },
        ) if id1 == id2 => Some(AnnotationOp::Move {
            id: *id1,
            delta_x: dx1 + dx2,
            delta_y: dy1 + dy2,
        }),
        _ => None,
    }
}

/// Get the inverse of an operation (for undo)
pub fn inverse_operation(op: &AnnotationOp, current_state: &[Annotation]) -> Option<AnnotationOp> {
    match op {
        AnnotationOp::Add { id, .. } => Some(AnnotationOp::Remove { id: *id }),

        AnnotationOp::Remove { id } => {
            // Need the original annotation data to invert
            current_state
                .iter()
                .find(|a| a.id.0 == *id)
                .map(|a| AnnotationOp::Add {
                    id: *id,
                    data: annotation_to_data(a),
                })
        }

        AnnotationOp::Move {
            id,
            delta_x,
            delta_y,
        } => Some(AnnotationOp::Move {
            id: *id,
            delta_x: -delta_x,
            delta_y: -delta_y,
        }),

        AnnotationOp::Reorder { id, new_z } => current_state
            .iter()
            .find(|a| a.id.0 == *id)
            .map(|a| AnnotationOp::Reorder {
                id: *id,
                new_z: a.z_index,
            })
            .or(Some(AnnotationOp::Reorder {
                id: *id,
                new_z: *new_z,
            })),

        AnnotationOp::SetVisible { id, visible } => Some(AnnotationOp::SetVisible {
            id: *id,
            visible: !visible,
        }),

        AnnotationOp::SetLocked { id, locked } => Some(AnnotationOp::SetLocked {
            id: *id,
            locked: !locked,
        }),

        AnnotationOp::Update { id, changes } => {
            // Swap old and new values
            let inverse_changes: Vec<PropertyChange> = changes
                .iter()
                .map(|c| PropertyChange {
                    property: c.property.clone(),
                    old_value: c.new_value.clone(),
                    new_value: c.old_value.clone(),
                })
                .collect();
            Some(AnnotationOp::Update {
                id: *id,
                changes: inverse_changes,
            })
        }

        // SendToAgent is a signal, not invertible
        AnnotationOp::SendToAgent { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose, Engine as _};

    #[test]
    fn test_annotation_roundtrip() {
        let arrow = Annotation::new(AnnotationType::Arrow {
            start: Point::new(10.0, 20.0),
            end: Point::new(100.0, 200.0),
            head: ArrowHead::End,
            stroke_width: 2.0,
        })
        .with_label("Test arrow")
        .with_severity(Severity::Error);

        let data = annotation_to_data(&arrow);
        let restored = data_to_annotation(arrow.id.0, &data);

        assert_eq!(arrow.label, restored.label);
        assert_eq!(arrow.severity, restored.severity);
        assert_eq!(arrow.color.r, restored.color.r);
    }

    #[test]
    fn test_group_id_roundtrip_over_wire() {
        let grouped = Annotation::new(AnnotationType::Number {
            position: Point::new(1.0, 2.0),
            value: 1,
            radius: 15.0,
        })
        .with_group_id(Some(9));

        let data = annotation_to_data(&grouped);
        let json = serde_json::to_string(&data).expect("serialize to json");
        let parsed: AnnotationData = serde_json::from_str(&json).expect("parse json");
        let restored = data_to_annotation(grouped.id.0, &parsed);
        assert_eq!(restored.group_id, Some(9));
    }

    #[test]
    fn test_old_wire_json_without_group_id_field_parses_as_ungrouped() {
        let json = r#"{"annotation_type":{"Number":{"x":1.0,"y":2.0,"value":1,"radius":15.0}},"color":[255,0,0,255],"severity":"none","label":null,"z_index":0,"owner":"human"}"#;
        let parsed: AnnotationData = serde_json::from_str(json).expect("parse json");
        let restored = data_to_annotation(1, &parsed);
        assert_eq!(restored.group_id, None);
    }

    #[test]
    fn test_image_annotation_roundtrip_with_base64_byte_identical() {
        let image = Annotation::new(AnnotationType::Image {
            region: Region::new(5.0, 10.0, 300.0, 200.0),
            asset: nib_core::AssetRef("deadbeef1234".to_string()),
            opacity: 0.6,
        });

        let mut data = annotation_to_data(&image);
        // annotation_to_data can't fill this in itself -- an Annotation only
        // carries the asset's hash, not its bytes. A sender that has the
        // bytes (e.g. the GUI's asset cache) patches this in before putting
        // the AnnotationData on the wire; simulate that, then round-trip
        // through JSON the way the wire protocol actually would.
        let original_bytes = vec![10u8, 20, 30, 40, 250, 251, 252, 253];
        let expected_base64 = general_purpose::STANDARD.encode(&original_bytes);
        if let AnnotationTypeData::Image { asset_base64, .. } = &mut data.annotation_type {
            *asset_base64 = expected_base64.clone();
        } else {
            panic!("expected AnnotationTypeData::Image");
        }

        let json = serde_json::to_string(&data).expect("serialize to json");
        let parsed: AnnotationData = serde_json::from_str(&json).expect("parse json");

        let restored = data_to_annotation(image.id.0, &parsed);
        match restored.annotation_type {
            AnnotationType::Image {
                region,
                asset,
                opacity,
            } => {
                assert_eq!(region, Region::new(5.0, 10.0, 300.0, 200.0));
                assert_eq!(asset.0, "deadbeef1234");
                assert_eq!(opacity, 0.6);
            }
            other => panic!("expected Image, got {other:?}"),
        }

        let AnnotationTypeData::Image { asset_base64, .. } = &parsed.annotation_type else {
            panic!("expected AnnotationTypeData::Image");
        };
        assert_eq!(*asset_base64, expected_base64);
        let decoded = general_purpose::STANDARD
            .decode(asset_base64)
            .expect("valid base64");
        assert_eq!(
            decoded, original_bytes,
            "asset bytes must survive the wire round trip byte-identical"
        );
    }

    #[test]
    fn test_apply_add_remove() {
        let mut annotations = Vec::new();

        let data = AnnotationData {
            annotation_type: AnnotationTypeData::Number {
                x: 100.0,
                y: 100.0,
                value: 1,
                radius: 15.0,
            },
            color: [255, 0, 0, 255],
            severity: "error".to_string(),
            label: None,
            z_index: 0,
            owner: "human".to_string(),
            group_id: None,
        };

        // Add
        apply_operation(&mut annotations, &AnnotationOp::Add { id: 42, data });
        assert_eq!(annotations.len(), 1);
        assert_eq!(annotations[0].id.0, 42);

        // Remove
        apply_operation(&mut annotations, &AnnotationOp::Remove { id: 42 });
        assert_eq!(annotations.len(), 0);
    }

    #[test]
    fn test_apply_move() {
        let mut annotations = vec![Annotation::new(AnnotationType::Arrow {
            start: Point::new(0.0, 0.0),
            end: Point::new(100.0, 100.0),
            head: ArrowHead::End,
            stroke_width: 2.0,
        })];
        let id = annotations[0].id.0;

        apply_operation(
            &mut annotations,
            &AnnotationOp::Move {
                id,
                delta_x: 50.0,
                delta_y: 25.0,
            },
        );

        match &annotations[0].annotation_type {
            AnnotationType::Arrow { start, end, .. } => {
                assert_eq!(start.x, 50.0);
                assert_eq!(start.y, 25.0);
                assert_eq!(end.x, 150.0);
                assert_eq!(end.y, 125.0);
            }
            _ => panic!("Expected arrow"),
        }
    }

    #[test]
    fn test_owner_claude_preserved_in_roundtrip() {
        // Create annotation with owner "claude"
        let arrow = Annotation::new(AnnotationType::Arrow {
            start: Point::new(100.0, 100.0),
            end: Point::new(200.0, 150.0),
            head: ArrowHead::End,
            stroke_width: 2.0,
        })
        .with_owner("claude");

        assert_eq!(arrow.owner, "claude");

        // Convert to AnnotationData
        let data = annotation_to_data(&arrow);
        assert_eq!(data.owner, "claude");

        // Convert back to Annotation
        let restored = data_to_annotation(arrow.id.0, &data);
        assert_eq!(restored.owner, "claude");
    }

    #[test]
    fn test_owner_human_preserved_in_roundtrip() {
        // Create annotation with owner "human"
        let text = Annotation::new(AnnotationType::Text {
            position: Point::new(50.0, 50.0),
            content: "Human annotation".to_string(),
            font_size: 16.0,
            align: TextAlign::Left,
            background: None,
            max_width: None,
        })
        .with_owner("human");

        assert_eq!(text.owner, "human");

        // Convert to AnnotationData
        let data = annotation_to_data(&text);
        assert_eq!(data.owner, "human");

        // Convert back to Annotation
        let restored = data_to_annotation(text.id.0, &data);
        assert_eq!(restored.owner, "human");
    }

    #[test]
    fn test_owner_based_filtering() {
        // Simulate the GUI filtering logic: filter out owner == "claude"
        // This tests the same pattern used in send_to_claude()
        use std::collections::HashSet;

        let claude_arrow = Annotation::new(AnnotationType::Arrow {
            start: Point::new(100.0, 100.0),
            end: Point::new(200.0, 150.0),
            head: ArrowHead::End,
            stroke_width: 2.0,
        })
        .with_owner("claude");

        let human_text = Annotation::new(AnnotationType::Text {
            position: Point::new(50.0, 50.0),
            content: "Human drew this".to_string(),
            font_size: 16.0,
            align: TextAlign::Left,
            background: None,
            max_width: None,
        })
        .with_owner("human");

        let human_box = Annotation::new(AnnotationType::Box {
            region: Region::new(0.0, 0.0, 100.0, 50.0),
            stroke_width: 2.0,
            stroke_style: StrokeStyle::Solid,
            filled: false,
            corner_radius: 0.0,
        })
        .with_owner("human");

        let annotations = vec![claude_arrow.clone(), human_text.clone(), human_box.clone()];
        let sent_annotation_ids: HashSet<u64> = HashSet::new();

        // Filter: only human annotations that haven't been sent
        let delta_annotations: Vec<_> = annotations
            .iter()
            .filter(|a| !sent_annotation_ids.contains(&a.id.0) && a.owner != "claude")
            .collect();

        // Should only include human annotations
        assert_eq!(delta_annotations.len(), 2);
        assert!(delta_annotations.iter().all(|a| a.owner == "human"));
        assert!(delta_annotations
            .iter()
            .any(|a| matches!(a.annotation_type, AnnotationType::Text { .. })));
        assert!(delta_annotations
            .iter()
            .any(|a| matches!(a.annotation_type, AnnotationType::Box { .. })));
    }

    #[test]
    fn test_sent_annotation_ids_prevents_duplicates() {
        // Verify that annotations already in sent_annotation_ids are excluded
        use std::collections::HashSet;

        let human_arrow = Annotation::new(AnnotationType::Arrow {
            start: Point::new(100.0, 100.0),
            end: Point::new(200.0, 150.0),
            head: ArrowHead::End,
            stroke_width: 2.0,
        })
        .with_owner("human");

        let human_text = Annotation::new(AnnotationType::Text {
            position: Point::new(50.0, 50.0),
            content: "Another annotation".to_string(),
            font_size: 16.0,
            align: TextAlign::Left,
            background: None,
            max_width: None,
        })
        .with_owner("human");

        let annotations = vec![human_arrow.clone(), human_text.clone()];

        // First send: both should be included
        let mut sent_annotation_ids: HashSet<u64> = HashSet::new();

        let first_send: Vec<_> = annotations
            .iter()
            .filter(|a| !sent_annotation_ids.contains(&a.id.0) && a.owner != "claude")
            .collect();

        assert_eq!(first_send.len(), 2);

        // Mark both as sent
        for a in &first_send {
            sent_annotation_ids.insert(a.id.0);
        }

        // Second send: neither should be included (already sent)
        let second_send: Vec<_> = annotations
            .iter()
            .filter(|a| !sent_annotation_ids.contains(&a.id.0) && a.owner != "claude")
            .collect();

        assert_eq!(second_send.len(), 0);
    }
}
