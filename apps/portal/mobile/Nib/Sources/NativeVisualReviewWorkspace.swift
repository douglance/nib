import SwiftUI
import UIKit

enum NativeReviewTool: String, Identifiable {
    case select
    case pan
    case arrow
    case rectangle
    case text
    case path

    var id: String { rawValue }

    var label: String {
        switch self {
        case .select: return "Select"
        case .pan: return "Pan"
        case .arrow: return "Arrow"
        case .rectangle: return "Rectangle"
        case .text: return "Text"
        case .path: return "Freehand"
        }
    }

    var systemImage: String {
        switch self {
        case .select: return "cursorarrow"
        case .pan: return "arrow.up.and.down.and.arrow.left.and.right"
        case .arrow: return "arrow.up.right"
        case .rectangle: return "square"
        case .text: return "textformat.size"
        case .path: return "scribble"
        }
    }
}

struct NativeVisualReviewWorkspace: View {
    var request: NibRequest
    var imageURL: URL?
    var sending: Bool
    var submit: (String, String?, [NibReviewAnnotation]) async -> Void

    @State private var image: UIImage?
    @State private var loadError: String?
    @State private var tool: NativeReviewTool = .select
    @State private var color = "#0A84FF"
    @State private var annotations: [NibReviewAnnotation] = []
    @State private var redoAnnotations: [NibReviewAnnotation] = []
    @State private var zoom = 1.0
    @State private var panOffset: CGSize = .zero
    @State private var comment = ""
    @State private var showingExpandedImage = false
    @State private var showingTextPrompt = false
    @State private var textAnnotation = ""
    @State private var textPoint: CGPoint?

    var body: some View {
        VStack(spacing: 0) {
            Text(requestContent)
                .font(.title3)
                .lineSpacing(4)
                .foregroundStyle(Color.white.opacity(0.96))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 18)
                .padding(.top, 18)

            NativeReviewCanvas(
                image: image,
                loadError: loadError,
                tool: tool,
                color: color,
                zoom: zoom,
                panOffset: $panOffset,
                annotations: $annotations,
                redoAnnotations: $redoAnnotations,
                requestText: { point in
                    textPoint = point
                    textAnnotation = ""
                    showingTextPrompt = true
                },
                expand: { showingExpandedImage = true }
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .layoutPriority(1)
            .padding(.horizontal, 18)
            .padding(.top, 14)

            annotationToolbar
                .padding(.horizontal, 18)
                .padding(.top, 14)

            commentField
                .padding(.horizontal, 18)
                .padding(.top, 12)

            decisionDock
                .padding(.horizontal, 18)
                .padding(.top, 12)
                .padding(.bottom, 12)
        }
        .background(Color.black.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .statusBarHidden(true)
        .preferredColorScheme(.dark)
        .task(id: imageURL) { await loadImage() }
        .fullScreenCover(isPresented: $showingExpandedImage) {
            ExpandedReviewImage(image: image, annotations: annotations)
        }
        .alert("Add text annotation", isPresented: $showingTextPrompt) {
            TextField("Annotation", text: $textAnnotation)
            Button("Cancel", role: .cancel) {}
            Button("Add") { addTextAnnotation() }
                .disabled(textAnnotation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private var requestContent: AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: request.prompt, options: options)) ?? AttributedString(request.prompt)
    }

    private var annotationToolbar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach([NativeReviewTool.select]) { item in
                    ReviewToolButton(tool: item, selected: tool == item) {
                        tool = item
                    }
                }

                panArrowMenu

                ForEach([NativeReviewTool.rectangle, .text, .path]) { item in
                    ReviewToolButton(tool: item, selected: tool == item) {
                        tool = item
                    }
                }

                toolbarDivider

                toolbarButton("Undo", systemImage: "arrow.uturn.backward", disabled: annotations.isEmpty) {
                    undo()
                }
                toolbarButton("Redo", systemImage: "arrow.uturn.forward", disabled: redoAnnotations.isEmpty) {
                    redo()
                }

                toolbarDivider

                toolbarButton("Zoom", systemImage: "plus.magnifyingglass") {
                    zoom = zoom >= 2 ? 1 : zoom + 0.25
                    if zoom == 1 { panOffset = .zero }
                }

                Button(action: cycleColor) {
                    Circle()
                        .fill(
                            AngularGradient(
                                colors: [.red, .yellow, .green, .cyan, .blue, .purple, .red],
                                center: .center
                            )
                        )
                        .frame(width: 25, height: 25)
                        .overlay(Circle().stroke(Color.black.opacity(0.24)))
                        .frame(width: 34, height: 34)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Annotation color")
            }
            .padding(5)
        }
        .background(Color(white: 0.08), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous).stroke(Color.white.opacity(0.14)))
    }

    private var toolbarDivider: some View {
        Rectangle()
            .fill(Color.white.opacity(0.18))
            .frame(width: 1, height: 25)
    }

    private var panArrowMenu: some View {
        Menu {
            Button {
                tool = .pan
            } label: {
                Label("Pan", systemImage: NativeReviewTool.pan.systemImage)
            }
            Button {
                tool = .arrow
            } label: {
                Label("Arrow", systemImage: NativeReviewTool.arrow.systemImage)
            }
        } label: {
            let item: NativeReviewTool = tool == .arrow ? .arrow : .pan
            Image(systemName: item.systemImage)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Color.white.opacity(0.92))
                .frame(width: 34, height: 34)
                .background(
                    [.pan, .arrow].contains(tool) ? Color.blue : Color.clear,
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                )
        }
        .accessibilityLabel(tool == .arrow ? "Arrow" : "Pan")
    }

    private func toolbarButton(
        _ label: String,
        systemImage: String,
        disabled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(disabled ? Color.white.opacity(0.28) : Color.white.opacity(0.92))
                .frame(width: 34, height: 34)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityLabel(label)
    }

    private var decisionDock: some View {
        HStack(spacing: 9) {
            decisionButton("Approve", color: Color(red: 0.20, green: 0.65, blue: 0.31)) {
                await submit("approve", normalizedComment, annotations)
            }
            decisionButton("Request Changes", color: Color(red: 0.82, green: 0.19, blue: 0.18)) {
                await submit("reject", normalizedComment, annotations)
            }
            decisionButton("Comment", color: Color(white: 0.22), disabled: normalizedComment == nil) {
                await submit("comment", normalizedComment, annotations)
            }
        }
    }

    private var commentField: some View {
        TextField("Write a comment...", text: $comment, axis: .vertical)
            .lineLimit(1...3)
            .font(.body)
            .foregroundStyle(.white)
            .tint(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color(white: 0.08), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous).stroke(Color.white.opacity(0.24)))
            .accessibilityLabel("Comment text")
    }

    private var normalizedComment: String? {
        let value = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    private func decisionButton(
        _ label: String,
        color: Color,
        disabled: Bool = false,
        action: @escaping () async -> Void
    ) -> some View {
        Button {
            Task { await action() }
        } label: {
            Group {
                if sending {
                    ProgressView().tint(.white)
                } else {
                    Text(label)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                        .minimumScaleFactor(0.78)
                        .multilineTextAlignment(.center)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 52)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.white)
        .background(color, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .disabled(sending || !request.isActive || disabled)
        .accessibilityLabel(label)
    }

    private func undo() {
        guard let last = annotations.popLast() else { return }
        redoAnnotations.append(last)
    }

    private func redo() {
        guard let last = redoAnnotations.popLast() else { return }
        annotations.append(last)
    }

    private func cycleColor() {
        let colors = ["#0A84FF", "#FFD60A", "#FF453A", "#30D158"]
        guard let index = colors.firstIndex(of: color) else {
            color = colors[0]
            return
        }
        color = colors[(index + 1) % colors.count]
    }

    private func addTextAnnotation() {
        guard let point = textPoint else { return }
        let content = textAnnotation.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return }
        annotations.append(NibReviewAnnotation(
            id: UUID().uuidString,
            type: "text",
            color: color,
            x: point.x,
            y: point.y,
            content: content,
            fontSize: 20,
            align: "left"
        ))
        redoAnnotations = []
        textPoint = nil
    }

    private func loadImage() async {
        image = nil
        loadError = nil
        guard let imageURL else {
            loadError = "Preview unavailable"
            return
        }
        do {
            let (data, response) = try await URLSession.shared.data(from: imageURL)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  let loaded = UIImage(data: data)
            else {
                throw NSError(domain: "Nib", code: 1, userInfo: [NSLocalizedDescriptionKey: "Preview unavailable"])
            }
            image = loaded
        } catch {
            loadError = error.localizedDescription
        }
    }
}

private struct ExpandedReviewImage: View {
    @Environment(\.dismiss) private var dismiss
    var image: UIImage?
    var annotations: [NibReviewAnnotation]

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()

            GeometryReader { proxy in
                if let image {
                    let fitted = aspectFitSize(image: image.size, container: proxy.size)
                    ZStack {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                        NativeAnnotationOverlay(annotations: annotations, imageSize: image.size)
                            .allowsHitTesting(false)
                    }
                    .frame(width: fitted.width, height: fitted.height)
                    .position(x: proxy.size.width / 2, y: proxy.size.height / 2)
                }
            }
            .padding(12)

            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 42, height: 42)
                    .background(.black.opacity(0.72), in: Circle())
            }
            .buttonStyle(.plain)
            .padding(16)
            .accessibilityLabel("Close expanded image")
        }
        .preferredColorScheme(.dark)
    }

    private func aspectFitSize(image: CGSize, container: CGSize) -> CGSize {
        guard image.width > 0, image.height > 0, container.width > 0, container.height > 0 else { return .zero }
        let scale = min(container.width / image.width, container.height / image.height)
        return CGSize(width: image.width * scale, height: image.height * scale)
    }
}

struct ReviewToolButton: View {
    var tool: NativeReviewTool
    var selected: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if tool == .text {
                    Text("T")
                        .font(.system(size: 19, weight: .medium, design: .serif))
                } else {
                    Image(systemName: tool.systemImage)
                        .font(.system(size: 16, weight: .medium))
                }
            }
                .foregroundStyle(Color.white.opacity(0.92))
                .frame(width: 34, height: 34)
                .background(
                    selected ? (tool == .select ? Color.white.opacity(0.14) : Color.blue) : Color.clear,
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tool.label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct NativeReviewCanvas: View {
    var image: UIImage?
    var loadError: String?
    var tool: NativeReviewTool
    var color: String
    var zoom: Double
    @Binding var panOffset: CGSize
    @Binding var annotations: [NibReviewAnnotation]
    @Binding var redoAnnotations: [NibReviewAnnotation]
    var requestText: (CGPoint) -> Void
    var expand: () -> Void

    @State private var dragStart: CGPoint?
    @State private var dragCurrent: CGPoint?
    @State private var dragPoints: [CGPoint] = []
    @State private var panStart: CGSize?

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                Color.black
                if let image {
                    let fitted = aspectFitSize(image: image.size, container: proxy.size)
                    canvasLayer(image: image, size: fitted)
                        .frame(width: fitted.width, height: fitted.height)
                        .scaleEffect(zoom)
                        .offset(panOffset)

                    Button(action: expand) {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 38, height: 38)
                            .background(.black.opacity(0.72), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .position(
                        x: (proxy.size.width + fitted.width) / 2 - 24,
                        y: (proxy.size.height - fitted.height) / 2 + 24
                    )
                    .accessibilityLabel("Expand image")
                } else if let loadError {
                    ContentUnavailableView(loadError, systemImage: "photo.badge.exclamationmark")
                        .foregroundStyle(.white)
                } else {
                    ProgressView()
                        .tint(.white)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipped()
        }
    }

    private func canvasLayer(image: UIImage, size: CGSize) -> some View {
        let draft = draftAnnotation()
        return ZStack {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .shadow(color: Color.black.opacity(0.42), radius: 20, y: 12)

            NativeAnnotationOverlay(
                annotations: draft.map { annotations + [$0] } ?? annotations,
                imageSize: image.size
            )
            .allowsHitTesting(false)

            Color.clear
                .contentShape(Rectangle())
                .highPriorityGesture(reviewGesture(canvasSize: size))
        }
    }

    private func reviewGesture(canvasSize: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { value in
                if tool == .pan {
                    if panStart == nil { panStart = panOffset }
                    let origin = panStart ?? .zero
                    panOffset = CGSize(
                        width: origin.width + value.translation.width,
                        height: origin.height + value.translation.height
                    )
                    return
                }
                guard [.arrow, .rectangle, .path].contains(tool) else { return }
                let point = imagePoint(value.location, canvasSize: canvasSize)
                if dragStart == nil {
                    dragStart = point
                    dragPoints = [point]
                }
                dragCurrent = point
                if tool == .path { dragPoints.append(point) }
            }
            .onEnded { value in
                defer { resetDraft() }
                if tool == .pan {
                    panStart = nil
                    return
                }
                let end = imagePoint(value.location, canvasSize: canvasSize)
                if tool == .text {
                    requestText(end)
                    return
                }
                let start = dragStart ?? imagePoint(value.startLocation, canvasSize: canvasSize)
                let distance = hypot(end.x - start.x, end.y - start.y)
                guard distance >= 4 else { return }
                if tool == .arrow {
                    annotations.append(NibReviewAnnotation(
                        id: UUID().uuidString,
                        type: "arrow",
                        color: color,
                        startX: start.x,
                        startY: start.y,
                        endX: end.x,
                        endY: end.y,
                        strokeWidth: 12,
                        head: "end"
                    ))
                } else if tool == .rectangle {
                    annotations.append(NibReviewAnnotation(
                        id: UUID().uuidString,
                        type: "rectangle",
                        color: color,
                        x: min(start.x, end.x),
                        y: min(start.y, end.y),
                        width: abs(end.x - start.x),
                        height: abs(end.y - start.y),
                        strokeWidth: 4
                    ))
                } else if tool == .path {
                    let points = dragPoints.count > 1 ? dragPoints : [start, end]
                    annotations.append(NibReviewAnnotation(
                        id: UUID().uuidString,
                        type: "path",
                        color: color,
                        points: points.map { [$0.x, $0.y] },
                        strokeWidth: 4
                    ))
                }
                redoAnnotations = []
            }
    }

    private func imagePoint(_ point: CGPoint, canvasSize: CGSize) -> CGPoint {
        guard let image else { return .zero }
        return CGPoint(
            x: max(0, min(image.size.width, point.x / canvasSize.width * image.size.width)),
            y: max(0, min(image.size.height, point.y / canvasSize.height * image.size.height))
        )
    }

    private func draftAnnotation() -> NibReviewAnnotation? {
        guard let start = dragStart, let end = dragCurrent else { return nil }
        if tool == .arrow {
            return NibReviewAnnotation(
                id: "draft",
                type: "arrow",
                color: color,
                startX: start.x,
                startY: start.y,
                endX: end.x,
                endY: end.y,
                strokeWidth: 12,
                head: "end"
            )
        }
        if tool == .rectangle {
            return NibReviewAnnotation(
                id: "draft",
                type: "rectangle",
                color: color,
                x: min(start.x, end.x),
                y: min(start.y, end.y),
                width: abs(end.x - start.x),
                height: abs(end.y - start.y),
                strokeWidth: 4
            )
        }
        if tool == .path, dragPoints.count > 1 {
            return NibReviewAnnotation(
                id: "draft",
                type: "path",
                color: color,
                points: dragPoints.map { [$0.x, $0.y] },
                strokeWidth: 4
            )
        }
        return nil
    }

    private func resetDraft() {
        dragStart = nil
        dragCurrent = nil
        dragPoints = []
    }

    private func aspectFitSize(image: CGSize, container: CGSize) -> CGSize {
        guard image.width > 0, image.height > 0, container.width > 0, container.height > 0 else { return .zero }
        let scale = min(container.width / image.width, container.height / image.height)
        return CGSize(width: image.width * scale, height: image.height * scale)
    }
}

struct NativeAnnotationOverlay: View {
    var annotations: [NibReviewAnnotation]
    var imageSize: CGSize

    var body: some View {
        Canvas { context, size in
            let scaleX = size.width / max(imageSize.width, 1)
            let scaleY = size.height / max(imageSize.height, 1)
            for annotation in annotations {
                let annotationColor = Color(nibHex: annotation.color)
                let lineWidth = (annotation.strokeWidth ?? 4) * min(scaleX, scaleY)
                if annotation.type == "arrow",
                   let startX = annotation.startX,
                   let startY = annotation.startY,
                   let endX = annotation.endX,
                   let endY = annotation.endY {
                    let start = CGPoint(x: startX * scaleX, y: startY * scaleY)
                    let end = CGPoint(x: endX * scaleX, y: endY * scaleY)
                    var line = Path()
                    line.move(to: start)
                    line.addLine(to: end)
                    context.stroke(line, with: .color(annotationColor), lineWidth: lineWidth)
                    drawArrowHead(context: &context, start: start, end: end, color: annotationColor, lineWidth: lineWidth)
                } else if annotation.type == "rectangle",
                          let x = annotation.x,
                          let y = annotation.y,
                          let width = annotation.width,
                          let height = annotation.height {
                    let rect = CGRect(x: x * scaleX, y: y * scaleY, width: width * scaleX, height: height * scaleY)
                    context.stroke(Path(rect), with: .color(annotationColor), lineWidth: lineWidth)
                } else if annotation.type == "path", let points = annotation.points, points.count > 1 {
                    var path = Path()
                    path.move(to: CGPoint(x: points[0][0] * scaleX, y: points[0][1] * scaleY))
                    for point in points.dropFirst() where point.count >= 2 {
                        path.addLine(to: CGPoint(x: point[0] * scaleX, y: point[1] * scaleY))
                    }
                    context.stroke(path, with: .color(annotationColor), style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
                } else if annotation.type == "text",
                          let x = annotation.x,
                          let y = annotation.y,
                          let content = annotation.content {
                    context.draw(
                        Text(content)
                            .font(.system(size: (annotation.fontSize ?? 20) * min(scaleX, scaleY), weight: .semibold))
                            .foregroundStyle(annotationColor),
                        at: CGPoint(x: x * scaleX, y: y * scaleY),
                        anchor: .topLeading
                    )
                }
            }
        }
    }

    private func drawArrowHead(
        context: inout GraphicsContext,
        start: CGPoint,
        end: CGPoint,
        color: Color,
        lineWidth: Double
    ) {
        let angle = atan2(end.y - start.y, end.x - start.x)
        let length = max(12, lineWidth * 4)
        let spread = Double.pi / 6
        let first = CGPoint(x: end.x - cos(angle - spread) * length, y: end.y - sin(angle - spread) * length)
        let second = CGPoint(x: end.x - cos(angle + spread) * length, y: end.y - sin(angle + spread) * length)
        var head = Path()
        head.move(to: first)
        head.addLine(to: end)
        head.addLine(to: second)
        context.stroke(head, with: .color(color), style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
    }
}

extension Color {
    init(nibHex value: String) {
        let hex = value.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        let number = UInt64(hex, radix: 16) ?? 0x0A84FF
        self.init(
            red: Double((number >> 16) & 0xFF) / 255,
            green: Double((number >> 8) & 0xFF) / 255,
            blue: Double(number & 0xFF) / 255
        )
    }
}
