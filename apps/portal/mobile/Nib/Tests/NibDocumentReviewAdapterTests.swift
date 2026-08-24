import Foundation

@main
struct NibDocumentReviewAdapterTests {
    static func main() {
        testToolSurfaceIsExhaustive()
        testStyleAndAnchorsSurviveWireMapping()
        testImmutableDerivativeDestination()
        print("NibDocumentReviewAdapterTests passed")
    }

    private static func testToolSurfaceIsExhaustive() {
        let tools = NativeReviewTool.allCases.map(\.rawValue)
        expectEqual(
            tools,
            ["select", "pan", "rectangle", "arrow", "line", "ellipse", "highlight", "blur", "text", "number", "crop", "path", "image"]
        )
    }

    private static func testStyleAndAnchorsSurviveWireMapping() {
        let style = NativeReviewStyle(
            color: "#FF453A",
            strokeWidth: 9,
            strokeStyle: .dashed,
            fillColor: "#30D158",
            filled: true,
            cornerRadius: 12,
            arrowHead: .both,
            blurIntensity: .high,
            fontSize: 24,
            textAlignment: .center,
            textBackground: "#111111",
            opacity: 0.5
        )
        var annotation = NibReviewAnnotation(
            id: "a1",
            type: "arrow",
            color: "#0A84FF",
            startX: 1,
            startY: 2,
            endX: 3,
            endY: 4
        )

        annotation = NibDocumentReviewAdapter.apply(style: style, to: annotation, pageIndex: 4, timeMs: 1_250)

        expectEqual(annotation.color, "#FF453A")
        expectEqual(annotation.strokeWidth, 9)
        expectEqual(annotation.head, "both")
        expectEqual(annotation.pageIndex, 4)
        expectEqual(annotation.timeMs, 1_250)
    }

    private static func testImmutableDerivativeDestination() {
        let source = URL(fileURLWithPath: "/tmp/source.nib")
        let destination = NibDocumentReviewAdapter.derivativeURL(for: source)
        let collisionSafe = NibDocumentReviewAdapter.availableDerivativeURL(for: source) { path in
            path == "/tmp/source.review.nib" || path == "/tmp/source.review-2.nib"
        }

        expect(destination != source, "derivative URL must not equal source URL")
        expectEqual(destination.deletingPathExtension().lastPathComponent, "source.review")
        expectEqual(collisionSafe.deletingPathExtension().lastPathComponent, "source.review-3")
        do {
            try NibDocumentReviewAdapter.validateDerivativeDestination(source: source, destination: source)
            fail("expected sourceAndDestinationMustDiffer")
        } catch NibDocumentReviewAdapter.SaveError.sourceAndDestinationMustDiffer {
        } catch {
            fail("unexpected error: \(error)")
        }
    }

    private static func expect(_ condition: Bool, _ message: String) {
        if !condition { fail(message) }
    }

    private static func expectEqual<T: Equatable>(_ actual: T, _ expected: T) {
        if actual != expected {
            fail("expected \(expected), got \(actual)")
        }
    }

    private static func fail(_ message: String) -> Never {
        fputs("NibDocumentReviewAdapterTests failed: \(message)\n", stderr)
        exit(1)
    }
}
