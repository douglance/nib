import AppKit
import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum NibMacCapturePermissionStatus: String, Codable, Equatable, Sendable {
    case authorized
    case denied
}

enum NibMacCaptureSourceKind: String, Codable, Equatable, Sendable {
    case window
    case display
    case region
}

struct NibMacCaptureRect: Codable, Equatable, Sendable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double

    init(_ rect: CGRect) {
        self.init(
            x: rect.origin.x,
            y: rect.origin.y,
            width: rect.size.width,
            height: rect.size.height
        )
    }

    init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    var cgRect: CGRect {
        CGRect(x: x, y: y, width: width, height: height)
    }
}

struct NibMacCaptureDisplay: Identifiable, Equatable, Sendable {
    var id: CGDirectDisplayID
    var frame: CGRect
    var pixelSize: CGSize
    var name: String

    var scale: CGFloat {
        guard frame.width > 0, frame.height > 0 else { return 1 }
        let widthScale = pixelSize.width / frame.width
        let heightScale = pixelSize.height / frame.height
        return max(widthScale, heightScale, 1)
    }
}

struct NibMacCaptureWindow: Identifiable, Equatable, Sendable {
    var id: CGWindowID
    var frame: CGRect
    var title: String
    var applicationName: String
    var bundleIdentifier: String?
}

struct NibMacCaptureShareableContent: Equatable, Sendable {
    var displays: [NibMacCaptureDisplay]
    var windows: [NibMacCaptureWindow]
}

struct NibMacCaptureRegionSelection: Equatable, Sendable {
    var rect: CGRect
}

enum NibMacCaptureResolvedSource: Equatable, Sendable {
    case window(NibMacCaptureWindow)
    case display(NibMacCaptureDisplay)
    case region(display: NibMacCaptureDisplay, rect: CGRect)

    var kind: NibMacCaptureSourceKind {
        switch self {
        case .window:
            return .window
        case .display:
            return .display
        case .region:
            return .region
        }
    }

    var id: String {
        switch self {
        case .window(let window):
            return String(window.id)
        case .display(let display), .region(let display, _):
            return String(display.id)
        }
    }

    var name: String {
        switch self {
        case .window(let window):
            return window.title.isEmpty ? window.applicationName : window.title
        case .display(let display), .region(let display, _):
            return display.name
        }
    }

    var frame: CGRect {
        switch self {
        case .window(let window):
            return window.frame
        case .display(let display):
            return display.frame
        case .region(_, let rect):
            return rect
        }
    }

    var scale: CGFloat {
        switch self {
        case .window:
            return 1
        case .display(let display), .region(let display, _):
            return display.scale
        }
    }

    var applicationBundleIdentifier: String? {
        guard case .window(let window) = self else { return nil }
        return window.bundleIdentifier
    }
}

struct NibMacCaptureArtifactMetadata: Codable, Equatable, Sendable {
    var schemaVersion: Int
    var id: String
    var sourceKind: NibMacCaptureSourceKind
    var sourceID: String
    var sourceName: String
    var sourceBundleIdentifier: String?
    var contentType: String
    var fileName: String
    var bytes: Int
    var sha256: String
    var createdAt: Date
    var pixelWidth: Int
    var pixelHeight: Int
    var scale: Double
    var screenRect: NibMacCaptureRect
    var metadata: [String: String]
}

struct NibMacCaptureArtifact: Equatable, Sendable {
    var id: String
    var fileURL: URL
    var metadataURL: URL
    var metadata: NibMacCaptureArtifactMetadata
}

enum NibMacCaptureError: LocalizedError, Equatable {
    case permissionDenied
    case windowNotFound(CGWindowID)
    case displayNotFound(CGDirectDisplayID)
    case emptyRegion
    case regionOutsideDisplays(CGRect)
    case imageEncodingFailed
    case cropFailed(CGRect)
    case destinationWouldOverwrite(URL)

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            return "Screen Recording permission is required before Nib can capture the screen."
        case .windowNotFound(let id):
            return "Nib could not find a shareable window with ID \(id)."
        case .displayNotFound(let id):
            return "Nib could not find a shareable display with ID \(id)."
        case .emptyRegion:
            return "Nib needs a non-empty region to capture."
        case .regionOutsideDisplays:
            return "The selected region is outside the available displays."
        case .imageEncodingFailed:
            return "Nib could not encode the captured image as PNG."
        case .cropFailed:
            return "Nib could not crop the selected screen region."
        case .destinationWouldOverwrite(let url):
            return "Nib refused to overwrite an existing capture at \(url.path)."
        }
    }
}

@MainActor
protocol NibMacCaptureProviding: AnyObject {
    func authorizationStatus() -> NibMacCapturePermissionStatus
    func requestAuthorization() async -> NibMacCapturePermissionStatus
    func shareableContent() async throws -> NibMacCaptureShareableContent
    func captureImage(for source: NibMacCaptureResolvedSource) async throws -> CGImage
}

@MainActor
protocol NibMacRegionSelecting: AnyObject {
    func selectRegion(displays: [NibMacCaptureDisplay]) async throws -> NibMacCaptureRegionSelection
}

@MainActor
protocol NibMacCaptureArtifactStoring: AnyObject {
    func writePNGArtifact(
        _ pngData: Data,
        pixelSize: CGSize,
        scale: CGFloat,
        source: NibMacCaptureResolvedSource,
        selectedRect: CGRect
    ) async throws -> NibMacCaptureArtifact
}

@MainActor
final class NibMacCaptureService {
    private let provider: any NibMacCaptureProviding
    private let artifactStore: any NibMacCaptureArtifactStoring
    private let regionSelector: any NibMacRegionSelecting

    init(
        provider: any NibMacCaptureProviding = NibMacScreenCaptureKitProvider(),
        artifactStore: any NibMacCaptureArtifactStoring = NibMacLocalCaptureArtifactStore(),
        regionSelector: any NibMacRegionSelecting = NibMacCrosshairRegionSelector()
    ) {
        self.provider = provider
        self.artifactStore = artifactStore
        self.regionSelector = regionSelector
    }

    func permissionStatus() -> NibMacCapturePermissionStatus {
        provider.authorizationStatus()
    }

    func requestPermission() async -> NibMacCapturePermissionStatus {
        await provider.requestAuthorization()
    }

    func shareableContent() async throws -> NibMacCaptureShareableContent {
        try Task.checkCancellation()
        return try await provider.shareableContent()
    }

    func captureWindow(id: CGWindowID) async throws -> NibMacCaptureArtifact {
        try Task.checkCancellation()
        try ensureAuthorized()
        let content = try await provider.shareableContent()
        guard let window = content.windows.first(where: { $0.id == id }) else {
            throw NibMacCaptureError.windowNotFound(id)
        }
        return try await capture(source: .window(window))
    }

    func captureDisplay(id: CGDirectDisplayID) async throws -> NibMacCaptureArtifact {
        try Task.checkCancellation()
        try ensureAuthorized()
        let content = try await provider.shareableContent()
        guard let display = content.displays.first(where: { $0.id == id }) else {
            throw NibMacCaptureError.displayNotFound(id)
        }
        return try await capture(source: .display(display))
    }

    func captureInteractiveRegion() async throws -> NibMacCaptureArtifact {
        try Task.checkCancellation()
        try ensureAuthorized()
        let content = try await provider.shareableContent()
        let selection = try await regionSelector.selectRegion(displays: content.displays)
        try Task.checkCancellation()
        guard !selection.rect.isNull, !selection.rect.isEmpty else {
            throw NibMacCaptureError.emptyRegion
        }
        guard let display = content.displays.first(where: { $0.frame.intersects(selection.rect) }) else {
            throw NibMacCaptureError.regionOutsideDisplays(selection.rect)
        }

        let displayImage = try await provider.captureImage(for: .display(display))
        let clipped = selection.rect.intersection(display.frame)
        let cropRect = try NibMacCaptureGeometry.pixelCropRect(for: clipped, on: display)
        guard let cropped = displayImage.cropping(to: cropRect.integral) else {
            throw NibMacCaptureError.cropFailed(cropRect)
        }
        let pngData = try NibMacCaptureImageEncoder.pngData(from: cropped)
        return try await artifactStore.writePNGArtifact(
            pngData,
            pixelSize: CGSize(width: cropped.width, height: cropped.height),
            scale: display.scale,
            source: .region(display: display, rect: clipped),
            selectedRect: clipped
        )
    }

    private func capture(source: NibMacCaptureResolvedSource) async throws -> NibMacCaptureArtifact {
        try Task.checkCancellation()
        let image = try await provider.captureImage(for: source)
        try Task.checkCancellation()
        let pngData = try NibMacCaptureImageEncoder.pngData(from: image)
        return try await artifactStore.writePNGArtifact(
            pngData,
            pixelSize: CGSize(width: image.width, height: image.height),
            scale: source.scale,
            source: source,
            selectedRect: source.frame
        )
    }

    private func ensureAuthorized() throws {
        guard provider.authorizationStatus() == .authorized else {
            throw NibMacCaptureError.permissionDenied
        }
    }
}

enum NibMacCaptureGeometry {
    static func pixelCropRect(for rect: CGRect, on display: NibMacCaptureDisplay) throws -> CGRect {
        let clipped = rect.standardized.intersection(display.frame)
        guard !clipped.isNull, clipped.width > 0, clipped.height > 0 else {
            throw NibMacCaptureError.regionOutsideDisplays(rect)
        }
        let scale = display.scale
        return CGRect(
            x: (clipped.minX - display.frame.minX) * scale,
            y: (display.frame.maxY - clipped.maxY) * scale,
            width: clipped.width * scale,
            height: clipped.height * scale
        ).integral
    }
}

enum NibMacCaptureImageEncoder {
    static func pngData(from image: CGImage) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else {
            throw NibMacCaptureError.imageEncodingFailed
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw NibMacCaptureError.imageEncodingFailed
        }
        return data as Data
    }
}

@MainActor
final class NibMacLocalCaptureArtifactStore: NibMacCaptureArtifactStoring {
    private let directory: URL
    private let now: () -> Date
    private let id: () -> String
    private let fileManager: FileManager
    private let encoder: JSONEncoder

    init(
        directory: URL? = nil,
        fileManager: FileManager = .default,
        now: @escaping () -> Date = Date.init,
        id: @escaping () -> String = { UUID().uuidString.lowercased() }
    ) {
        self.directory = directory ?? Self.defaultDirectory()
        self.fileManager = fileManager
        self.now = now
        self.id = id
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        self.encoder = encoder
    }

    func writePNGArtifact(
        _ pngData: Data,
        pixelSize: CGSize,
        scale: CGFloat,
        source: NibMacCaptureResolvedSource,
        selectedRect: CGRect
    ) async throws -> NibMacCaptureArtifact {
        try Task.checkCancellation()
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        let captureID = id()
        let createdAt = now()
        let timestamp = Self.fileTimestamp(createdAt)
        let baseName = Self.sanitizedBaseName(
            "nib-capture-\(source.kind.rawValue)-\(timestamp)-\(captureID)"
        )
        let urls = try allocateUniqueURLs(baseName: baseName)
        let metadata = NibMacCaptureArtifactMetadata(
            schemaVersion: 1,
            id: captureID,
            sourceKind: source.kind,
            sourceID: source.id,
            sourceName: source.name,
            sourceBundleIdentifier: source.applicationBundleIdentifier,
            contentType: "image/png",
            fileName: urls.image.lastPathComponent,
            bytes: pngData.count,
            sha256: Self.sha256Hex(pngData),
            createdAt: createdAt,
            pixelWidth: Int(pixelSize.width.rounded()),
            pixelHeight: Int(pixelSize.height.rounded()),
            scale: Double(scale),
            screenRect: NibMacCaptureRect(selectedRect),
            metadata: [
                "nib.capture.schema": "macos-native-v1",
                "nib.upload.role": "capture"
            ]
        )
        let metadataData = try encoder.encode(metadata)
        try writeWithoutOverwriting(pngData, to: urls.image)
        do {
            try writeWithoutOverwriting(metadataData, to: urls.metadata)
        } catch {
            try? fileManager.removeItem(at: urls.image)
            throw error
        }
        return NibMacCaptureArtifact(
            id: captureID,
            fileURL: urls.image,
            metadataURL: urls.metadata,
            metadata: metadata
        )
    }

    private func allocateUniqueURLs(baseName: String) throws -> (image: URL, metadata: URL) {
        for suffix in 0..<10_000 {
            let candidate = suffix == 0 ? baseName : "\(baseName)-\(suffix)"
            let imageURL = directory.appendingPathComponent(candidate).appendingPathExtension("png")
            let metadataURL = directory.appendingPathComponent(candidate).appendingPathExtension("json")
            if !fileManager.fileExists(atPath: imageURL.path),
               !fileManager.fileExists(atPath: metadataURL.path) {
                return (imageURL, metadataURL)
            }
        }
        throw NibMacCaptureError.destinationWouldOverwrite(
            directory.appendingPathComponent(baseName).appendingPathExtension("png")
        )
    }

    private func writeWithoutOverwriting(_ data: Data, to url: URL) throws {
        if fileManager.fileExists(atPath: url.path) {
            throw NibMacCaptureError.destinationWouldOverwrite(url)
        }
        try data.write(to: url, options: .withoutOverwriting)
    }

    private static func defaultDirectory() -> URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Nib", isDirectory: true)
            .appendingPathComponent("Captures", isDirectory: true)
    }

    private static func fileTimestamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        return formatter.string(from: date)
    }

    private static func sanitizedBaseName(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        return value.unicodeScalars
            .map { allowed.contains($0) ? Character($0) : "-" }
            .reduce(into: "") { $0.append($1) }
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    private static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
