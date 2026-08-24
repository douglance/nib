use nib_core::{Annotation, AnnotationType, Color, Point, Region, StrokeStyle};
use nib_storage::NibFile;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use tempfile::TempDir;

fn create_test_image() -> Vec<u8> {
    vec![
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
        0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8,
        0xCF, 0xC0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x18, 0xDD, 0x8D, 0xB4, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ]
}

fn annotation() -> Annotation {
    Annotation::new(AnnotationType::Box {
        region: Region::new(10.0, 20.0, 30.0, 40.0),
        stroke_width: 2.0,
        stroke_style: StrokeStyle::Solid,
        filled: false,
        corner_radius: 0.0,
    })
    .with_color(Color::RED)
}

fn text_annotation() -> Annotation {
    Annotation::new(AnnotationType::Text {
        position: Point::new(12.0, 24.0),
        content: "updated".to_string(),
        font_size: 18.0,
        align: nib_core::TextAlign::Left,
        background: None,
        max_width: None,
    })
    .with_color(Color::BLUE)
}

fn sha256_file(path: &Path) -> String {
    let bytes = fs::read(path).unwrap();
    format!("{:x}", Sha256::digest(&bytes))
}

fn create_source(path: &Path) {
    let nib = NibFile::create(path, &create_test_image(), "png", 1, 1).unwrap();
    nib.add_annotation(&annotation()).unwrap();
    nib.save().unwrap();
}

#[test]
fn open_existing_nib_is_read_only_and_leaves_source_bytes_unchanged() {
    let temp_dir = TempDir::new().unwrap();
    let source = temp_dir.path().join("source.nib");
    create_source(&source);

    let before = sha256_file(&source);
    let nib = NibFile::open(&source).unwrap();

    assert!(nib.add_annotation(&annotation()).is_err());
    assert_eq!(sha256_file(&source), before);

    assert!(nib.update_annotation("a1", &text_annotation()).is_err());
    assert_eq!(sha256_file(&source), before);

    assert!(nib.delete_annotation("a1").is_err());
    assert_eq!(sha256_file(&source), before);

    assert!(nib.set_metadata("attempted", "write").is_err());
    assert_eq!(sha256_file(&source), before);
}

#[test]
fn editable_derivative_is_distinct_lineage_marked_and_contains_mutations() {
    let temp_dir = TempDir::new().unwrap();
    let source = temp_dir.path().join("source.nib");
    create_source(&source);

    let colliding_derivative = temp_dir.path().join("source.edit.nib");
    create_source(&colliding_derivative);

    let before = sha256_file(&source);
    let source_sha = before.clone();
    let derivative = NibFile::open_editable_derivative(&source).unwrap();
    let derivative_path = derivative.path().to_path_buf();

    assert_ne!(derivative_path, source);
    assert_eq!(derivative_path, temp_dir.path().join("source.edit-1.nib"));
    assert_eq!(
        derivative
            .get_metadata("derived_from_path")
            .unwrap()
            .as_deref(),
        Some(source.to_string_lossy().as_ref())
    );
    assert_eq!(
        derivative
            .get_metadata("derived_from_sha256")
            .unwrap()
            .as_deref(),
        Some(source_sha.as_str())
    );

    let added = derivative.add_annotation(&annotation()).unwrap();
    derivative.save().unwrap();
    assert_eq!(sha256_file(&source), before);

    derivative
        .update_annotation(&added, &text_annotation())
        .unwrap();
    derivative.save().unwrap();
    assert_eq!(sha256_file(&source), before);

    assert!(derivative.delete_annotation(&added).unwrap());
    derivative.save().unwrap();
    assert_eq!(sha256_file(&source), before);

    derivative.set_metadata("review_status", "edited").unwrap();
    derivative.save().unwrap();
    assert_eq!(sha256_file(&source), before);
    drop(derivative);

    let reopened_source = NibFile::open(&source).unwrap();
    assert_eq!(reopened_source.annotation_count().unwrap(), 1);
    assert!(reopened_source
        .get_metadata("review_status")
        .unwrap()
        .is_none());

    let derivative_before = sha256_file(&derivative_path);
    let derivative_of_derivative = NibFile::open_editable(&derivative_path).unwrap();
    let derivative_of_derivative_path = derivative_of_derivative.path().to_path_buf();
    assert_ne!(derivative_of_derivative_path, derivative_path);
    assert_eq!(
        derivative_of_derivative_path,
        temp_dir.path().join("source.edit-1.edit.nib")
    );
    assert_eq!(sha256_file(&source), before);
    assert_eq!(sha256_file(&derivative_path), derivative_before);
    assert_eq!(
        derivative_of_derivative
            .get_metadata("derived_from_path")
            .unwrap()
            .as_deref(),
        Some(derivative_path.to_string_lossy().as_ref())
    );
    assert_eq!(
        derivative_of_derivative
            .get_metadata("derived_from_sha256")
            .unwrap()
            .as_deref(),
        Some(derivative_before.as_str())
    );
    derivative_of_derivative
        .set_metadata("review_status", "edited-again")
        .unwrap();
    derivative_of_derivative.save().unwrap();
    assert_eq!(sha256_file(&source), before);
    assert_eq!(sha256_file(&derivative_path), derivative_before);
    drop(derivative_of_derivative);

    let reopened_derivative = NibFile::open(&derivative_path).unwrap();
    assert_eq!(
        reopened_derivative
            .get_metadata("review_status")
            .unwrap()
            .as_deref(),
        Some("edited")
    );

    let reopened_derivative_of_derivative = NibFile::open(&derivative_of_derivative_path).unwrap();
    assert_eq!(
        reopened_derivative_of_derivative
            .get_metadata("review_status")
            .unwrap()
            .as_deref(),
        Some("edited-again")
    );
}
