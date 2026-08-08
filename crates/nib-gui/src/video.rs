use gpui::RenderImage;
use image::{Frame, ImageBuffer, Rgba};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_av_foundation::{AVPlayer, AVPlayerItemVideoOutput};
use objc2_core_media::{kCMTimeZero, CMTime};
use objc2_core_video::{
    kCVPixelFormatType_32BGRA, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
    CVPixelBufferGetHeight, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress,
    CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{NSDictionary, NSNumber, NSString, NSURL};
use std::path::Path;
use std::sync::Arc;

pub(crate) struct VideoPlayer {
    player: Retained<AVPlayer>,
    output: Retained<AVPlayerItemVideoOutput>,
}

pub(crate) struct VideoFrame {
    pub(crate) image: Arc<RenderImage>,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

impl VideoPlayer {
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        let mtm = MainThreadMarker::new()
            .ok_or_else(|| "Video playback must be initialized on the main thread".to_string())?;
        let path = NSString::from_str(&path.to_string_lossy());
        let url = NSURL::fileURLWithPath(&path);
        let player = unsafe { AVPlayer::playerWithURL(&url, mtm) };

        let key = NSString::from_str("PixelFormatType");
        let value = NSNumber::new_u32(kCVPixelFormatType_32BGRA);
        let typed = NSDictionary::<NSString, NSNumber>::from_slices(&[&*key], &[&*value]);
        // NSDictionary is covariant at runtime and NSNumber is an Objective-C object.
        let attributes =
            unsafe { &*(Retained::as_ptr(&typed) as *const NSDictionary<NSString, AnyObject>) };
        let output = unsafe {
            AVPlayerItemVideoOutput::initWithPixelBufferAttributes(
                mtm.alloc::<AVPlayerItemVideoOutput>(),
                Some(attributes),
            )
        };
        let item = unsafe { player.currentItem() }
            .ok_or_else(|| "AVPlayer did not create a video item".to_string())?;
        unsafe { item.addOutput(&output) };

        Ok(Self { player, output })
    }

    pub(crate) fn is_playing(&self) -> bool {
        unsafe { self.player.rate() != 0.0 }
    }

    pub(crate) fn play(&self) {
        unsafe { self.player.play() };
    }

    pub(crate) fn pause(&self) {
        unsafe { self.player.pause() };
    }

    pub(crate) fn current_ms(&self) -> u64 {
        let seconds = unsafe { self.player.currentTime().seconds() };
        seconds.max(0.0).mul_add(1000.0, 0.0) as u64
    }

    pub(crate) fn duration_ms(&self) -> u64 {
        unsafe {
            self.player
                .currentItem()
                .map(|item| item.duration().seconds())
                .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
                .unwrap_or(0.0)
                .mul_add(1000.0, 0.0) as u64
        }
    }

    pub(crate) fn seek_ms(&self, milliseconds: u64) {
        let time = unsafe { CMTime::with_seconds(milliseconds as f64 / 1000.0, 600) };
        unsafe {
            self.player
                .seekToTime_toleranceBefore_toleranceAfter(time, kCMTimeZero, kCMTimeZero)
        };
    }

    pub(crate) fn step_frames(&self, count: isize) {
        unsafe {
            self.player.pause();
            if let Some(item) = self.player.currentItem() {
                item.stepByCount(count);
            }
        }
    }

    pub(crate) fn copy_frame(&self) -> Result<Option<VideoFrame>, String> {
        let item_time = unsafe { self.player.currentTime() };
        if !unsafe { self.output.hasNewPixelBufferForItemTime(item_time) } {
            return Ok(None);
        }
        let Some(buffer) = (unsafe {
            self.output
                .copyPixelBufferForItemTime_itemTimeForDisplay(item_time, std::ptr::null_mut())
        }) else {
            return Ok(None);
        };

        let flags = CVPixelBufferLockFlags::ReadOnly;
        let status = unsafe { CVPixelBufferLockBaseAddress(&buffer, flags) };
        if status != 0 {
            return Err(format!("CVPixelBufferLockBaseAddress failed with {status}"));
        }

        let width = CVPixelBufferGetWidth(&buffer);
        let height = CVPixelBufferGetHeight(&buffer);
        let stride = CVPixelBufferGetBytesPerRow(&buffer);
        let base = CVPixelBufferGetBaseAddress(&buffer).cast::<u8>();
        let pixels = if base.is_null() {
            Err("AVPlayer returned a pixel buffer without an address".to_string())
        } else {
            let source = unsafe { std::slice::from_raw_parts(base, stride * height) };
            copy_bgra_rows(source, width, height, stride)
        };
        unsafe {
            CVPixelBufferUnlockBaseAddress(&buffer, flags);
        }

        let pixels = pixels?;
        let image = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(width as u32, height as u32, pixels)
            .ok_or_else(|| "Failed to construct the GPUI video frame".to_string())?;
        Ok(Some(VideoFrame {
            image: Arc::new(RenderImage::new(vec![Frame::new(image)])),
            width: width as u32,
            height: height as u32,
        }))
    }
}

impl Drop for VideoPlayer {
    fn drop(&mut self) {
        unsafe {
            self.player.pause();
        }
    }
}

fn copy_bgra_rows(
    source: &[u8],
    width: usize,
    height: usize,
    stride: usize,
) -> Result<Vec<u8>, String> {
    let row_bytes = width
        .checked_mul(4)
        .ok_or_else(|| "Video frame width overflowed".to_string())?;
    if stride < row_bytes || source.len() < stride.saturating_mul(height) {
        return Err("Video frame buffer has invalid row stride".to_string());
    }
    let mut pixels = Vec::with_capacity(row_bytes.saturating_mul(height));
    for row in source.chunks_exact(stride).take(height) {
        pixels.extend_from_slice(&row[..row_bytes]);
    }
    Ok(pixels)
}

#[cfg(test)]
mod tests {
    use super::copy_bgra_rows;

    #[test]
    fn copies_bgra_rows_without_stride_padding() {
        let source = [
            1, 2, 3, 4, 5, 6, 7, 8, 99, 99, 99, 99, 9, 10, 11, 12, 13, 14, 15, 16, 88, 88, 88, 88,
        ];
        assert_eq!(
            copy_bgra_rows(&source, 2, 2, 12).unwrap(),
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
        );
    }

    #[test]
    fn rejects_short_video_frame_rows() {
        assert!(copy_bgra_rows(&[0; 8], 2, 2, 4).is_err());
    }
}
