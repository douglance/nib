//! QML file I/O
//!
//! Handles reading and writing QML-annotated PNG files.
//! QML metadata is embedded in PNG tEXt chunks with keyword "QML".

use crate::StorageResult;
use nib_core::{qml, Annotation, ImageSource, NibImage, StorageError};
use image::ImageReader;
use std::io::Write;
use std::path::Path;

/// PNG chunk type for tEXt metadata
const PNG_TEXT_CHUNK: &[u8; 4] = b"tEXt";
/// PNG end chunk type
const PNG_IEND_CHUNK: &[u8; 4] = b"IEND";
/// QML keyword for tEXt chunks
const QML_KEYWORD: &str = "QML";

/// Load a NibImage from a PNG file with embedded QML
pub fn load_qml_image(path: impl AsRef<Path>) -> StorageResult<NibImage> {
    let path = path.as_ref();
    let image_data = std::fs::read(path)?;

    // Parse image to extract dimensions
    let img = ImageReader::new(std::io::Cursor::new(&image_data))
        .with_guessed_format()
        .map_err(|e| StorageError::InvalidFormat(e.to_string()))?
        .decode()
        .map_err(|e| StorageError::InvalidFormat(e.to_string()))?;

    let width = img.width();
    let height = img.height();

    // Extract QML from tEXt chunk
    let annotations = extract_qml_from_png(&image_data)?;

    let mut image = NibImage::new(
        image_data,
        width,
        height,
        ImageSource::File(path.to_path_buf()),
    );
    image.annotations = annotations;
    image.file_path = Some(path.to_path_buf());

    Ok(image)
}

/// Save a NibImage to a PNG file with embedded QML
pub fn save_qml_image(image: &NibImage, path: impl AsRef<Path>) -> StorageResult<()> {
    let path = path.as_ref();

    // Serialize annotations to QML
    let qml_string = qml::serialize_qml_string(&image.annotations)
        .map_err(|e| StorageError::InvalidFormat(e.to_string()))?;

    // Embed QML in PNG data
    let png_with_qml = embed_qml_in_png(&image.image_data, &qml_string)?;

    // Write the file
    std::fs::write(path, &png_with_qml)?;

    Ok(())
}

/// Extract QML annotations from PNG tEXt chunk
fn extract_qml_from_png(png_data: &[u8]) -> StorageResult<Vec<Annotation>> {
    // Verify PNG signature
    if png_data.len() < 8 || &png_data[0..8] != b"\x89PNG\r\n\x1a\n" {
        return Err(StorageError::InvalidFormat("Not a valid PNG file".into()));
    }

    let mut pos = 8; // Skip PNG signature

    while pos + 12 <= png_data.len() {
        // Read chunk length (big-endian)
        let length = u32::from_be_bytes([
            png_data[pos],
            png_data[pos + 1],
            png_data[pos + 2],
            png_data[pos + 3],
        ]) as usize;

        // Read chunk type
        let chunk_type = &png_data[pos + 4..pos + 8];

        // Check if we've reached IEND
        if chunk_type == PNG_IEND_CHUNK {
            break;
        }

        // Check for tEXt chunk
        if chunk_type == PNG_TEXT_CHUNK && pos + 8 + length <= png_data.len() {
            let chunk_data = &png_data[pos + 8..pos + 8 + length];

            // tEXt format: keyword\0text
            if let Some(null_pos) = chunk_data.iter().position(|&b| b == 0) {
                let keyword = std::str::from_utf8(&chunk_data[..null_pos]).unwrap_or("");

                if keyword == QML_KEYWORD {
                    let text_data = &chunk_data[null_pos + 1..];
                    if let Ok(qml_text) = std::str::from_utf8(text_data) {
                        // Parse QML and return annotations
                        return qml::parse_qml_str(qml_text)
                            .map_err(|e| StorageError::InvalidFormat(e.to_string()));
                    }
                }
            }
        }

        // Move to next chunk (length + type + data + CRC)
        pos += 12 + length;
    }

    // No QML chunk found - return empty annotations
    Ok(Vec::new())
}

/// Embed QML in PNG tEXt chunk
fn embed_qml_in_png(png_data: &[u8], qml_text: &str) -> StorageResult<Vec<u8>> {
    // Verify PNG signature
    if png_data.len() < 8 || &png_data[0..8] != b"\x89PNG\r\n\x1a\n" {
        return Err(StorageError::InvalidFormat("Not a valid PNG file".into()));
    }

    let mut result = Vec::with_capacity(png_data.len() + qml_text.len() + 100);

    // Copy PNG signature
    result.extend_from_slice(&png_data[0..8]);

    let mut pos = 8;
    let mut inserted = false;

    while pos + 12 <= png_data.len() {
        // Read chunk length and type
        let length = u32::from_be_bytes([
            png_data[pos],
            png_data[pos + 1],
            png_data[pos + 2],
            png_data[pos + 3],
        ]) as usize;

        let chunk_type = &png_data[pos + 4..pos + 8];
        let chunk_end = pos + 12 + length;

        if chunk_end > png_data.len() {
            break;
        }

        // Skip existing QML tEXt chunks
        if chunk_type == PNG_TEXT_CHUNK {
            let chunk_data = &png_data[pos + 8..pos + 8 + length];
            if let Some(null_pos) = chunk_data.iter().position(|&b| b == 0) {
                let keyword = std::str::from_utf8(&chunk_data[..null_pos]).unwrap_or("");
                if keyword == QML_KEYWORD {
                    // Skip this chunk (we'll add our own)
                    pos = chunk_end;
                    continue;
                }
            }
        }

        // Insert our QML chunk before IEND
        if chunk_type == PNG_IEND_CHUNK && !inserted {
            write_text_chunk(&mut result, QML_KEYWORD, qml_text)?;
            inserted = true;
        }

        // Copy original chunk
        result.extend_from_slice(&png_data[pos..chunk_end]);
        pos = chunk_end;
    }

    // If we somehow didn't insert (malformed PNG), append the chunk
    if !inserted {
        write_text_chunk(&mut result, QML_KEYWORD, qml_text)?;
    }

    Ok(result)
}

/// Write a PNG tEXt chunk
fn write_text_chunk<W: Write>(writer: &mut W, keyword: &str, text: &str) -> StorageResult<()> {
    // Build chunk data: keyword + null + text
    let mut chunk_data = Vec::new();
    chunk_data.extend_from_slice(keyword.as_bytes());
    chunk_data.push(0); // Null separator
    chunk_data.extend_from_slice(text.as_bytes());

    let length = chunk_data.len() as u32;

    // Write length (big-endian)
    writer.write_all(&length.to_be_bytes())?;

    // Write chunk type
    writer.write_all(PNG_TEXT_CHUNK)?;

    // Write chunk data
    writer.write_all(&chunk_data)?;

    // Calculate and write CRC (over type + data)
    let mut crc_data = Vec::with_capacity(4 + chunk_data.len());
    crc_data.extend_from_slice(PNG_TEXT_CHUNK);
    crc_data.extend_from_slice(&chunk_data);
    let crc = crc32(&crc_data);
    writer.write_all(&crc.to_be_bytes())?;

    Ok(())
}

/// Calculate CRC32 for PNG chunks (ISO 3309 / ITU-T V.42)
fn crc32(data: &[u8]) -> u32 {
    // CRC32 lookup table
    const CRC_TABLE: [u32; 256] = {
        let mut table = [0u32; 256];
        let mut i = 0;
        while i < 256 {
            let mut c = i as u32;
            let mut k = 0;
            while k < 8 {
                if c & 1 != 0 {
                    c = 0xedb88320 ^ (c >> 1);
                } else {
                    c >>= 1;
                }
                k += 1;
            }
            table[i] = c;
            i += 1;
        }
        table
    };

    let mut crc = 0xffffffff_u32;
    for &byte in data {
        crc = CRC_TABLE[((crc ^ byte as u32) & 0xff) as usize] ^ (crc >> 8);
    }
    crc ^ 0xffffffff
}

/// Load QML from a standalone .qml text file
pub fn load_qml_file(path: impl AsRef<Path>) -> StorageResult<Vec<Annotation>> {
    let content = std::fs::read_to_string(path.as_ref())?;
    qml::parse_qml_str(&content).map_err(|e| StorageError::InvalidFormat(e.to_string()))
}

/// Save annotations to a standalone .qml text file
pub fn save_qml_file(annotations: &[Annotation], path: impl AsRef<Path>) -> StorageResult<()> {
    let qml_string =
        qml::serialize_qml_string(annotations).map_err(|e| StorageError::InvalidFormat(e.to_string()))?;
    std::fs::write(path.as_ref(), qml_string)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_minimal_png() -> Vec<u8> {
        // Minimal valid 1x1 white PNG
        let png_data: &[u8] = &[
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
            0x00, 0x00, 0x00, 0x0d, // IHDR length
            0x49, 0x48, 0x44, 0x52, // IHDR type
            0x00, 0x00, 0x00, 0x01, // width: 1
            0x00, 0x00, 0x00, 0x01, // height: 1
            0x08, 0x02, // bit depth: 8, color type: 2 (RGB)
            0x00, 0x00, 0x00, // compression, filter, interlace
            0x90, 0x77, 0x53, 0xde, // IHDR CRC
            0x00, 0x00, 0x00, 0x0c, // IDAT length
            0x49, 0x44, 0x41, 0x54, // IDAT type
            0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0xff, 0x00, 0x05, 0xfe, 0x02, 0xfe, // compressed data
            0xa3, 0x6e, 0x57, 0xcd, // IDAT CRC
            0x00, 0x00, 0x00, 0x00, // IEND length
            0x49, 0x45, 0x4e, 0x44, // IEND type
            0xae, 0x42, 0x60, 0x82, // IEND CRC
        ];
        png_data.to_vec()
    }

    #[test]
    fn test_embed_and_extract_qml() {
        let png_data = create_minimal_png();
        let qml_text = "QML/1.0.0\na1:ARROW@10,20->100,200\n";

        // Embed QML
        let png_with_qml = embed_qml_in_png(&png_data, qml_text).unwrap();
        assert!(png_with_qml.len() > png_data.len());

        // Extract QML
        let annotations = extract_qml_from_png(&png_with_qml).unwrap();
        assert_eq!(annotations.len(), 1);
        assert_eq!(annotations[0].annotation_type.type_name(), "arrow");
    }

    #[test]
    fn test_extract_from_png_without_qml() {
        let png_data = create_minimal_png();
        let annotations = extract_qml_from_png(&png_data).unwrap();
        assert!(annotations.is_empty());
    }

    #[test]
    fn test_crc32() {
        // Known CRC32 values
        assert_eq!(crc32(b""), 0x00000000);
        assert_eq!(crc32(b"123456789"), 0xcbf43926);
    }

    #[test]
    fn test_replace_existing_qml() {
        let png_data = create_minimal_png();

        // Add first QML
        let qml1 = "QML/1.0.0\na1:ARROW@10,20->100,200\n";
        let png_v1 = embed_qml_in_png(&png_data, qml1).unwrap();

        // Replace with second QML
        let qml2 = "QML/1.0.0\na1:BOX@50,50,100,100\na2:NUMBER@200,200#5\n";
        let png_v2 = embed_qml_in_png(&png_v1, qml2).unwrap();

        // Verify only second QML is present
        let annotations = extract_qml_from_png(&png_v2).unwrap();
        assert_eq!(annotations.len(), 2);
        assert_eq!(annotations[0].annotation_type.type_name(), "box");
        assert_eq!(annotations[1].annotation_type.type_name(), "number");
    }
}
