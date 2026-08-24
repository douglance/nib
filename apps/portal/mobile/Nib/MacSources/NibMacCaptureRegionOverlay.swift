import AppKit
import CoreGraphics
import Foundation

@MainActor
final class NibMacCrosshairRegionSelector: NibMacRegionSelecting {
    private var activeWindow: NibMacRegionOverlayWindow?
    private var continuation: CheckedContinuation<NibMacCaptureRegionSelection, Error>?

    func selectRegion(displays: [NibMacCaptureDisplay]) async throws -> NibMacCaptureRegionSelection {
        guard !displays.isEmpty else {
            throw NibMacCaptureError.regionOutsideDisplays(.null)
        }
        let frame = displays.map(\.frame).reduce(CGRect.null) { $0.union($1) }

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                let overlay = NibMacRegionOverlayView(frame: CGRect(origin: .zero, size: frame.size))
                let window = NibMacRegionOverlayWindow(contentRect: frame)
                overlay.screenOrigin = frame.origin
                overlay.onComplete = { [weak self] rect in
                    self?.finish(.success(NibMacCaptureRegionSelection(rect: rect)))
                }
                overlay.onCancel = { [weak self] in
                    self?.finish(.failure(CancellationError()))
                }
                window.contentView = overlay
                window.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
                activeWindow = window
            }
        } onCancel: {
            Task { @MainActor in
                finish(.failure(CancellationError()))
            }
        }
    }

    private func finish(_ result: Result<NibMacCaptureRegionSelection, Error>) {
        activeWindow?.orderOut(nil)
        activeWindow = nil
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(with: result)
    }
}

private final class NibMacRegionOverlayWindow: NSWindow {
    init(contentRect: CGRect) {
        super.init(
            contentRect: contentRect,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
        ignoresMouseEvents = false
        level = .screenSaver
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    }

    override var canBecomeKey: Bool { true }
}

private final class NibMacRegionOverlayView: NSView {
    var onComplete: ((CGRect) -> Void)?
    var onCancel: (() -> Void)?
    var screenOrigin: CGPoint = .zero

    private var dragStart: CGPoint?
    private var dragCurrent: CGPoint?

    override var acceptsFirstResponder: Bool { true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window?.makeFirstResponder(self)
        NSCursor.crosshair.set()
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .crosshair)
    }

    override func mouseDown(with event: NSEvent) {
        dragStart = event.locationInWindow
        dragCurrent = dragStart
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        dragCurrent = event.locationInWindow
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        dragCurrent = event.locationInWindow
        guard let rect = selectedRect, rect.width >= 2, rect.height >= 2 else {
            onCancel?()
            return
        }
        onComplete?(rect.offsetBy(dx: screenOrigin.x, dy: screenOrigin.y))
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 {
            onCancel?()
        } else {
            super.keyDown(with: event)
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.22).setFill()
        bounds.fill()

        guard let current = dragCurrent else { return }
        drawCrosshair(at: current)

        guard let rect = selectedRect else { return }
        NSColor.clear.setFill()
        rect.fill(using: .clear)
        NSColor.controlAccentColor.withAlphaComponent(0.25).setFill()
        rect.fill()
        NSColor.white.withAlphaComponent(0.95).setStroke()
        let path = NSBezierPath(rect: rect)
        path.lineWidth = 1
        path.stroke()
    }

    private var selectedRect: CGRect? {
        guard let start = dragStart, let current = dragCurrent else { return nil }
        return CGRect(
            x: min(start.x, current.x),
            y: min(start.y, current.y),
            width: abs(start.x - current.x),
            height: abs(start.y - current.y)
        ).standardized
    }

    private func drawCrosshair(at point: CGPoint) {
        NSColor.white.withAlphaComponent(0.65).setStroke()
        let path = NSBezierPath()
        path.move(to: CGPoint(x: bounds.minX, y: point.y))
        path.line(to: CGPoint(x: bounds.maxX, y: point.y))
        path.move(to: CGPoint(x: point.x, y: bounds.minY))
        path.line(to: CGPoint(x: point.x, y: bounds.maxY))
        path.lineWidth = 1
        path.stroke()
    }
}
