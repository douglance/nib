//! QML (Nib Markup Language) parser and serializer
//!
//! QML is a lightweight markup format for encoding annotations.
//! It can be embedded in PNG tEXt chunks or rendered visually.
//!
//! ## Format
//! ```text
//! QML/1.0.0
//! a1:ARROW@120,340->200,400->"Fix this button"!error
//! a2:BOX@200,400,80,40->"Check this"
//! a3:TEXT@300,200->"Hello world"
//! a4:NUMBER@100,100#1
//! a5:BLUR@50,50,200,100
//! ```

use std::io::{BufRead, BufReader, Read, Write};

use super::errors::QmlError;
use super::types::*;

/// Result type for QML operations
pub type QmlResult<T> = std::result::Result<T, QmlError>;

/// QML format version
pub const QML_VERSION: &str = "1.0.0";

/// Parse QML format from a reader into annotations
///
/// # Arguments
/// * `reader` - Any type implementing Read (file, bytes, etc.)
///
/// # Returns
/// * `Ok(Vec<Annotation>)` - Parsed annotations
/// * `Err(QmlError)` - Parse error with line number and description
pub fn parse_qml<R: Read>(reader: R) -> QmlResult<Vec<Annotation>> {
    let buf_reader = BufReader::new(reader);
    let mut parser = QmlParser::new(buf_reader);
    parser.parse()
}

/// Parse QML from a string
pub fn parse_qml_str(content: &str) -> QmlResult<Vec<Annotation>> {
    parse_qml(content.as_bytes())
}

/// Serialize annotations to QML format
///
/// # Arguments
/// * `annotations` - The annotations to serialize
/// * `writer` - Any type implementing Write
pub fn serialize_qml<W: Write>(annotations: &[Annotation], writer: W) -> QmlResult<()> {
    let mut serializer = QmlSerializer::new(writer);
    serializer.write(annotations)
}

/// Serialize annotations to a String
pub fn serialize_qml_string(annotations: &[Annotation]) -> QmlResult<String> {
    let mut buffer = Vec::new();
    serialize_qml(annotations, &mut buffer)?;
    String::from_utf8(buffer).map_err(|e| QmlError::Parse {
        line: 0,
        message: format!("Invalid UTF-8: {}", e),
    })
}

// ============================================================================
// Internal Parser Implementation
// ============================================================================

struct QmlParser<R: Read> {
    reader: BufReader<R>,
    line_number: usize,
    current_line: String,
}

impl<R: Read> QmlParser<R> {
    fn new(reader: BufReader<R>) -> Self {
        Self {
            reader,
            line_number: 0,
            current_line: String::new(),
        }
    }

    fn parse(&mut self) -> QmlResult<Vec<Annotation>> {
        let mut annotations = Vec::new();

        // Read header line
        let header = self
            .read_line()?
            .ok_or_else(|| self.parse_error("Empty QML file"))?;
        if !header.starts_with("QML/") {
            return Err(self.parse_error(format!("Invalid header: {}", header)));
        }

        // Parse annotations
        while let Some(line) = self.read_line()? {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            if let Some(annotation) = self.parse_annotation_line(&line)? {
                annotations.push(annotation);
            }
        }

        Ok(annotations)
    }

    fn read_line(&mut self) -> QmlResult<Option<String>> {
        self.current_line.clear();
        self.line_number += 1;
        match self.reader.read_line(&mut self.current_line) {
            Ok(0) => Ok(None),
            Ok(_) => Ok(Some(self.current_line.trim().to_string())),
            Err(e) => Err(QmlError::Io(e)),
        }
    }

    fn parse_annotation_line(&self, line: &str) -> QmlResult<Option<Annotation>> {
        // Format: a1:TYPE@coords->"label"!severity
        // Examples:
        //   a1:ARROW@120,340->200,400->"Fix this"!error
        //   a2:BOX@100,100,200,150->"Check"
        //   a3:TEXT@50,50->"Hello"
        //   a4:NUMBER@100,100#3
        //   a5:BLUR@0,0,100,100

        if !line.starts_with('a') {
            return Ok(None);
        }

        // Find the colon separator
        let colon_pos = line
            .find(':')
            .ok_or_else(|| self.parse_error("Missing ':' in annotation"))?;

        let rest = &line[colon_pos + 1..];

        // Find the type (before @)
        let at_pos = rest
            .find('@')
            .ok_or_else(|| self.parse_error("Missing '@' in annotation"))?;
        let type_name = &rest[..at_pos];
        let params_str = &rest[at_pos + 1..];

        // Parse the annotation based on type
        let (annotation_type, remaining) = self.parse_annotation_type(type_name, params_str)?;

        let mut annotation = Annotation::new(annotation_type);

        // Parse optional label: ->"label text"
        let remaining = if let Some(label_start) = remaining.find("->\"") {
            let after_arrow = &remaining[label_start + 3..];
            if let Some(label_end) = after_arrow.find('"') {
                let label = unescape_string(&after_arrow[..label_end]);
                annotation.label = Some(label);
                &after_arrow[label_end + 1..]
            } else {
                remaining
            }
        } else {
            remaining
        };

        // Parse optional severity: !error, !warning, !info, !success
        if let Some(sev_start) = remaining.find('!') {
            let severity_str = &remaining[sev_start + 1..];
            let severity_end = severity_str
                .find(|c: char| !c.is_alphabetic())
                .unwrap_or(severity_str.len());
            let severity_name = &severity_str[..severity_end];

            annotation.severity = match severity_name.to_lowercase().as_str() {
                "error" | "critical" => Severity::Error,
                "warning" | "warn" => Severity::Warning,
                "info" => Severity::Info,
                "success" | "ok" => Severity::Success,
                _ => Severity::None,
            };
            annotation.color = annotation.severity.default_color();
        }

        Ok(Some(annotation))
    }

    fn parse_annotation_type<'a>(
        &self,
        type_name: &str,
        params: &'a str,
    ) -> QmlResult<(AnnotationType, &'a str)> {
        match type_name.to_uppercase().as_str() {
            "ARROW" => self.parse_arrow(params),
            "BOX" | "RECTANGLE" | "RECT" => self.parse_box(params),
            "TEXT" => self.parse_text(params),
            "NUMBER" | "NUM" => self.parse_number(params),
            "BLUR" | "REDACT" => self.parse_blur(params),
            "HIGHLIGHT" | "HL" => self.parse_highlight(params),
            "LINE" => self.parse_line(params),
            "ELLIPSE" | "CIRCLE" => self.parse_ellipse(params),
            "CROP" => self.parse_crop(params),
            "PATH" | "PENCIL" => self.parse_path(params),
            _ => Err(QmlError::UnknownAnnotationType(type_name.to_string())),
        }
    }

    fn parse_arrow<'a>(&self, params: &'a str) -> QmlResult<(AnnotationType, &'a str)> {
        // Format: x1,y1->x2,y2 or x1,y1→x2,y2
        let arrow_sep = params
            .find("->")
            .or_else(|| params.find('→'))
            .ok_or_else(|| self.parse_error("Arrow requires start->end coordinates"))?;

        let start_str = &params[..arrow_sep];
        let sep_len = if params[arrow_sep..].starts_with("->") {
            2
        } else {
            3
        }; // UTF-8 arrow
        let end_part = &params[arrow_sep + sep_len..];

        let start = self.parse_point(start_str)?;

        // End coordinates may be followed by label/severity
        let end_str = end_part
            .split(['-', '!'])
            .next()
            .unwrap_or(end_part);
        let end = self.parse_point(end_str)?;

        let remaining_start = end_str.len();

        Ok((
            AnnotationType::Arrow {
                start,
                end,
                head: ArrowHead::End,
                stroke_width: 2.0,
            },
            &end_part[remaining_start..],
        ))
    }

    fn parse_box<'a>(&self, params: &'a str) -> QmlResult<(AnnotationType, &'a str)> {
        // Format: x,y,width,height
        let (region, remaining) = self.parse_region(params)?;

        Ok((
            AnnotationType::Box {
                region,
                stroke_width: 2.0,
                stroke_style: StrokeStyle::Solid,
                filled: false,
                corner_radius: 0.0,
            },
            remaining,
        ))
    }

    fn parse_text<'a>(&self, params: &'a str) -> QmlResult<(AnnotationType, &'a str)> {
        // Format: x,y->"content" or x,y (content in label)
        let (point, remaining) = self.parse_point_with_remaining(params)?;

        // Check for inline content: ->"text"
        let content = if let Some(content_start) = remaining.find("->\"") {
            let after = &remaining[content_start + 3..];
            if let Some(end) = after.find('"') {
                unescape_string(&after[..end])
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        Ok((
            AnnotationType::Text {
                position: point,
                content,
                font_size: 14.0,
                align: TextAlign::Left,
                background: Some(Color::rgba(0, 0, 0, 200)),
                max_width: None,
            },
            remaining,
        ))
    }

    fn parse_number<'a>(&self, params: &'a str) -> QmlResult<(AnnotationType, &'a str)> {
        // Format: x,y#value or x,y (value defaults to 1)
        let (point, remaining) = self.parse_point_with_remaining(params)?;

        let value = if let Some(hash_pos) = remaining.find('#') {
            let num_str = &remaining[hash_pos + 1..];
            let num_end = num_str
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(num_str.len());
            num_str[..num_end].parse().unwrap_or(1)
        } else {
            1
        };

        Ok((
            AnnotationType::Number {
                position: point,
                value,
                radius: 12.0,
            },
            remaining,
        ))
    }

    fn parse_blur<'a>(&self, params: &'a str) -> QmlResult<(AnnotationType, &'a str)> {
        // Format: x,y,width,height
        let (region, remaining) = self.parse_region(params)?;

        Ok((
            AnnotationType::Blur {
                region,
                intensity: BlurIntensity::Medium,
            },
            remaining,
        ))
    }

    fn parse_highlight<'a>(&self, params: &'a str) -> QmlResult<(AnnotationType, &'a str)> {
        // Format: x,y,width,height
        let (region, remaining) = self.parse_region(params)?;

        Ok((
            AnnotationType::Highlight {
                region,
                corner_radius: 4.0,
            },
            remaining,
        ))
    }

    fn parse_line<'a>(&self, params: &'a str) -> QmlResult<(AnnotationType, &'a str)> {
        // Format: x1,y1->x2,y2 (same as arrow but no head)
        let arrow_sep = params
            .find("->")
            .or_else(|| params.find('→'))
            .ok_or_else(|| self.parse_error("Line requires start->end coordinates"))?;

        let start_str = &params[..arrow_sep];
        let sep_len = if params[arrow_sep..].starts_with("->") {
            2
        } else {
            3
        };
        let end_part = &params[arrow_sep + sep_len..];

        let start = self.parse_point(start_str)?;
        let end_str = end_part
            .split(['-', '!'])
            .next()
            .unwrap_or(end_part);
        let end = self.parse_point(end_str)?;

        let remaining_start = end_str.len();

        Ok((
            AnnotationType::Line {
                start,
                end,
                stroke_width: 2.0,
                stroke_style: StrokeStyle::Solid,
            },
            &end_part[remaining_start..],
        ))
    }

    fn parse_ellipse<'a>(&self, params: &'a str) -> QmlResult<(AnnotationType, &'a str)> {
        // Format: cx,cy,rx,ry or cx,cy,r (circle)
        let coords: Vec<&str> = params
            .split([',', '-', '!'])
            .take(4)
            .collect();

        if coords.len() < 3 {
            return Err(self.parse_error("Ellipse requires at least cx,cy,r"));
        }

        let cx = self.parse_f64(coords[0])?;
        let cy = self.parse_f64(coords[1])?;
        let rx = self.parse_f64(coords[2])?;
        let ry = if coords.len() >= 4 {
            self.parse_f64(coords[3])?
        } else {
            rx // Circle
        };

        // Calculate remaining string position
        let consumed = coords.iter().take(coords.len().min(4)).fold(0, |acc, s| {
            acc + s.len() + 1 // +1 for comma
        });
        let remaining = if consumed <= params.len() {
            &params[consumed.saturating_sub(1)..]
        } else {
            ""
        };

        Ok((
            AnnotationType::Ellipse {
                center: Point::new(cx, cy),
                radius_x: rx,
                radius_y: ry,
                stroke_width: 2.0,
                filled: false,
            },
            remaining,
        ))
    }

    fn parse_crop<'a>(&self, params: &'a str) -> QmlResult<(AnnotationType, &'a str)> {
        // Format: x,y,width,height
        let (region, remaining) = self.parse_region(params)?;

        Ok((AnnotationType::Crop { region }, remaining))
    }

    fn parse_path<'a>(&self, params: &'a str) -> QmlResult<(AnnotationType, &'a str)> {
        // Format: x1,y1;x2,y2;x3,y3;...
        // Points are separated by semicolons
        let mut points = Vec::new();

        // Find where the points section ends (at ->, !, or end of string)
        let points_end = params
            .find("->")
            .or_else(|| params.find('!'))
            .unwrap_or(params.len());

        let points_str = &params[..points_end];
        let remaining_params = &params[points_end..];

        // Parse each point separated by semicolons
        for point_str in points_str.split(';') {
            let trimmed = point_str.trim();
            if !trimmed.is_empty() {
                let point = self.parse_point(trimmed)?;
                points.push(point);
            }
        }

        if points.len() < 2 {
            return Err(self.parse_error("Path requires at least 2 points"));
        }

        Ok((
            AnnotationType::Path {
                points,
                stroke_width: 2.0,
                stroke_style: StrokeStyle::Solid,
            },
            remaining_params,
        ))
    }

    fn parse_point(&self, s: &str) -> QmlResult<Point> {
        let coords: Vec<&str> = s.split(',').collect();
        if coords.len() < 2 {
            return Err(self.parse_error(format!("Invalid point: {}", s)));
        }

        let x = self.parse_f64(coords[0])?;
        let y = self.parse_f64(coords[1])?;

        Ok(Point::new(x, y))
    }

    fn parse_point_with_remaining<'a>(&self, s: &'a str) -> QmlResult<(Point, &'a str)> {
        let mut comma_count = 0;
        let mut end_pos = 0;

        for (i, c) in s.char_indices() {
            if c == ',' {
                comma_count += 1;
                if comma_count == 2 {
                    end_pos = i;
                    break;
                }
            } else if !c.is_ascii_digit() && c != '.' && c != '-' && c != ',' {
                end_pos = i;
                break;
            }
            end_pos = i + c.len_utf8();
        }

        let point_str = &s[..end_pos];
        let point = self.parse_point(point_str)?;

        Ok((point, &s[end_pos..]))
    }

    fn parse_region<'a>(&self, s: &'a str) -> QmlResult<(Region, &'a str)> {
        // Parse 4 comma-separated numbers, stopping at non-numeric chars
        let mut nums = Vec::with_capacity(4);
        let mut current_start = 0;
        let mut i = 0;
        let chars: Vec<char> = s.chars().collect();

        while i < chars.len() && nums.len() < 4 {
            let c = chars[i];
            if c == ',' {
                let num_str: String = chars[current_start..i].iter().collect();
                nums.push(num_str);
                current_start = i + 1;
            } else if nums.len() == 3 {
                // For the 4th number, we need to be careful about '-'
                // It's only valid at the start of the number (negative)
                let is_at_start = i == current_start;
                let is_negative_sign = c == '-' && is_at_start;
                let is_numeric = c.is_ascii_digit() || c == '.';

                if !is_numeric && !is_negative_sign {
                    // End of the 4th number
                    let num_str: String = chars[current_start..i].iter().collect();
                    nums.push(num_str);
                    break;
                }
            }
            i += 1;
        }

        // If we reached end of string while collecting the 4th number
        if nums.len() == 3 && current_start < chars.len() {
            let num_str: String = chars[current_start..i].iter().collect();
            nums.push(num_str);
        }

        if nums.len() < 4 {
            return Err(self.parse_error(format!("Region requires x,y,width,height, got: {}", s)));
        }

        let x = self.parse_f64(&nums[0])?;
        let y = self.parse_f64(&nums[1])?;
        let w = self.parse_f64(&nums[2])?;
        let h = self.parse_f64(&nums[3])?;

        // Calculate how many characters we consumed
        let consumed = nums[0].len() + nums[1].len() + nums[2].len() + nums[3].len() + 3; // +3 for commas
        let remaining = if consumed <= s.len() {
            &s[consumed..]
        } else {
            ""
        };

        Ok((Region::new(x, y, w, h), remaining))
    }

    fn parse_f64(&self, s: &str) -> QmlResult<f64> {
        let trimmed = s.trim();
        trimmed
            .parse()
            .map_err(|_| self.parse_error(format!("Invalid number: '{}'", trimmed)))
    }

    fn parse_error(&self, message: impl Into<String>) -> QmlError {
        QmlError::Parse {
            line: self.line_number,
            message: message.into(),
        }
    }
}

// ============================================================================
// Internal Serializer Implementation
// ============================================================================

struct QmlSerializer<W: Write> {
    writer: W,
    annotation_counter: u32,
}

impl<W: Write> QmlSerializer<W> {
    fn new(writer: W) -> Self {
        Self {
            writer,
            annotation_counter: 0,
        }
    }

    fn write(&mut self, annotations: &[Annotation]) -> QmlResult<()> {
        // Write header
        writeln!(self.writer, "QML/{}", QML_VERSION).map_err(QmlError::Io)?;

        // Write each annotation
        for annotation in annotations {
            self.write_annotation(annotation)?;
        }

        Ok(())
    }

    fn write_annotation(&mut self, annotation: &Annotation) -> QmlResult<()> {
        self.annotation_counter += 1;
        let id = self.annotation_counter;

        let type_name = annotation.annotation_type.type_name().to_uppercase();

        // Build position string based on type
        let position = match &annotation.annotation_type {
            AnnotationType::Arrow { start, end, .. } => {
                format!("{:.0},{:.0}->{:.0},{:.0}", start.x, start.y, end.x, end.y)
            }
            AnnotationType::Box { region, .. }
            | AnnotationType::Blur { region, .. }
            | AnnotationType::Highlight { region, .. }
            | AnnotationType::Image { region, .. }
            | AnnotationType::Crop { region } => {
                format!(
                    "{:.0},{:.0},{:.0},{:.0}",
                    region.x, region.y, region.width, region.height
                )
            }
            AnnotationType::Text { position, .. } | AnnotationType::Number { position, .. } => {
                format!("{:.0},{:.0}", position.x, position.y)
            }
            AnnotationType::Line { start, end, .. } => {
                format!("{:.0},{:.0}->{:.0},{:.0}", start.x, start.y, end.x, end.y)
            }
            AnnotationType::Ellipse {
                center,
                radius_x,
                radius_y,
                ..
            } => {
                format!(
                    "{:.0},{:.0},{:.0},{:.0}",
                    center.x, center.y, radius_x, radius_y
                )
            }
            AnnotationType::Path { points, .. } => points
                .iter()
                .map(|p| format!("{:.0},{:.0}", p.x, p.y))
                .collect::<Vec<_>>()
                .join(";"),
        };

        // Build label string
        let label = annotation
            .label
            .as_ref()
            .map(|l| format!("->\"{}\"", escape_string(l)))
            .unwrap_or_default();

        // Build severity string
        let severity = match annotation.severity {
            Severity::None => String::new(),
            Severity::Info => "!info".to_string(),
            Severity::Warning => "!warning".to_string(),
            Severity::Error => "!error".to_string(),
            Severity::Success => "!success".to_string(),
        };

        writeln!(
            self.writer,
            "a{}:{}@{}{}{}",
            id, type_name, position, label, severity
        )
        .map_err(QmlError::Io)?;

        Ok(())
    }
}

/// Escape special characters in a string for QML format
fn escape_string(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

/// Unescape special characters from QML format
fn unescape_string(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => result.push('\n'),
                Some('r') => result.push('\r'),
                Some('t') => result.push('\t'),
                Some('"') => result.push('"'),
                Some('\\') => result.push('\\'),
                Some(other) => {
                    result.push('\\');
                    result.push(other);
                }
                None => result.push('\\'),
            }
        } else {
            result.push(c);
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_serialize_arrow() {
        let annotations = vec![Annotation::new(AnnotationType::Arrow {
            start: Point::new(10.0, 20.0),
            end: Point::new(100.0, 200.0),
            head: ArrowHead::End,
            stroke_width: 2.0,
        })
        .with_label("Look here")];

        let result = serialize_qml_string(&annotations).unwrap();
        assert!(result.contains("QML/1.0.0"));
        assert!(result.contains("ARROW"));
        assert!(result.contains("Look here"));
    }

    #[test]
    fn test_parse_arrow() {
        let qml = "QML/1.0.0\na1:ARROW@10,20->100,200\n";
        let annotations = parse_qml_str(qml).unwrap();
        assert_eq!(annotations.len(), 1);
        assert_eq!(annotations[0].annotation_type.type_name(), "arrow");

        if let AnnotationType::Arrow { start, end, .. } = &annotations[0].annotation_type {
            assert_eq!(start.x, 10.0);
            assert_eq!(start.y, 20.0);
            assert_eq!(end.x, 100.0);
            assert_eq!(end.y, 200.0);
        } else {
            panic!("Expected Arrow annotation");
        }
    }

    #[test]
    fn test_parse_arrow_with_label_and_severity() {
        let qml = "QML/1.0.0\na1:ARROW@10,20->100,200->\"Fix this button\"!error\n";
        let annotations = parse_qml_str(qml).unwrap();
        assert_eq!(annotations.len(), 1);
        assert_eq!(annotations[0].label, Some("Fix this button".to_string()));
        assert_eq!(annotations[0].severity, Severity::Error);
    }

    #[test]
    fn test_parse_box() {
        let qml = "QML/1.0.0\na1:BOX@100,200,150,80\n";
        let annotations = parse_qml_str(qml).unwrap();
        assert_eq!(annotations.len(), 1);

        if let AnnotationType::Box { region, .. } = &annotations[0].annotation_type {
            assert_eq!(region.x, 100.0);
            assert_eq!(region.y, 200.0);
            assert_eq!(region.width, 150.0);
            assert_eq!(region.height, 80.0);
        } else {
            panic!("Expected Box annotation");
        }
    }

    #[test]
    fn test_parse_number() {
        let qml = "QML/1.0.0\na1:NUMBER@50,60#3\n";
        let annotations = parse_qml_str(qml).unwrap();
        assert_eq!(annotations.len(), 1);

        if let AnnotationType::Number {
            position, value, ..
        } = &annotations[0].annotation_type
        {
            assert_eq!(position.x, 50.0);
            assert_eq!(position.y, 60.0);
            assert_eq!(*value, 3);
        } else {
            panic!("Expected Number annotation");
        }
    }

    #[test]
    fn test_parse_blur() {
        let qml = "QML/1.0.0\na1:BLUR@0,0,100,50\n";
        let annotations = parse_qml_str(qml).unwrap();
        assert_eq!(annotations.len(), 1);

        if let AnnotationType::Blur { region, .. } = &annotations[0].annotation_type {
            assert_eq!(region.x, 0.0);
            assert_eq!(region.y, 0.0);
            assert_eq!(region.width, 100.0);
            assert_eq!(region.height, 50.0);
        } else {
            panic!("Expected Blur annotation");
        }
    }

    #[test]
    fn test_parse_multiple_annotations() {
        let qml = r#"QML/1.0.0
a1:ARROW@10,20->100,200->"Look here"
a2:BOX@50,50,200,100->"Check this"!warning
a3:NUMBER@300,300#5
"#;
        let annotations = parse_qml_str(qml).unwrap();
        assert_eq!(annotations.len(), 3);
        assert_eq!(annotations[0].annotation_type.type_name(), "arrow");
        assert_eq!(annotations[1].annotation_type.type_name(), "box");
        assert_eq!(annotations[2].annotation_type.type_name(), "number");
    }

    #[test]
    fn test_roundtrip() {
        let original = vec![
            Annotation::new(AnnotationType::Arrow {
                start: Point::new(10.0, 20.0),
                end: Point::new(100.0, 200.0),
                head: ArrowHead::End,
                stroke_width: 2.0,
            })
            .with_label("Arrow label")
            .with_severity(Severity::Error),
            Annotation::new(AnnotationType::Box {
                region: Region::new(50.0, 50.0, 100.0, 80.0),
                stroke_width: 2.0,
                stroke_style: StrokeStyle::Solid,
                filled: false,
                corner_radius: 0.0,
            })
            .with_label("Box label"),
        ];

        let qml = serialize_qml_string(&original).unwrap();
        let parsed = parse_qml_str(&qml).unwrap();

        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].annotation_type.type_name(), "arrow");
        assert_eq!(parsed[1].annotation_type.type_name(), "box");
    }

    #[test]
    fn test_escape_unescape_roundtrip() {
        let original = "Hello \"world\"\nNew line\\backslash";
        let escaped = escape_string(original);
        let unescaped = unescape_string(&escaped);
        assert_eq!(original, unescaped);
    }

    #[test]
    fn test_parse_comments_and_empty_lines() {
        let qml = r#"QML/1.0.0
# This is a comment
a1:ARROW@10,20->100,200

# Another comment
a2:BOX@50,50,100,100
"#;
        let annotations = parse_qml_str(qml).unwrap();
        assert_eq!(annotations.len(), 2);
    }
}
