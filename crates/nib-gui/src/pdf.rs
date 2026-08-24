use gpui::RenderImage;
use image::Frame;
use pdfium_bundled::pdfium_render::prelude::*;
use std::path::Path;
use std::sync::{Arc, OnceLock};

static PDFIUM: OnceLock<Result<Pdfium, String>> = OnceLock::new();

fn pdfium() -> Result<&'static Pdfium, String> {
    match PDFIUM.get_or_init(|| {
        pdfium_bundled::bind_bundled().map_err(|error| format!("PDFium is unavailable: {error}"))
    }) {
        Ok(pdfium) => Ok(pdfium),
        Err(error) => Err(error.clone()),
    }
}

pub(crate) struct PdfPageFrame {
    pub(crate) image: Arc<RenderImage>,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) page_count: usize,
}

pub(crate) fn render_page(path: &Path, page_index: usize) -> Result<PdfPageFrame, String> {
    let document = pdfium()?
        .load_pdf_from_file(path, None)
        .map_err(|error| format!("Failed to open PDF: {error}"))?;
    let page_count = document.pages().len() as usize;
    if page_count == 0 {
        return Err("PDF must contain at least one page".to_string());
    }
    if page_index >= page_count {
        return Err(format!(
            "PDF page {} is outside the document's {} pages",
            page_index + 1,
            page_count
        ));
    }
    let page = document
        .pages()
        .get(page_index as PdfPageIndex)
        .map_err(|error| format!("Failed to open PDF page: {error}"))?;
    let rendered = page
        .render_with_config(
            &PdfRenderConfig::new()
                .set_target_width(2_048)
                .set_maximum_height(2_048)
                .render_form_data(true),
        )
        .map_err(|error| format!("Failed to render PDF page: {error}"))?
        .as_image()
        .map_err(|error| format!("Failed to decode rendered PDF page: {error}"))?
        .to_rgba8();
    let width = rendered.width();
    let height = rendered.height();

    Ok(PdfPageFrame {
        image: Arc::new(RenderImage::new(vec![Frame::new(rendered)])),
        width,
        height,
        page_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Document, Object};

    fn write_three_page_pdf(path: &Path) {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let portrait = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()]
        });
        let landscape = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 792.into(), 612.into()]
        });
        let rotated = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 420.into(), 595.into()],
            "Rotate" => 90
        });
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![portrait.into(), landscape.into(), rotated.into()],
                "Count" => 3
            }),
        );
        let catalog = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id
        });
        document.trailer.set("Root", catalog);
        document.save(path).unwrap();
    }

    #[test]
    fn renders_consecutive_mixed_size_pages_with_one_pdfium_binding() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("review.pdf");
        write_three_page_pdf(&path);

        let portrait = render_page(&path, 0).unwrap();
        let landscape = render_page(&path, 1).unwrap();
        let rotated = render_page(&path, 2).unwrap();

        assert_eq!(portrait.page_count, 3);
        assert_eq!(landscape.page_count, 3);
        assert_eq!(rotated.page_count, 3);
        assert!(portrait.height > portrait.width);
        assert!(landscape.width > landscape.height);
        assert!(rotated.width > rotated.height);

        let error = render_page(&path, 3).err().expect("page 4 must fail");
        assert!(error.contains("outside the document's 3 pages"));
    }
}
