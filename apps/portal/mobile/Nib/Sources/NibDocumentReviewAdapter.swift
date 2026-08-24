import Foundation
import CoreGraphics

#if canImport(NibDocument)
import NibDocument
#endif

enum NativeReviewTool: String, Identifiable, CaseIterable {
    case select
    case pan
    case rectangle
    case arrow
    case line
    case ellipse
    case highlight
    case blur
    case text
    case number
    case crop
    case path
    case image

    var id: String { rawValue }

    var label: String {
        switch self {
        case .select: return "Select"
        case .pan: return "Pan"
        case .rectangle: return "Rectangle"
        case .arrow: return "Arrow"
        case .line: return "Line"
        case .ellipse: return "Ellipse"
        case .highlight: return "Highlight"
        case .blur: return "Blur"
        case .text: return "Text"
        case .number: return "Number"
        case .crop: return "Crop"
        case .path: return "Freehand"
        case .image: return "Image"
        }
    }

    var systemImage: String {
        switch self {
        case .select: return "cursorarrow"
        case .pan: return "arrow.up.and.down.and.arrow.left.and.right"
        case .rectangle: return "square"
        case .arrow: return "arrow.up.right"
        case .line: return "line.diagonal"
        case .ellipse: return "circle"
        case .highlight: return "highlighter"
        case .blur: return "drop"
        case .text: return "textformat.size"
        case .number: return "number.circle"
        case .crop: return "crop"
        case .path: return "scribble"
        case .image: return "photo"
        }
    }

    var drawsFromDrag: Bool {
        switch self {
        case .rectangle, .arrow, .line, .ellipse, .highlight, .blur, .crop, .path, .image:
            return true
        case .select, .pan, .text, .number:
            return false
        }
    }
}

enum NativeReviewStrokeStyle: String, CaseIterable {
    case solid
    case dashed
    case dotted
}

enum NativeReviewArrowHead: String, CaseIterable {
    case none
    case start
    case end
    case both
}

enum NativeReviewBlurIntensity: String, CaseIterable {
    case low
    case medium
    case high
}

enum NativeReviewTextAlignment: String, CaseIterable {
    case left
    case center
    case right
}

struct NativeReviewStyle: Equatable {
    var color: String = "#0A84FF"
    var strokeWidth: Double = 4
    var strokeStyle: NativeReviewStrokeStyle = .solid
    var fillColor: String = "#0A84FF"
    var filled: Bool = false
    var cornerRadius: Double = 8
    var arrowHead: NativeReviewArrowHead = .end
    var blurIntensity: NativeReviewBlurIntensity = .medium
    var fontSize: Double = 20
    var textAlignment: NativeReviewTextAlignment = .left
    var textBackground: String = "#000000"
    var opacity: Double = 1
}

struct NativeReviewLayerState: Equatable {
    var visible: Bool = true
    var locked: Bool = false
    var groupID: String?
}

struct NativeReviewDocumentState: Equatable {
    var annotations: [NibReviewAnnotation] = []
    var redoAnnotations: [NibReviewAnnotation] = []
    var selectedIDs: Set<String> = []
    var layers: [String: NativeReviewLayerState] = [:]
    var style = NativeReviewStyle()
    var nextNumber = 1
}

enum NibDocumentReviewAdapter {
    enum SaveError: Error, Equatable {
        case sourceAndDestinationMustDiffer
        case destinationAlreadyExists
    }

    static func apply(
        style: NativeReviewStyle,
        to annotation: NibReviewAnnotation,
        pageIndex: Int?,
        timeMs: Double?
    ) -> NibReviewAnnotation {
        var updated = annotation
        updated.color = style.color
        updated.strokeWidth = style.strokeWidth
        updated.fontSize = style.fontSize
        updated.align = style.textAlignment.rawValue
        updated.head = style.arrowHead.rawValue
        updated.pageIndex = pageIndex
        updated.timeMs = timeMs
        return updated
    }

    static func makeAnnotation(
        tool: NativeReviewTool,
        id: String = UUID().uuidString,
        start: CGPoint,
        end: CGPoint,
        points: [CGPoint],
        style: NativeReviewStyle,
        pageIndex: Int?,
        timeMs: Double?,
        nextNumber: Int
    ) -> NibReviewAnnotation? {
        let x = Double(min(start.x, end.x))
        let y = Double(min(start.y, end.y))
        let width = Double(abs(end.x - start.x))
        let height = Double(abs(end.y - start.y))
        let base: NibReviewAnnotation

        switch tool {
        case .arrow:
            base = NibReviewAnnotation(id: id, type: "arrow", color: style.color, startX: Double(start.x), startY: Double(start.y), endX: Double(end.x), endY: Double(end.y))
        case .line:
            base = NibReviewAnnotation(id: id, type: "line", color: style.color, startX: Double(start.x), startY: Double(start.y), endX: Double(end.x), endY: Double(end.y))
        case .rectangle, .highlight, .blur, .crop, .image:
            base = NibReviewAnnotation(id: id, type: tool.rawValue, color: style.color, x: x, y: y, width: width, height: height)
        case .ellipse:
            base = NibReviewAnnotation(id: id, type: "ellipse", color: style.color, x: x, y: y, width: width, height: height)
        case .path:
            let mapped = (points.count > 1 ? points : [start, end]).map { [Double($0.x), Double($0.y)] }
            base = NibReviewAnnotation(id: id, type: "path", color: style.color, points: mapped)
        case .number:
            base = NibReviewAnnotation(id: id, type: "number", color: style.color, x: Double(end.x), y: Double(end.y), content: String(nextNumber))
        case .text:
            base = NibReviewAnnotation(id: id, type: "text", color: style.color, x: Double(end.x), y: Double(end.y), content: "")
        case .select, .pan:
            return nil
        }

        return apply(style: style, to: base, pageIndex: pageIndex, timeMs: timeMs)
    }

    static func visibleAnnotations(
        in state: NativeReviewDocumentState,
        pageIndex: Int?,
        timeMs: Double?
    ) -> [NibReviewAnnotation] {
        state.annotations.filter { annotation in
            guard state.layers[annotation.id, default: NativeReviewLayerState()].visible else { return false }
            if let timeMs {
                guard let annotationTime = annotation.timeMs else { return false }
                return abs(annotationTime - timeMs) <= 75
            }
            if let pageIndex {
                return annotation.pageIndex == pageIndex
            }
            return true
        }
    }

    static func add(
        _ annotation: NibReviewAnnotation,
        to state: inout NativeReviewDocumentState
    ) {
        state.annotations.append(annotation)
        state.layers[annotation.id] = state.layers[annotation.id] ?? NativeReviewLayerState()
        state.redoAnnotations = []
        if annotation.type == "number" { state.nextNumber += 1 }
    }

    static func deleteSelected(in state: inout NativeReviewDocumentState) {
        guard !state.selectedIDs.isEmpty else { return }
        let unlocked = state.selectedIDs.filter { state.layers[$0, default: NativeReviewLayerState()].locked == false }
        state.redoAnnotations.append(contentsOf: state.annotations.filter { unlocked.contains($0.id) })
        state.annotations.removeAll { unlocked.contains($0.id) }
        for id in unlocked { state.layers[id] = nil }
        state.selectedIDs.subtract(unlocked)
    }

    static func undo(in state: inout NativeReviewDocumentState, pageIndex: Int?, timeMs: Double?) {
        let visible = visibleAnnotations(in: state, pageIndex: pageIndex, timeMs: timeMs)
        guard let last = visible.last,
              let index = state.annotations.lastIndex(where: { $0.id == last.id }) else { return }
        state.redoAnnotations.append(state.annotations.remove(at: index))
        state.selectedIDs.remove(last.id)
    }

    static func redo(in state: inout NativeReviewDocumentState, pageIndex: Int?, timeMs: Double?) {
        guard var last = state.redoAnnotations.popLast() else { return }
        last.pageIndex = pageIndex ?? last.pageIndex
        last.timeMs = timeMs ?? last.timeMs
        state.annotations.append(last)
        state.layers[last.id] = state.layers[last.id] ?? NativeReviewLayerState()
    }

    static func derivativeURL(for sourceURL: URL) -> URL {
        sourceURL
            .deletingPathExtension()
            .deletingLastPathComponent()
            .appendingPathComponent(sourceURL.deletingPathExtension().lastPathComponent + ".review")
            .appendingPathExtension(sourceURL.pathExtension.isEmpty ? "nib" : sourceURL.pathExtension)
    }

    static func availableDerivativeURL(for sourceURL: URL, fileExists: (String) -> Bool = FileManager.default.fileExists(atPath:)) -> URL {
        let directory = sourceURL.deletingLastPathComponent()
        let base = sourceURL.deletingPathExtension().lastPathComponent
        let ext = sourceURL.pathExtension.isEmpty ? "nib" : sourceURL.pathExtension
        var candidate = directory.appendingPathComponent("\(base).review").appendingPathExtension(ext)
        var suffix = 2
        while fileExists(candidate.path) || candidate.standardizedFileURL.path == sourceURL.standardizedFileURL.path {
            candidate = directory.appendingPathComponent("\(base).review-\(suffix)").appendingPathExtension(ext)
            suffix += 1
        }
        return candidate
    }

    static func validateDerivativeDestination(source: URL, destination: URL, fileExists: (String) -> Bool = FileManager.default.fileExists(atPath:)) throws {
        guard source.standardizedFileURL.path != destination.standardizedFileURL.path else {
            throw SaveError.sourceAndDestinationMustDiffer
        }
        if fileExists(destination.path) {
            throw SaveError.destinationAlreadyExists
        }
    }

    #if canImport(NibDocument)
    static func exportDerivative(from sourceURL: URL) throws -> URL {
        let document = try NibDocumentStore.open(at: sourceURL)
        let destination = availableDerivativeURL(for: sourceURL)
        try validateDerivativeDestination(source: sourceURL, destination: destination)
        try NibDocumentStore.export(document, to: destination, derivedFromFileID: document.fileID)
        return destination
    }
    #endif
}
