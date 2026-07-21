//! Native window lifecycle motion.
//!
//! The macOS implementation mirrors Spotlight's width-dominant materialization:
//! a faint, wide window compresses past its resting width, rebounds, then exits
//! by expanding, blurring, and fading. Other platforms retain an immediate exit.

use std::sync::atomic::{AtomicBool, Ordering};

const ENTER_START_WIDTH_SCALE: f64 = 1.06;
const ENTER_COMPRESSED_WIDTH_SCALE: f64 = 0.987;
const EXIT_WIDTH_SCALE: f64 = 1.06;
const ENTER_PHASE_SECONDS: f64 = 0.14;
const EXIT_SECONDS: f64 = 0.12;
const REDUCED_MOTION_SECONDS: f64 = 0.10;
const ENTER_START_ALPHA: f64 = 0.05;
const MORPH_BLUR_RADIUS: f32 = 8.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MotionMode {
    Full,
    Reduced,
    Off,
}

fn configured_motion_mode(system_reduce_motion: bool) -> MotionMode {
    match std::env::var("NIB_MOTION").ok().as_deref() {
        Some("full") => MotionMode::Full,
        Some("reduced") => MotionMode::Reduced,
        Some("off") => MotionMode::Off,
        _ if system_reduce_motion => MotionMode::Reduced,
        _ => MotionMode::Full,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct MotionRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn centered_scaled_rect(rect: MotionRect, width_scale: f64, height_scale: f64) -> MotionRect {
    let width = rect.width * width_scale;
    let height = rect.height * height_scale;
    MotionRect {
        x: rect.x - (width - rect.width) / 2.0,
        y: rect.y - (height - rect.height) / 2.0,
        width,
        height,
    }
}

struct ExitGuard(AtomicBool);

impl ExitGuard {
    const fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    fn try_begin(&self) -> bool {
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
}

static EXIT_GUARD: ExitGuard = ExitGuard::new();

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use block2::RcBlock;
    use objc2::{rc::Retained, runtime::AnyObject, MainThreadMarker};
    use objc2_app_kit::{
        NSAnimatablePropertyContainer, NSAnimationContext, NSApplication, NSWindow, NSWorkspace,
    };
    use objc2_core_image::CIFilter;
    use objc2_foundation::{
        NSArray, NSNumber, NSObjectNSKeyValueCoding, NSPoint, NSRect, NSSize, NSString,
    };
    use objc2_quartz_core::{
        kCAMediaTimingFunctionEaseInEaseOut, CABasicAnimation, CAMediaTiming, CAMediaTimingFunction,
    };
    use std::ptr::NonNull;

    fn motion_rect(rect: NSRect) -> MotionRect {
        MotionRect {
            x: rect.origin.x,
            y: rect.origin.y,
            width: rect.size.width,
            height: rect.size.height,
        }
    }

    fn ns_rect(rect: MotionRect) -> NSRect {
        NSRect::new(
            NSPoint::new(rect.x, rect.y),
            NSSize::new(rect.width, rect.height),
        )
    }

    fn scaled_frame(frame: NSRect, width_scale: f64) -> NSRect {
        ns_rect(centered_scaled_rect(motion_rect(frame), width_scale, 1.0))
    }

    fn ease_in_out() -> Retained<CAMediaTimingFunction> {
        unsafe { CAMediaTimingFunction::functionWithName(kCAMediaTimingFunctionEaseInEaseOut) }
    }

    fn motion_mode() -> MotionMode {
        configured_motion_mode(
            NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceMotion(),
        )
    }

    fn current_window() -> Option<Retained<NSWindow>> {
        let main_thread = MainThreadMarker::new()?;
        NSApplication::sharedApplication(main_thread)
            .windows()
            .iter()
            .next()
    }

    fn animate_to(
        window: &NSWindow,
        target_frame: NSRect,
        target_alpha: f64,
        duration: f64,
        completion: Option<&block2::DynBlock<dyn Fn()>>,
    ) {
        let timing = ease_in_out();
        let changes = RcBlock::new(move |context: NonNull<NSAnimationContext>| {
            let context = unsafe { context.as_ref() };
            context.setDuration(duration);
            context.setTimingFunction(Some(&timing));
            let animator = window.animator();
            animator.setFrame_display(target_frame, true);
            animator.setAlphaValue(target_alpha);
        });
        NSAnimationContext::runAnimationGroup_completionHandler(&changes, completion);
    }

    pub(crate) fn show_with_entry_animation(window: &NSWindow) {
        let resting_frame = window.frame();
        let motion_mode = motion_mode();
        if motion_mode == MotionMode::Off {
            window.orderFrontRegardless();
            window.makeKeyAndOrderFront(None);
            return;
        }
        window.setAlphaValue(if motion_mode == MotionMode::Reduced {
            0.0
        } else {
            ENTER_START_ALPHA
        });

        if motion_mode == MotionMode::Reduced {
            window.orderFrontRegardless();
            window.makeKeyAndOrderFront(None);
            animate_to(window, resting_frame, 1.0, REDUCED_MOTION_SECONDS, None);
            return;
        }

        let start_frame = scaled_frame(resting_frame, ENTER_START_WIDTH_SCALE);
        let compressed_frame = scaled_frame(resting_frame, ENTER_COMPRESSED_WIDTH_SCALE);
        window.setFrame_display(start_frame, false);
        window.orderFrontRegardless();
        window.makeKeyAndOrderFront(None);

        install_blur_animation(
            window,
            "nibEntryBlur",
            MORPH_BLUR_RADIUS,
            0.0,
            ENTER_PHASE_SECONDS,
        );

        let rebound = RcBlock::new(move || {
            if let Some(window) = current_window() {
                clear_window_blur(&window);
                animate_to(&window, resting_frame, 1.0, ENTER_PHASE_SECONDS, None);
            }
        });
        animate_to(
            window,
            compressed_frame,
            1.0,
            ENTER_PHASE_SECONDS,
            Some(&rebound),
        );
    }

    fn install_blur_animation(
        window: &NSWindow,
        filter_key: &str,
        from_radius: f32,
        to_radius: f32,
        duration: f64,
    ) {
        let Some(content_view) = window.contentView() else {
            return;
        };
        content_view.setWantsLayer(true);
        content_view.setLayerUsesCoreImageFilters(true);
        let Some(layer) = content_view.layer() else {
            return;
        };

        let filter_name = NSString::from_str("CIGaussianBlur");
        let Some(filter) = (unsafe { CIFilter::filterWithName(&filter_name) }) else {
            return;
        };
        let animation_name = NSString::from_str(filter_key);
        let input_radius = NSString::from_str("inputRadius");
        let from_radius = NSNumber::new_f32(from_radius);
        let to_radius = NSNumber::new_f32(to_radius);
        unsafe {
            filter.setName(&animation_name);
            filter.setValue_forKey(Some(&from_radius), &input_radius);
        }

        let filter_object: &AnyObject = &filter;
        let filters = NSArray::from_slice(&[filter_object]);
        unsafe {
            layer.setFilters(Some(&filters));
            filter.setValue_forKey(Some(&to_radius), &input_radius);
        }

        let key_path = NSString::from_str(&format!("filters.{filter_key}.inputRadius"));
        let animation = CABasicAnimation::animationWithKeyPath(Some(&key_path));
        animation.setDuration(duration);
        animation.setTimingFunction(Some(&ease_in_out()));
        unsafe {
            animation.setFromValue(Some(&from_radius));
            animation.setToValue(Some(&to_radius));
        }
        layer.addAnimation_forKey(&animation, Some(&animation_name));
    }

    fn clear_window_blur(window: &NSWindow) {
        let Some(content_view) = window.contentView() else {
            return;
        };
        let Some(layer) = content_view.layer() else {
            return;
        };
        unsafe { layer.setFilters(None) };
        content_view.setLayerUsesCoreImageFilters(false);
    }

    pub(crate) fn request_exit() {
        if !EXIT_GUARD.try_begin() {
            return;
        }
        let Some(window) = current_window() else {
            std::process::exit(0);
        };
        let completion = RcBlock::new(|| std::process::exit(0));
        let resting_frame = window.frame();

        let motion_mode = motion_mode();
        if motion_mode == MotionMode::Off {
            std::process::exit(0);
        }
        if motion_mode == MotionMode::Reduced {
            animate_to(
                &window,
                resting_frame,
                0.0,
                REDUCED_MOTION_SECONDS,
                Some(&completion),
            );
            return;
        }

        install_blur_animation(&window, "nibExitBlur", 0.0, MORPH_BLUR_RADIUS, EXIT_SECONDS);
        animate_to(
            &window,
            scaled_frame(resting_frame, EXIT_WIDTH_SCALE),
            0.0,
            EXIT_SECONDS,
            Some(&completion),
        );
    }
}

#[cfg(target_os = "macos")]
pub(crate) use macos::{request_exit, show_with_entry_animation};

#[cfg(not(target_os = "macos"))]
pub(crate) fn request_exit() {
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centered_scaling_preserves_center_and_height() {
        let original = MotionRect {
            x: 100.0,
            y: 200.0,
            width: 1000.0,
            height: 700.0,
        };
        let scaled = centered_scaled_rect(original, ENTER_START_WIDTH_SCALE, 1.0);
        assert_eq!(scaled.width, 1060.0);
        assert_eq!(scaled.height, 700.0);
        assert_eq!(scaled.x, 70.0);
        assert_eq!(scaled.y, 200.0);
        assert_eq!(scaled.x + scaled.width / 2.0, 600.0);
    }

    #[test]
    fn compression_uses_measured_width_undershoot() {
        let original = MotionRect {
            x: 0.0,
            y: 0.0,
            width: 1000.0,
            height: 700.0,
        };
        let compressed = centered_scaled_rect(original, ENTER_COMPRESSED_WIDTH_SCALE, 1.0);
        assert_eq!(compressed.width, 987.0);
        assert_eq!(compressed.x, 6.5);
        assert_eq!(compressed.height, original.height);
    }

    #[test]
    fn exit_guard_only_allows_one_exit_sequence() {
        let guard = ExitGuard::new();
        assert!(guard.try_begin());
        assert!(!guard.try_begin());
    }

    #[test]
    fn native_constants_match_the_canonical_motion_contract() {
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../../../design/motion.json")).unwrap();
        assert_eq!(
            contract["full"]["enter"]["start_width_scale"],
            ENTER_START_WIDTH_SCALE
        );
        assert_eq!(
            contract["full"]["enter"]["settle_width_scale"],
            ENTER_COMPRESSED_WIDTH_SCALE
        );
        assert_eq!(
            contract["full"]["exit"]["end_width_scale"],
            EXIT_WIDTH_SCALE
        );
        assert_eq!(contract["full"]["enter"]["materialize_ms"], 140);
        assert_eq!(contract["full"]["exit"]["duration_ms"], 120);
        assert_eq!(contract["reduced"]["fade_ms"], 100);
    }
}
