import CoreGraphics
import Foundation
import Testing
@testable import Nib

@Suite("Nib Mac capture primitives")
@MainActor
struct NibMacCaptureTests {
    @Test("Region geometry converts screen points to display pixels")
    func regionGeometryConvertsScreenPointsToDisplayPixels() throws {
        let display = NibMacCaptureDisplay(
            id: 1,
            frame: CGRect(x: 0, y: 0, width: 1440, height: 900),
            pixelSize: CGSize(width: 2880, height: 1800),
            name: "Built-in Display"
        )
        let selection = CGRect(x: 100, y: 200, width: 300, height: 150)

        let crop = try NibMacCaptureGeometry.pixelCropRect(for: selection, on: display)

        #expect(crop == CGRect(x: 200, y: 1100, width: 600, height: 300))
    }

    @Test("Artifact store writes stable upload metadata")
    func artifactStoreWritesStableUploadMetadata() async throws {
        let directory = try temporaryDirectory()
        let date = try #require(ISO8601DateFormatter().date(from: "2026-08-12T01:27:24Z"))
        let store = NibMacLocalCaptureArtifactStore(
            directory: directory,
            now: { date },
            id: { "capture-id" }
        )
        let source = NibMacCaptureResolvedSource.window(
            NibMacCaptureWindow(
                id: 42,
                frame: CGRect(x: 10, y: 20, width: 300, height: 200),
                title: "Review Window",
                applicationName: "Preview",
                bundleIdentifier: "com.apple.Preview"
            )
        )

        let artifact = try await store.writePNGArtifact(
            Data([0x89, 0x50, 0x4e, 0x47]),
            pixelSize: CGSize(width: 600, height: 400),
            scale: 2,
            source: source,
            selectedRect: source.frame
        )

        #expect(artifact.fileURL.lastPathComponent == "nib-capture-window-20260812T012724Z-capture-id.png")
        #expect(artifact.metadataURL.lastPathComponent == "nib-capture-window-20260812T012724Z-capture-id.json")
        #expect(artifact.metadata.sourceKind == .window)
        #expect(artifact.metadata.sourceID == "42")
        #expect(artifact.metadata.sourceName == "Review Window")
        #expect(artifact.metadata.contentType == "image/png")
        #expect(artifact.metadata.bytes == 4)
        #expect(artifact.metadata.pixelWidth == 600)
        #expect(artifact.metadata.pixelHeight == 400)
        #expect(artifact.metadata.scale == 2)
        #expect(FileManager.default.fileExists(atPath: artifact.fileURL.path))
        #expect(FileManager.default.fileExists(atPath: artifact.metadataURL.path))
    }

    @Test("Artifact store allocates unique destination paths without overwriting")
    func artifactStoreAllocatesUniqueDestinationPathsWithoutOverwriting() async throws {
        let directory = try temporaryDirectory()
        let date = try #require(ISO8601DateFormatter().date(from: "2026-08-12T01:27:24Z"))
        let store = NibMacLocalCaptureArtifactStore(
            directory: directory,
            now: { date },
            id: { "duplicate" }
        )
        let source = NibMacCaptureResolvedSource.display(
            NibMacCaptureDisplay(
                id: 7,
                frame: CGRect(x: 0, y: 0, width: 100, height: 100),
                pixelSize: CGSize(width: 200, height: 200),
                name: "Display 7"
            )
        )

        let first = try await store.writePNGArtifact(
            Data([1]),
            pixelSize: CGSize(width: 2, height: 2),
            scale: 2,
            source: source,
            selectedRect: source.frame
        )
        let second = try await store.writePNGArtifact(
            Data([2]),
            pixelSize: CGSize(width: 2, height: 2),
            scale: 2,
            source: source,
            selectedRect: source.frame
        )

        #expect(first.fileURL.lastPathComponent == "nib-capture-display-20260812T012724Z-duplicate.png")
        #expect(second.fileURL.lastPathComponent == "nib-capture-display-20260812T012724Z-duplicate-1.png")
        #expect(try Data(contentsOf: first.fileURL) == Data([1]))
        #expect(try Data(contentsOf: second.fileURL) == Data([2]))
    }

    @Test("Capture service captures selected window through provider")
    func captureServiceCapturesSelectedWindowThroughProvider() async throws {
        let directory = try temporaryDirectory()
        let provider = FakeCaptureProvider()
        let window = NibMacCaptureWindow(
            id: 99,
            frame: CGRect(x: 50, y: 60, width: 160, height: 100),
            title: "Invoice",
            applicationName: "Safari",
            bundleIdentifier: "com.apple.Safari"
        )
        provider.content = NibMacCaptureShareableContent(
            displays: [],
            windows: [window]
        )
        provider.image = makeImage(width: 4, height: 2)
        let store = NibMacLocalCaptureArtifactStore(
            directory: directory,
            now: { Date(timeIntervalSince1970: 0) },
            id: { "window-artifact" }
        )
        let service = NibMacCaptureService(provider: provider, artifactStore: store)

        let artifact = try await service.captureWindow(id: 99)

        #expect(provider.capturedSources == [.window(window)])
        #expect(artifact.metadata.sourceKind == .window)
        #expect(artifact.metadata.sourceID == "99")
        #expect(artifact.metadata.sourceName == "Invoice")
        #expect(artifact.metadata.pixelWidth == 4)
        #expect(artifact.metadata.pixelHeight == 2)
    }

    @Test("Capture service crops an interactive region at display scale")
    func captureServiceCropsInteractiveRegionAtDisplayScale() async throws {
        let directory = try temporaryDirectory()
        let provider = FakeCaptureProvider()
        let display = NibMacCaptureDisplay(
            id: 5,
            frame: CGRect(x: 0, y: 0, width: 2, height: 2),
            pixelSize: CGSize(width: 4, height: 4),
            name: "Scaled Display"
        )
        provider.content = NibMacCaptureShareableContent(displays: [display], windows: [])
        provider.image = makeImage(width: 4, height: 4)
        let selector = FakeRegionSelector(
            selection: NibMacCaptureRegionSelection(
                rect: CGRect(x: 0.5, y: 0.5, width: 1, height: 1)
            )
        )
        let store = NibMacLocalCaptureArtifactStore(
            directory: directory,
            now: { Date(timeIntervalSince1970: 0) },
            id: { "region-artifact" }
        )
        let service = NibMacCaptureService(
            provider: provider,
            artifactStore: store,
            regionSelector: selector
        )

        let artifact = try await service.captureInteractiveRegion()

        #expect(provider.capturedSources == [.display(display)])
        #expect(artifact.metadata.sourceKind == .region)
        #expect(artifact.metadata.sourceID == "5")
        #expect(artifact.metadata.pixelWidth == 2)
        #expect(artifact.metadata.pixelHeight == 2)
        #expect(artifact.metadata.screenRect == NibMacCaptureRect(x: 0.5, y: 0.5, width: 1, height: 1))
    }

    @Test("Capture service propagates region cancellation without writing")
    func captureServicePropagatesRegionCancellationWithoutWriting() async throws {
        let directory = try temporaryDirectory()
        let provider = FakeCaptureProvider()
        provider.content = NibMacCaptureShareableContent(
            displays: [
                NibMacCaptureDisplay(
                    id: 5,
                    frame: CGRect(x: 0, y: 0, width: 2, height: 2),
                    pixelSize: CGSize(width: 4, height: 4),
                    name: "Display"
                )
            ],
            windows: []
        )
        let service = NibMacCaptureService(
            provider: provider,
            artifactStore: NibMacLocalCaptureArtifactStore(directory: directory),
            regionSelector: FakeRegionSelector(error: CancellationError())
        )

        await #expect(throws: CancellationError.self) {
            try await service.captureInteractiveRegion()
        }
        let contents = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        #expect(contents.isEmpty)
    }
}

@MainActor
private final class FakeCaptureProvider: NibMacCaptureProviding {
    var content = NibMacCaptureShareableContent(displays: [], windows: [])
    var image = makeImage(width: 1, height: 1)
    var capturedSources: [NibMacCaptureResolvedSource] = []

    func authorizationStatus() -> NibMacCapturePermissionStatus {
        .authorized
    }

    func requestAuthorization() async -> NibMacCapturePermissionStatus {
        .authorized
    }

    func shareableContent() async throws -> NibMacCaptureShareableContent {
        content
    }

    func captureImage(for source: NibMacCaptureResolvedSource) async throws -> CGImage {
        capturedSources.append(source)
        return image
    }
}

@MainActor
private final class FakeRegionSelector: NibMacRegionSelecting {
    var selection: NibMacCaptureRegionSelection?
    var error: Error?

    init(selection: NibMacCaptureRegionSelection? = nil, error: Error? = nil) {
        self.selection = selection
        self.error = error
    }

    func selectRegion(displays: [NibMacCaptureDisplay]) async throws -> NibMacCaptureRegionSelection {
        if let error {
            throw error
        }
        return try #require(selection)
    }
}

private func temporaryDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("nib-mac-capture-tests", isDirectory: true)
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
}

private func makeImage(width: Int, height: Int) -> CGImage {
    let bytes = [UInt8](repeating: 0xff, count: width * height * 4)
    let data = Data(bytes)
    let provider = CGDataProvider(data: data as CFData)!
    return CGImage(
        width: width,
        height: height,
        bitsPerComponent: 8,
        bitsPerPixel: 32,
        bytesPerRow: width * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
        provider: provider,
        decode: nil,
        shouldInterpolate: false,
        intent: .defaultIntent
    )!
}
