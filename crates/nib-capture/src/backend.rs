use crate::{CaptureResult, DisplayInfo, WindowInfo};
use image::{imageops, RgbaImage};
use nib_core::{CaptureError, ImageSource, NibImage, Region};
use std::fmt;
use std::time::SystemTime;

/// Capability snapshot for the active capture backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureCapabilities {
    pub screen_capture: bool,
    pub region_capture: bool,
    pub window_capture: bool,
    pub multi_display_capture: bool,
    pub logical_to_physical_scaling: bool,
    pub restricted_wayland: bool,
}

/// Capture target requested by callers.
#[derive(Debug, Clone, PartialEq)]
pub enum CaptureTarget {
    Primary,
    DisplayId(u32),
    AllDisplays,
    Region { display_id: u32, region: Region },
    WindowId(u32),
}

impl fmt::Display for CaptureTarget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CaptureTarget::Primary => write!(f, "primary display"),
            CaptureTarget::DisplayId(id) => write!(f, "display {id}"),
            CaptureTarget::AllDisplays => write!(f, "all displays"),
            CaptureTarget::Region { display_id, .. } => write!(f, "region on display {display_id}"),
            CaptureTarget::WindowId(id) => write!(f, "window {id}"),
        }
    }
}

/// Physical pixel bounds derived from logical display coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhysicalRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// One captured image frame plus the target metadata used to produce it.
#[derive(Debug, Clone)]
pub struct CapturedFrame {
    pub image: NibImage,
    pub display: Option<DisplayInfo>,
    pub window: Option<WindowInfo>,
    pub logical_region: Option<Region>,
    pub physical_region: Option<PhysicalRegion>,
    pub captured_at: SystemTime,
}

/// A completed capture request.
#[derive(Debug, Clone)]
pub struct CaptureSession {
    pub backend: &'static str,
    pub target: CaptureTarget,
    pub frame: CapturedFrame,
}

impl CaptureSession {
    pub fn new(backend: &'static str, target: CaptureTarget, frame: CapturedFrame) -> Self {
        Self {
            backend,
            target,
            frame,
        }
    }

    pub fn into_image(self) -> NibImage {
        self.frame.image
    }
}

/// Platform-neutral capture backend interface.
pub trait CaptureBackend: fmt::Debug {
    fn name(&self) -> &'static str;
    fn capabilities(&self) -> CaptureCapabilities;
    fn list_displays(&self) -> CaptureResult<Vec<DisplayInfo>>;
    fn list_windows(&self) -> CaptureResult<Vec<WindowInfo>>;
    fn capture(&self, target: CaptureTarget) -> CaptureResult<CaptureSession>;

    fn resolve_display(&self, target: CaptureTarget) -> CaptureResult<DisplayInfo> {
        match target {
            CaptureTarget::Primary => self
                .list_displays()?
                .into_iter()
                .find(|display| display.is_primary)
                .ok_or(CaptureError::DisplayNotFound(0)),
            CaptureTarget::DisplayId(display_id) | CaptureTarget::Region { display_id, .. } => self
                .list_displays()?
                .into_iter()
                .find(|display| display.id == display_id)
                .ok_or(CaptureError::DisplayNotFound(display_id)),
            CaptureTarget::AllDisplays | CaptureTarget::WindowId(_) => {
                Err(CaptureError::CaptureFailed(format!(
                    "{target} does not identify exactly one display"
                )))
            }
        }
    }
}

/// Error for capability-disabled targets. It is explicit that no fallback backend is used.
pub fn backend_not_available(backend: &str, target: CaptureTarget) -> CaptureError {
    CaptureError::PlatformNotSupported(format!(
        "{backend} cannot capture {target}; no fallback backend is configured"
    ))
}

pub fn logical_to_physical_region(
    region: Region,
    display: &DisplayInfo,
) -> CaptureResult<PhysicalRegion> {
    if region.x < 0.0
        || region.y < 0.0
        || region.width <= 0.0
        || region.height <= 0.0
        || region.x + region.width > display.width as f64
        || region.y + region.height > display.height as f64
    {
        return Err(CaptureError::CaptureFailed(format!(
            "Capture region is outside display {}",
            display.id
        )));
    }

    let scale = display.scale_factor.max(1.0);
    Ok(PhysicalRegion {
        x: (region.x * scale).round() as u32,
        y: (region.y * scale).round() as u32,
        width: (region.width * scale).ceil() as u32,
        height: (region.height * scale).ceil() as u32,
    })
}

#[derive(Debug, Clone, Copy, Default)]
pub struct XcapBackend;

impl CaptureBackend for XcapBackend {
    fn name(&self) -> &'static str {
        "xcap"
    }

    fn capabilities(&self) -> CaptureCapabilities {
        let restricted_wayland = restricted_wayland_session();
        CaptureCapabilities {
            screen_capture: true,
            region_capture: true,
            window_capture: !restricted_wayland,
            multi_display_capture: true,
            logical_to_physical_scaling: true,
            restricted_wayland,
        }
    }

    fn list_displays(&self) -> CaptureResult<Vec<DisplayInfo>> {
        let monitors = xcap::Monitor::all()
            .map_err(|e| CaptureError::CaptureFailed(format!("Failed to list displays: {e}")))?;

        monitors.into_iter().map(display_from_monitor).collect()
    }

    fn list_windows(&self) -> CaptureResult<Vec<WindowInfo>> {
        if !self.capabilities().window_capture {
            return Err(backend_not_available(
                self.name(),
                CaptureTarget::WindowId(0),
            ));
        }
        list_filtered_windows(&self.list_displays()?)
    }

    fn capture(&self, target: CaptureTarget) -> CaptureResult<CaptureSession> {
        match target {
            CaptureTarget::Primary | CaptureTarget::DisplayId(_) => self.capture_display(target),
            CaptureTarget::AllDisplays => self.capture_all_displays(),
            CaptureTarget::Region { display_id, region } => self.capture_region(display_id, region),
            CaptureTarget::WindowId(window_id) => self.capture_window(window_id),
        }
    }
}

impl XcapBackend {
    fn capture_display(&self, target: CaptureTarget) -> CaptureResult<CaptureSession> {
        if !self.capabilities().screen_capture {
            return Err(backend_not_available(self.name(), target));
        }

        let display = self.resolve_display(target.clone())?;
        let monitor = find_monitor(display.id)?;
        let captured_at = SystemTime::now();
        let rgba = monitor
            .capture_image()
            .map_err(|e| CaptureError::CaptureFailed(format!("Failed to capture display: {e}")))?;
        let image = nib_image_from_rgba(
            rgba,
            ImageSource::ScreenCapture {
                display_id: display.id,
                captured_at,
            },
        )?;

        Ok(CaptureSession::new(
            self.name(),
            target,
            CapturedFrame {
                image,
                display: Some(display),
                window: None,
                logical_region: None,
                physical_region: None,
                captured_at,
            },
        ))
    }

    fn capture_region(&self, display_id: u32, region: Region) -> CaptureResult<CaptureSession> {
        if !self.capabilities().region_capture {
            return Err(backend_not_available(
                self.name(),
                CaptureTarget::Region { display_id, region },
            ));
        }

        let display = self.resolve_display(CaptureTarget::DisplayId(display_id))?;
        let physical_region = logical_to_physical_region(region, &display)?;
        let monitor = find_monitor(display.id)?;
        let full = monitor
            .capture_image()
            .map_err(|e| CaptureError::CaptureFailed(format!("Failed to capture display: {e}")))?;
        validate_physical_region(physical_region, &full, display.id)?;

        let captured_at = SystemTime::now();
        let cropped = imageops::crop_imm(
            &full,
            physical_region.x,
            physical_region.y,
            physical_region.width,
            physical_region.height,
        )
        .to_image();
        let image = nib_image_from_rgba(
            cropped,
            ImageSource::ScreenCapture {
                display_id,
                captured_at,
            },
        )?;

        Ok(CaptureSession::new(
            self.name(),
            CaptureTarget::Region { display_id, region },
            CapturedFrame {
                image,
                display: Some(display),
                window: None,
                logical_region: Some(region),
                physical_region: Some(physical_region),
                captured_at,
            },
        ))
    }

    fn capture_window(&self, window_id: u32) -> CaptureResult<CaptureSession> {
        if !self.capabilities().window_capture {
            return Err(backend_not_available(
                self.name(),
                CaptureTarget::WindowId(window_id),
            ));
        }

        let displays = self.list_displays()?;
        let windows = xcap::Window::all()
            .map_err(|e| CaptureError::CaptureFailed(format!("Failed to list windows: {e}")))?;
        let window = windows
            .into_iter()
            .find(|window| window.id().ok() == Some(window_id))
            .ok_or_else(|| CaptureError::WindowNotFound(window_id.to_string()))?;
        let window_info = window_info_from_xcap(&window, &displays)?;
        let display = window_info
            .display_id
            .and_then(|id| displays.iter().find(|display| display.id == id).cloned());
        let captured_at = SystemTime::now();
        let rgba = window
            .capture_image()
            .map_err(|e| CaptureError::CaptureFailed(format!("Failed to capture window: {e}")))?;
        let image = nib_image_from_rgba(
            rgba,
            ImageSource::WindowCapture {
                window_title: window_info.title.clone(),
                captured_at,
            },
        )?;

        Ok(CaptureSession::new(
            self.name(),
            CaptureTarget::WindowId(window_id),
            CapturedFrame {
                image,
                display,
                window: Some(window_info),
                logical_region: None,
                physical_region: None,
                captured_at,
            },
        ))
    }

    fn capture_all_displays(&self) -> CaptureResult<CaptureSession> {
        if !self.capabilities().multi_display_capture {
            return Err(backend_not_available(
                self.name(),
                CaptureTarget::AllDisplays,
            ));
        }

        let monitors = xcap::Monitor::all()
            .map_err(|e| CaptureError::CaptureFailed(format!("Failed to list displays: {e}")))?;
        if monitors.is_empty() {
            return Err(CaptureError::CaptureFailed("No displays found".to_string()));
        }

        let mut captured = Vec::with_capacity(monitors.len());
        for monitor in monitors {
            let display = display_from_monitor(monitor.clone())?;
            let image = monitor.capture_image().map_err(|e| {
                CaptureError::CaptureFailed(format!("Failed to capture display: {e}"))
            })?;
            captured.push((display, image));
        }

        let min_x = captured.iter().map(|(display, _)| display.x).min().unwrap();
        let min_y = captured.iter().map(|(display, _)| display.y).min().unwrap();
        let max_x = captured
            .iter()
            .map(|(display, _)| display.x + display.width as i32)
            .max()
            .unwrap();
        let max_y = captured
            .iter()
            .map(|(display, _)| display.y + display.height as i32)
            .max()
            .unwrap();
        let scale = captured
            .iter()
            .map(|(display, _)| display.scale_factor)
            .fold(1.0_f64, f64::max);
        let width = ((max_x - min_x) as f64 * scale).ceil() as u32;
        let height = ((max_y - min_y) as f64 * scale).ceil() as u32;
        let mut composite = RgbaImage::new(width, height);

        for (display, image) in &captured {
            let x = ((display.x - min_x) as f64 * scale).round() as i64;
            let y = ((display.y - min_y) as f64 * scale).round() as i64;
            let expected_width = (display.width as f64 * scale).ceil() as u32;
            let expected_height = (display.height as f64 * scale).ceil() as u32;
            if image.width() == expected_width && image.height() == expected_height {
                imageops::overlay(&mut composite, image, x, y);
            } else {
                let resized = imageops::resize(
                    image,
                    expected_width,
                    expected_height,
                    imageops::FilterType::Lanczos3,
                );
                imageops::overlay(&mut composite, &resized, x, y);
            }
        }

        let captured_at = SystemTime::now();
        let image = nib_image_from_rgba(
            composite,
            ImageSource::ScreenCapture {
                display_id: 0,
                captured_at,
            },
        )?;

        Ok(CaptureSession::new(
            self.name(),
            CaptureTarget::AllDisplays,
            CapturedFrame {
                image,
                display: None,
                window: None,
                logical_region: Some(Region::new(
                    min_x as f64,
                    min_y as f64,
                    (max_x - min_x) as f64,
                    (max_y - min_y) as f64,
                )),
                physical_region: Some(PhysicalRegion {
                    x: 0,
                    y: 0,
                    width,
                    height,
                }),
                captured_at,
            },
        ))
    }
}

pub fn default_backend() -> XcapBackend {
    XcapBackend
}

pub(crate) fn nib_image_from_rgba(
    image: RgbaImage,
    source: ImageSource,
) -> CaptureResult<NibImage> {
    let width = image.width();
    let height = image.height();
    let mut png_data = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut png_data);
    image::ImageEncoder::write_image(
        encoder,
        image.as_raw(),
        width,
        height,
        image::ExtendedColorType::Rgba8,
    )
    .map_err(|e| CaptureError::CaptureFailed(format!("Failed to encode PNG: {e}")))?;

    Ok(NibImage::new(png_data, width, height, source))
}

fn display_from_monitor(monitor: xcap::Monitor) -> CaptureResult<DisplayInfo> {
    let id = monitor
        .id()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to read display id: {e}")))?;
    let name = monitor.name().unwrap_or_else(|_| format!("Display {id}"));
    let x = monitor.x().unwrap_or(0);
    let y = monitor.y().unwrap_or(0);
    let width = monitor.width().unwrap_or(0);
    let height = monitor.height().unwrap_or(0);
    let scale_factor = monitor.scale_factor().unwrap_or(1.0).max(1.0) as f64;

    Ok(DisplayInfo {
        id,
        name,
        x,
        y,
        width,
        height,
        scale_factor,
        physical_width: (width as f64 * scale_factor).round() as u32,
        physical_height: (height as f64 * scale_factor).round() as u32,
        is_primary: monitor.is_primary().unwrap_or(false),
    })
}

fn find_monitor(display_id: u32) -> CaptureResult<xcap::Monitor> {
    xcap::Monitor::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to list displays: {e}")))?
        .into_iter()
        .find(|monitor| monitor.id().ok() == Some(display_id))
        .ok_or(CaptureError::DisplayNotFound(display_id))
}

pub(crate) fn list_filtered_windows(displays: &[DisplayInfo]) -> CaptureResult<Vec<WindowInfo>> {
    let windows = xcap::Window::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to list windows: {e}")))?;

    Ok(windows
        .into_iter()
        .filter_map(|window| window_info_from_xcap(&window, displays).ok())
        .filter(should_include_window)
        .collect())
}

fn window_info_from_xcap(
    window: &xcap::Window,
    displays: &[DisplayInfo],
) -> CaptureResult<WindowInfo> {
    let id = window
        .id()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to read window id: {e}")))?;
    let title = window.title().unwrap_or_default();
    let app_name = window.app_name().unwrap_or_default();
    let x = window.x().unwrap_or(0);
    let y = window.y().unwrap_or(0);
    let width = window.width().unwrap_or(0);
    let height = window.height().unwrap_or(0);
    let center_x = x + (width / 2) as i32;
    let center_y = y + (height / 2) as i32;

    Ok(WindowInfo {
        id,
        app_name,
        title,
        x,
        y,
        width,
        height,
        is_minimized: window.is_minimized().unwrap_or(true),
        is_focused: window.is_focused().unwrap_or(false),
        display_id: displays
            .iter()
            .find(|display| {
                center_x >= display.x
                    && center_y >= display.y
                    && center_x < display.x + display.width as i32
                    && center_y < display.y + display.height as i32
            })
            .map(|display| display.id),
    })
}

fn should_include_window(window: &WindowInfo) -> bool {
    if window.is_minimized || (window.title.is_empty() && window.app_name.is_empty()) {
        return false;
    }

    const SYSTEM_APPS: &[&str] = &[
        "Window Server",
        "Control Center",
        "Notification Center",
        "SystemUIServer",
    ];
    if SYSTEM_APPS.iter().any(|app| window.app_name == *app) {
        return false;
    }

    window.width >= 50 && window.height >= 50
}

fn validate_physical_region(
    region: PhysicalRegion,
    image: &RgbaImage,
    display_id: u32,
) -> CaptureResult<()> {
    if region.x + region.width > image.width() || region.y + region.height > image.height() {
        return Err(CaptureError::CaptureFailed(format!(
            "Physical capture region is outside display {display_id}"
        )));
    }
    Ok(())
}

fn restricted_wayland_session() -> bool {
    cfg!(target_os = "linux")
        && std::env::var("XDG_SESSION_TYPE")
            .map(|session_type| session_type.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false)
        && std::env::var_os("WAYLAND_DISPLAY").is_some()
}
