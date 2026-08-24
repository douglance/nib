import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

@available(macOS 14.0, *)
@MainActor
final class NibMacScreenCaptureKitProvider: NibMacCaptureProviding {
    private let currentBundleIdentifier: String?
    private var nativeWindowsByID: [CGWindowID: SCWindow] = [:]
    private var nativeDisplaysByID: [CGDirectDisplayID: SCDisplay] = [:]
    private var ownWindowsByDisplayID: [CGDirectDisplayID: [SCWindow]] = [:]

    init(currentBundleIdentifier: String? = Bundle.main.bundleIdentifier) {
        self.currentBundleIdentifier = currentBundleIdentifier
    }

    func authorizationStatus() -> NibMacCapturePermissionStatus {
        CGPreflightScreenCaptureAccess() ? .authorized : .denied
    }

    func requestAuthorization() async -> NibMacCapturePermissionStatus {
        CGRequestScreenCaptureAccess() ? .authorized : .denied
    }

    func shareableContent() async throws -> NibMacCaptureShareableContent {
        guard authorizationStatus() == .authorized else {
            throw NibMacCaptureError.permissionDenied
        }
        let content = try await SCShareableContent.current
        let windows = content.windows
            .filter(\.isOnScreen)
            .filter { !$0.frame.isEmpty }
        nativeWindowsByID = Dictionary(uniqueKeysWithValues: windows.map { ($0.windowID, $0) })
        nativeDisplaysByID = Dictionary(uniqueKeysWithValues: content.displays.map { ($0.displayID, $0) })
        ownWindowsByDisplayID = Dictionary(grouping: windows.filter(isOwnedByCurrentApp)) { window in
            displayContaining(window.frame, displays: content.displays)?.displayID ?? CGMainDisplayID()
        }

        return NibMacCaptureShareableContent(
            displays: content.displays.map(Self.captureDisplay),
            windows: windows.filter { !isOwnedByCurrentApp($0) }.map(Self.captureWindow)
        )
    }

    func captureImage(for source: NibMacCaptureResolvedSource) async throws -> CGImage {
        guard authorizationStatus() == .authorized else {
            throw NibMacCaptureError.permissionDenied
        }
        switch source {
        case .window(let window):
            let nativeWindow = try await nativeWindow(id: window.id)
            let filter = SCContentFilter(desktopIndependentWindow: nativeWindow)
            return try await captureImage(filter: filter)
        case .display(let display), .region(let display, _):
            let nativeDisplay = try await nativeDisplay(id: display.id)
            let excluded = ownWindowsByDisplayID[display.id] ?? []
            let filter = SCContentFilter(display: nativeDisplay, excludingWindows: excluded)
            return try await captureImage(filter: filter)
        }
    }

    private func nativeWindow(id: CGWindowID) async throws -> SCWindow {
        if let window = nativeWindowsByID[id] {
            return window
        }
        _ = try await shareableContent()
        guard let window = nativeWindowsByID[id] else {
            throw NibMacCaptureError.windowNotFound(id)
        }
        return window
    }

    private func nativeDisplay(id: CGDirectDisplayID) async throws -> SCDisplay {
        if let display = nativeDisplaysByID[id] {
            return display
        }
        _ = try await shareableContent()
        guard let display = nativeDisplaysByID[id] else {
            throw NibMacCaptureError.displayNotFound(id)
        }
        return display
    }

    private func captureImage(filter: SCContentFilter) async throws -> CGImage {
        let configuration = SCStreamConfiguration()
        let scale = max(CGFloat(filter.pointPixelScale), 1)
        let contentRect = filter.contentRect.standardized
        configuration.width = max(1, Int((contentRect.width * scale).rounded(.up)))
        configuration.height = max(1, Int((contentRect.height * scale).rounded(.up)))
        configuration.showsCursor = true
        configuration.capturesAudio = false
        configuration.queueDepth = 1
        configuration.shouldBeOpaque = true
        return try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )
    }

    private func isOwnedByCurrentApp(_ window: SCWindow) -> Bool {
        guard let currentBundleIdentifier else { return false }
        return window.owningApplication?.bundleIdentifier == currentBundleIdentifier
    }

    private func displayContaining(_ rect: CGRect, displays: [SCDisplay]) -> SCDisplay? {
        displays.max { lhs, rhs in
            lhs.frame.intersection(rect).area < rhs.frame.intersection(rect).area
        }
    }

    private static func captureDisplay(_ display: SCDisplay) -> NibMacCaptureDisplay {
        NibMacCaptureDisplay(
            id: display.displayID,
            frame: display.frame,
            pixelSize: CGSize(
                width: CGDisplayPixelsWide(display.displayID),
                height: CGDisplayPixelsHigh(display.displayID)
            ),
            name: display.displayID == CGMainDisplayID()
                ? "Main Display"
                : "Display \(display.displayID)"
        )
    }

    private static func captureWindow(_ window: SCWindow) -> NibMacCaptureWindow {
        NibMacCaptureWindow(
            id: window.windowID,
            frame: window.frame,
            title: window.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
            applicationName: window.owningApplication?.applicationName ?? "Unknown Application",
            bundleIdentifier: window.owningApplication?.bundleIdentifier
        )
    }
}

private extension CGRect {
    var area: CGFloat {
        guard !isNull, !isEmpty else { return 0 }
        return width * height
    }
}
