use lopdf::{Document, Object, ObjectId};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfDescriptor {
    pub page_count: usize,
    pub pages: Vec<PdfPageDescriptor>,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PdfPageDescriptor {
    pub width: f64,
    pub height: f64,
    pub rotation: i64,
}

pub fn inspect_pdf(path: &Path) -> Result<PdfDescriptor, String> {
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("E_PDF_INVALID: file does not start with a PDF header".into());
    }
    let document = Document::load_mem(&bytes)
        .map_err(|error| format!("E_PDF_INVALID: PDF parsing failed: {error}"))?;
    if document.is_encrypted() || document.was_encrypted() {
        return Err(
            "E_PDF_ENCRYPTED_UNSUPPORTED: password-protected PDFs are not supported".into(),
        );
    }

    let mut pages = Vec::new();
    for page_id in document.page_iter() {
        let page_box = inherited(&document, page_id, b"CropBox")
            .or_else(|| inherited(&document, page_id, b"MediaBox"))
            .ok_or_else(|| {
                "E_PDF_PAGE_GEOMETRY: page is missing CropBox and MediaBox".to_string()
            })?;
        let coordinates = page_box
            .as_array()
            .map_err(|_| "E_PDF_PAGE_GEOMETRY: page box must be an array".to_string())?;
        if coordinates.len() != 4 {
            return Err("E_PDF_PAGE_GEOMETRY: page box must contain four coordinates".into());
        }
        let number = |index: usize| {
            coordinates[index].as_float().map(f64::from).map_err(|_| {
                "E_PDF_PAGE_GEOMETRY: page box coordinates must be numbers".to_string()
            })
        };
        let width = (number(2)? - number(0)?).abs();
        let height = (number(3)? - number(1)?).abs();
        if width <= 0.0 || height <= 0.0 {
            return Err("E_PDF_PAGE_GEOMETRY: page dimensions must be positive".into());
        }
        let rotation = inherited(&document, page_id, b"Rotate")
            .and_then(|value| value.as_i64().ok())
            .unwrap_or(0)
            .rem_euclid(360);
        if !matches!(rotation, 0 | 90 | 180 | 270) {
            return Err(format!(
                "E_PDF_PAGE_GEOMETRY: unsupported page rotation {rotation}"
            ));
        }
        let (width, height) = if matches!(rotation, 90 | 270) {
            (height, width)
        } else {
            (width, height)
        };
        pages.push(PdfPageDescriptor {
            width,
            height,
            rotation,
        });
    }
    if pages.is_empty() {
        return Err("E_PDF_EMPTY: PDF contains no pages".into());
    }
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    Ok(PdfDescriptor {
        page_count: pages.len(),
        pages,
        sha256,
    })
}

fn inherited<'a>(document: &'a Document, start: ObjectId, key: &[u8]) -> Option<&'a Object> {
    let mut current = Some(start);
    let mut visited = HashSet::new();
    while let Some(id) = current {
        if !visited.insert(id) {
            return None;
        }
        let dictionary = document.get_dictionary(id).ok()?;
        if let Ok(value) = dictionary.get(key) {
            return document.dereference(value).ok().map(|(_, value)| value);
        }
        current = dictionary
            .get(b"Parent")
            .and_then(Object::as_reference)
            .ok();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Document, Object};

    #[test]
    fn inspects_page_geometry_in_display_order() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("review.pdf");
        write_fixture(&path);

        let descriptor = inspect_pdf(&path).unwrap();

        assert_eq!(descriptor.page_count, 2);
        assert_eq!(descriptor.pages[0].width, 612.0);
        assert_eq!(descriptor.pages[0].height, 792.0);
        assert_eq!(descriptor.pages[0].rotation, 0);
        assert_eq!(descriptor.pages[1].width, 792.0);
        assert_eq!(descriptor.pages[1].height, 612.0);
        assert_eq!(descriptor.pages[1].rotation, 90);
        assert_eq!(descriptor.sha256.len(), 64);
    }

    fn write_fixture(path: &Path) {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let first = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()]
        });
        let second = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Rotate" => 90
        });
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![first.into(), second.into()],
                "Count" => 2
            }),
        );
        let catalog = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id
        });
        document.trailer.set("Root", catalog);
        document.save(path).unwrap();
    }
}
