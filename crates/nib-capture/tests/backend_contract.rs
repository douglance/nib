use nib_capture::{
    backend_not_available, logical_to_physical_region, CaptureBackend, CaptureCapabilities,
    CaptureSession, CaptureTarget, CapturedFrame, DisplayInfo, PhysicalRegion, WindowInfo,
};
use nib_core::{CaptureError, ImageSource, NibImage, Region};
use std::time::SystemTime;

#[derive(Debug)]
struct UnavailableBackend {
    displays: Vec<DisplayInfo>,
}

impl CaptureBackend for UnavailableBackend {
    fn name(&self) -> &'static str {
        "unavailable"
    }

    fn capabilities(&self) -> CaptureCapabilities {
        CaptureCapabilities {
            screen_capture: false,
            region_capture: false,
            window_capture: false,
            multi_display_capture: false,
            logical_to_physical_scaling: true,
            restricted_wayland: false,
        }
    }

    fn list_displays(&self) -> Result<Vec<DisplayInfo>, CaptureError> {
        Ok(self.displays.clone())
    }

    fn list_windows(&self) -> Result<Vec<WindowInfo>, CaptureError> {
        Ok(Vec::new())
    }

    fn capture(&self, target: CaptureTarget) -> Result<CaptureSession, CaptureError> {
        Err(backend_not_available(self.name(), target))
    }
}

fn display(id: u32, is_primary: bool, scale_factor: f64) -> DisplayInfo {
    DisplayInfo {
        id,
        name: format!("Display {id}"),
        x: 100,
        y: 200,
        width: 500,
        height: 300,
        scale_factor,
        physical_width: (500.0 * scale_factor) as u32,
        physical_height: (300.0 * scale_factor) as u32,
        is_primary,
    }
}

#[test]
fn logical_regions_convert_to_physical_pixels_with_display_scale() {
    let display = display(7, true, 2.0);

    assert_eq!(
        logical_to_physical_region(Region::new(10.25, 12.5, 100.25, 50.5), &display).unwrap(),
        PhysicalRegion {
            x: 21,
            y: 25,
            width: 201,
            height: 101,
        }
    );
}

#[test]
fn logical_to_physical_rejects_regions_outside_the_target_display() {
    let display = display(7, true, 2.0);

    let err = logical_to_physical_region(Region::new(499.0, 0.0, 2.0, 10.0), &display)
        .expect_err("region must stay inside selected display");

    assert!(
        matches!(err, CaptureError::CaptureFailed(message) if message.contains("outside display 7"))
    );
}

#[test]
fn primary_target_errors_without_falling_back_to_first_display() {
    let backend = UnavailableBackend {
        displays: vec![display(10, false, 1.0), display(11, false, 1.0)],
    };

    let err = backend.resolve_display(CaptureTarget::Primary).unwrap_err();

    assert!(matches!(err, CaptureError::DisplayNotFound(0)));
}

#[test]
fn capture_session_exposes_frame_display_and_window_metadata() {
    let display = display(3, true, 1.0);
    let window = WindowInfo {
        id: 42,
        app_name: "App".to_string(),
        title: "Window".to_string(),
        x: 10,
        y: 20,
        width: 200,
        height: 100,
        is_minimized: false,
        is_focused: true,
        display_id: Some(display.id),
    };
    let image = NibImage::new(
        Vec::new(),
        200,
        100,
        ImageSource::WindowCapture {
            window_title: window.title.clone(),
            captured_at: SystemTime::now(),
        },
    );

    let session = CaptureSession::new(
        "test",
        CaptureTarget::WindowId(window.id),
        CapturedFrame {
            image,
            display: Some(display.clone()),
            window: Some(window.clone()),
            logical_region: None,
            physical_region: None,
            captured_at: SystemTime::now(),
        },
    );

    assert_eq!(session.backend, "test");
    assert_eq!(session.frame.display.as_ref().unwrap().id, display.id);
    assert_eq!(session.frame.window.as_ref().unwrap().id, window.id);
    assert_eq!(session.into_image().width, 200);
}
