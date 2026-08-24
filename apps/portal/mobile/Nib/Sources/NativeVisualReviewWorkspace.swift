import AVFoundation
import AVKit
import PhotosUI
import PDFKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

private extension View {
    @ViewBuilder
    func nibGlassSurface(
        tint: Color = Color.white.opacity(0.035),
        cornerRadius: CGFloat,
        interactive: Bool = false,
        reduceTransparency: Bool
    ) -> some View {
        #if os(visionOS)
        self
            .background(
                reduceTransparency ? tint.opacity(0.92) : tint.opacity(0.68),
                in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            )
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(Color.white.opacity(0.18))
            )
        #else
        if #available(iOS 26.0, *), !reduceTransparency {
            if interactive {
                self
                    .background(
                        LinearGradient(
                            colors: [Color.white.opacity(0.32), tint.opacity(0.58), tint.opacity(0.26)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    )
                    .glassEffect(.regular.tint(tint.opacity(0.72)).interactive(), in: .rect(cornerRadius: cornerRadius))
                    .shadow(color: tint.opacity(0.28), radius: 10, y: 4)
                    .shadow(color: .black.opacity(0.30), radius: 12, y: 7)
            } else {
                self
                    .background(
                        LinearGradient(
                            colors: [Color.white.opacity(0.24), tint.opacity(0.34), Color.black.opacity(0.16)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    )
                    .glassEffect(.regular.tint(tint.opacity(0.58)), in: .rect(cornerRadius: cornerRadius))
                    .nibSpecularEdge(cornerRadius: cornerRadius, tint: tint)
            }
        } else {
            self
                .background(
                    reduceTransparency ? tint.opacity(0.92) : tint.opacity(0.68),
                    in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                )
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .stroke(Color.white.opacity(0.18))
                )
        }
        #endif
    }

    func reviewChromeMotion(scaleX: Double, opacity: Double, blur: Double) -> some View {
        self
            .scaleEffect(x: scaleX, y: 1, anchor: .center)
            .opacity(opacity)
            .blur(radius: blur)
    }

    func nibSpecularEdge(cornerRadius: CGFloat, tint: Color) -> some View {
        self
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            colors: [Color.white.opacity(0.88), tint.opacity(0.52), Color.white.opacity(0.18)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 1
                    )
            )
            .overlay(alignment: .top) {
                Capsule()
                    .fill(Color.white.opacity(0.22))
                    .frame(height: 2)
                    .padding(.horizontal, cornerRadius)
                    .padding(.top, 1)
            }
            .shadow(color: tint.opacity(0.34), radius: 11, y: 3)
            .shadow(color: .black.opacity(0.34), radius: 12, y: 7)
    }
}

// Mirrors design/motion.json for the native renderer.
private enum NibReviewMotion {
    enum Mode: String { case full, reduced, off }

    static let enterStartScale = 1.06
    static let enterSettleScale = 0.987
    static let enterStartOpacity = 0.05
    static let blurRadius = 8.0
    static let materializeSeconds = 0.14
    static let settleSeconds = 0.14
    static let exitSeconds = 0.12
    static let reducedSeconds = 0.10

    static func mode(reduceMotion: Bool) -> Mode {
        if let override = UserDefaults.standard.string(forKey: "nib.motion"),
           let mode = Mode(rawValue: override) {
            return mode
        }
        return reduceMotion ? .reduced : .full
    }
}

struct NativeVisualReviewWorkspace: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var request: NibRequest
    var imageURL: URL?
    var videoURL: URL? = nil
    var pdfURL: URL? = nil
    var nibURL: URL? = nil
    var sending: Bool
    var uploadReply: (Data, String) async throws -> Void
    var submit: (String, String?, [NibReviewAnnotation]) async -> Void

    @State private var image: UIImage?
    @State private var videoFrame: UIImage?
    @State private var pdfDocument: PDFDocument?
    @State private var pdfPageImage: UIImage?
    @State private var pdfPageIndex = 0
    @State private var pdfSearchText = ""
    @State private var pdfSearchStatus: String?
    @State private var player: AVPlayer?
    @State private var currentTimeMs = 0.0
    @State private var durationMs = 0.0
    @State private var isPlaying = false
    @State private var replyVideo: PhotosPickerItem?
    @State private var replyStatus: String?
    @State private var derivativeStatus: String?
    @State private var loadError: String?
    @State private var tool: NativeReviewTool = .select
    @State private var reviewState = NativeReviewDocumentState()
    @State private var zoom = 1.0
    @State private var panOffset: CGSize = .zero
    @State private var comment = ""
    @State private var showingExpandedImage = false
    @State private var showingTextPrompt = false
    @State private var textAnnotation = ""
    @State private var textPoint: CGPoint?
    @State private var chromeScaleX = NibReviewMotion.enterStartScale
    @State private var chromeOpacity = NibReviewMotion.enterStartOpacity
    @State private var chromeBlur = NibReviewMotion.blurRadius

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

            Group {
                if let player, videoURL != nil, isPlaying {
                    VideoPlayer(player: player)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .accessibilityLabel(request.title)
                } else {
                    NativeReviewCanvas(
                        image: displayImage,
                        loadError: loadError,
                        tool: tool,
                        style: reviewState.style,
                        zoom: zoom,
                        panOffset: $panOffset,
                        annotations: visibleAnnotations,
                        redoAnnotations: visibleRedoAnnotations,
                        requestText: { point in
                            pauseVideo()
                            textPoint = point
                            textAnnotation = ""
                            showingTextPrompt = true
                        },
                        expand: { showingExpandedImage = true }
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .layoutPriority(1)
            .padding(.horizontal, 18)
            .padding(.top, 14)

            if videoURL != nil {
                videoControls
                    .padding(.horizontal, 18)
                    .padding(.top, 10)
            }


            if pdfURL != nil {
                pdfControls
                    .padding(.horizontal, 18)
                    .padding(.top, 10)
            }

            annotationToolbar
                .padding(.horizontal, 18)
                .padding(.top, 14)
                .reviewChromeMotion(scaleX: chromeScaleX, opacity: chromeOpacity, blur: chromeBlur)

            if let derivativeStatus {
                Text(derivativeStatus)
                    .font(.caption)
                    .foregroundStyle(Color.white.opacity(0.72))
                    .padding(.horizontal, 18)
                    .padding(.top, 6)
            }

            replyMediaControl
                .padding(.horizontal, 18)
                .padding(.top, 12)

            commentField
                .padding(.horizontal, 18)
                .padding(.top, 12)
                .reviewChromeMotion(scaleX: chromeScaleX, opacity: chromeOpacity, blur: chromeBlur)

            decisionDock
                .padding(.horizontal, 18)
                .padding(.top, 12)
                .padding(.bottom, 12)
                .reviewChromeMotion(scaleX: chromeScaleX, opacity: chromeOpacity, blur: chromeBlur)
        }
        .background(NibTheme.background.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .statusBarHidden(false)
        .preferredColorScheme(.dark)
        .task(id: imageURL) { await loadImage() }
        .task(id: videoURL) { await loadVideo() }
        .task(id: pdfURL) { await loadPDF() }
        .task(id: replyVideo) { await uploadSelectedReply() }
        .task(id: isPlaying) {
            while isPlaying, let player {
                currentTimeMs = max(0, CMTimeGetSeconds(player.currentTime()) * 1_000)
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
        .task { await materializeChrome() }
        .fullScreenCover(isPresented: $showingExpandedImage) {
            ExpandedReviewImage(image: displayImage, annotations: visibleAnnotations.wrappedValue)
        }
        .alert("Add text annotation", isPresented: $showingTextPrompt) {
            TextField("Annotation", text: $textAnnotation)
            Button("Cancel", role: .cancel) {}
            Button("Add") { addTextAnnotation() }
                .disabled(textAnnotation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    @MainActor
    private func materializeChrome() async {
        switch NibReviewMotion.mode(reduceMotion: reduceMotion) {
        case .off:
            chromeScaleX = 1
            chromeOpacity = 1
            chromeBlur = 0
        case .reduced:
            chromeScaleX = 1
            chromeBlur = 0
            chromeOpacity = 0
            withAnimation(.easeOut(duration: NibReviewMotion.reducedSeconds)) { chromeOpacity = 1 }
        case .full:
            chromeScaleX = NibReviewMotion.enterStartScale
            chromeOpacity = NibReviewMotion.enterStartOpacity
            chromeBlur = NibReviewMotion.blurRadius
            withAnimation(.easeInOut(duration: NibReviewMotion.materializeSeconds)) {
                chromeScaleX = NibReviewMotion.enterSettleScale
                chromeOpacity = 1
                chromeBlur = 0
            }
            try? await Task.sleep(for: .milliseconds(140))
            withAnimation(.easeInOut(duration: NibReviewMotion.settleSeconds)) { chromeScaleX = 1 }
        }
    }

    @MainActor
    private func submitAfterDissolve(_ decision: String) async {
        let mode = NibReviewMotion.mode(reduceMotion: reduceMotion)
        switch mode {
        case .off:
            chromeOpacity = 0
        case .reduced:
            withAnimation(.easeIn(duration: NibReviewMotion.reducedSeconds)) { chromeOpacity = 0 }
            try? await Task.sleep(for: .milliseconds(100))
        case .full:
            withAnimation(.easeIn(duration: NibReviewMotion.exitSeconds)) {
                chromeScaleX = 1.06
                chromeOpacity = 0
                chromeBlur = NibReviewMotion.blurRadius
            }
            try? await Task.sleep(for: .milliseconds(120))
        }
        await submit(decision, normalizedComment, reviewState.annotations)
        chromeScaleX = 1
        chromeOpacity = 1
        chromeBlur = 0
    }

    private var visibleAnnotations: Binding<[NibReviewAnnotation]> {
        Binding(
            get: {
                NibDocumentReviewAdapter.visibleAnnotations(
                    in: reviewState,
                    pageIndex: pdfURL == nil ? nil : pdfPageIndex,
                    timeMs: videoURL == nil ? nil : currentTimeMs
                )
            },
            set: { updated in
                if videoURL != nil {
                    reviewState.annotations.removeAll { annotation in
                        guard let timeMs = annotation.timeMs else { return false }
                        return abs(timeMs - currentTimeMs) <= 75
                    }
                    reviewState.annotations.append(contentsOf: updated.map { annotation in
                        var anchored = annotation
                        anchored.timeMs = currentTimeMs
                        return anchored
                    })
                    return
                }
                if pdfURL != nil {
                    reviewState.annotations.removeAll { $0.pageIndex == pdfPageIndex }
                    reviewState.annotations.append(contentsOf: updated.map { annotation in
                        var anchored = annotation
                        anchored.pageIndex = pdfPageIndex
                        return anchored
                    })
                    return
                }
                reviewState.annotations = updated
            }
        )
    }

    private var visibleRedoAnnotations: Binding<[NibReviewAnnotation]> {
        Binding(
            get: { reviewState.redoAnnotations },
            set: { updated in
                reviewState.redoAnnotations = updated.map { annotation in
                    var anchored = annotation
                    if videoURL != nil { anchored.timeMs = currentTimeMs }
                    if pdfURL != nil { anchored.pageIndex = pdfPageIndex }
                    return anchored
                }
            }
        )
    }

    private var videoControls: some View {
        HStack(spacing: 10) {
            Button {
                toggleVideoPlayback()
            } label: {
                Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isPlaying ? "Pause video" : "Play video")

            Text(videoTime(currentTimeMs))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)

            Slider(
                value: Binding(
                    get: { currentTimeMs },
                    set: { currentTimeMs = $0 }
                ),
                in: 0...max(1, durationMs),
                onEditingChanged: { editing in
                    if editing { pauseVideo() }
                    else { seekVideo(to: currentTimeMs) }
                }
            )
            .accessibilityLabel("Video position")

            Text(videoTime(durationMs))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .nibGlassSurface(tint: Color.white.opacity(0.20), cornerRadius: 12, reduceTransparency: reduceTransparency)
    }

    private var displayImage: UIImage? {
        if pdfURL != nil { return pdfPageImage }
        return videoURL == nil ? image : videoFrame ?? image
    }

    private var pdfControls: some View {
        HStack(spacing: 10) {
            Button {
                showPDFPage(pdfPageIndex - 1)
            } label: {
                Image(systemName: "chevron.left").frame(width: 34, height: 34)
            }
            .buttonStyle(.plain)
            .disabled(pdfPageIndex == 0)
            .accessibilityLabel("Previous PDF page")

            Text("Page \(pdfPageIndex + 1) of \(pdfDocument?.pageCount ?? 0)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)

            Button {
                showPDFPage(pdfPageIndex + 1)
            } label: {
                Image(systemName: "chevron.right").frame(width: 34, height: 34)
            }
            .buttonStyle(.plain)
            .disabled(pdfPageIndex + 1 >= (pdfDocument?.pageCount ?? 0))
            .accessibilityLabel("Next PDF page")

            TextField("Find text", text: $pdfSearchText)
                .textFieldStyle(.plain)
                .submitLabel(.search)
                .onSubmit { findPDFText() }
                .accessibilityLabel("Find text in PDF")

            Button("Find") { findPDFText() }
                .buttonStyle(.plain)
                .disabled(pdfSearchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            if let pdfSearchStatus {
                Text(pdfSearchStatus).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .nibGlassSurface(tint: Color.white.opacity(0.20), cornerRadius: 12, reduceTransparency: reduceTransparency)
    }

    @MainActor
    private func loadPDF() async {
        pdfDocument = nil
        pdfPageImage = nil
        pdfPageIndex = 0
        pdfSearchStatus = nil
        guard let pdfURL else { return }
        do {
            let (data, response) = try await URLSession.shared.data(from: pdfURL)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  let document = PDFDocument(data: data),
                  document.pageCount > 0
            else {
                throw NSError(domain: "Nib", code: 3, userInfo: [NSLocalizedDescriptionKey: "PDF preview unavailable"])
            }
            pdfDocument = document
            showPDFPage(0)
        } catch {
            loadError = error.localizedDescription
        }
    }

    @MainActor
    private func showPDFPage(_ requestedIndex: Int) {
        guard let pdfDocument, pdfDocument.pageCount > 0 else { return }
        let index = min(max(0, requestedIndex), pdfDocument.pageCount - 1)
        guard let page = pdfDocument.page(at: index) else { return }
        pdfPageIndex = index
        pdfPageImage = page.thumbnail(of: CGSize(width: 2_048, height: 2_048), for: .cropBox)
        zoom = 1
        panOffset = .zero
    }

    @MainActor
    private func findPDFText() {
        let query = pdfSearchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let pdfDocument, !query.isEmpty else { return }
        let selections = pdfDocument.findString(query, withOptions: [.caseInsensitive])
        guard !selections.isEmpty else {
            pdfSearchStatus = "No matches"
            return
        }
        let next = selections.first { selection in
            guard let page = selection.pages.first else { return false }
            return pdfDocument.index(for: page) > pdfPageIndex
        } ?? selections[0]
        if let page = next.pages.first {
            showPDFPage(pdfDocument.index(for: page))
        }
        pdfSearchStatus = "\(selections.count) match\(selections.count == 1 ? "" : "es")"
    }

    @MainActor
    private func loadVideo() async {
        player?.pause()
        player = nil
        currentTimeMs = 0
        durationMs = 0
        isPlaying = false
        videoFrame = nil
        guard let videoURL else { return }
        let asset = AVURLAsset(url: videoURL)
        do {
            let duration = try await asset.load(.duration)
            durationMs = max(0, CMTimeGetSeconds(duration) * 1_000)
            player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
            await renderVideoFrame(at: 0)
        } catch {
            loadError = error.localizedDescription
        }
    }

    @MainActor
    private func toggleVideoPlayback() {
        guard let player else { return }
        if isPlaying {
            pauseVideo()
        } else {
            player.play()
            isPlaying = true
        }
    }

    @MainActor
    private func pauseVideo() {
        guard videoURL != nil else { return }
        player?.pause()
        isPlaying = false
        currentTimeMs = max(0, CMTimeGetSeconds(player?.currentTime() ?? .zero) * 1_000)
        Task { await renderVideoFrame(at: currentTimeMs) }
    }

    @MainActor
    private func seekVideo(to timeMs: Double) {
        guard let player else { return }
        pauseVideo()
        let clamped = min(max(0, timeMs), max(0, durationMs))
        currentTimeMs = clamped
        player.seek(to: CMTime(seconds: clamped / 1_000, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        Task { await renderVideoFrame(at: clamped) }
    }

    @MainActor
    private func renderVideoFrame(at timeMs: Double) async {
        guard let videoURL else { return }
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: videoURL))
        generator.appliesPreferredTrackTransform = true
        do {
            let (image, _) = try await generator.image(at: CMTime(seconds: timeMs / 1_000, preferredTimescale: 600))
            videoFrame = UIImage(cgImage: image)
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func videoTime(_ milliseconds: Double) -> String {
        let seconds = max(0, Int(milliseconds / 1_000))
        return "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
    }

    private var requestContent: AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: request.prompt, options: options)) ?? AttributedString(request.prompt)
    }

    private var annotationToolbar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach([NativeReviewTool.select]) { item in
                    ReviewToolButton(tool: item, selected: tool == item) {
                        pauseVideo()
                        tool = item
                    }
                }

                panArrowMenu

                ForEach([NativeReviewTool.rectangle, .line, .ellipse, .highlight, .blur, .text, .number, .crop, .path, .image]) { item in
                    ReviewToolButton(tool: item, selected: tool == item) {
                        pauseVideo()
                        tool = item
                    }
                }

                toolbarDivider

                toolbarButton("Create New Nib", systemImage: "doc.badge.plus", disabled: nibURL == nil) {
                    Task { await createNewNib() }
                }

                toolbarButton("Undo", systemImage: "arrow.uturn.backward", disabled: reviewState.annotations.isEmpty) {
                    undo()
                }
                toolbarButton("Redo", systemImage: "arrow.uturn.forward", disabled: reviewState.redoAnnotations.isEmpty) {
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

                Menu {
                    Picker("Width", selection: $reviewState.style.strokeWidth) {
                        Text("Thin").tag(2.0)
                        Text("Medium").tag(4.0)
                        Text("Heavy").tag(8.0)
                        Text("Bold").tag(12.0)
                    }
                    Picker("Line Style", selection: $reviewState.style.strokeStyle) {
                        ForEach(NativeReviewStrokeStyle.allCases, id: \.self) { style in
                            Text(style.rawValue.capitalized).tag(style)
                        }
                    }
                    Toggle("Fill", isOn: $reviewState.style.filled)
                    Picker("Arrow Head", selection: $reviewState.style.arrowHead) {
                        ForEach(NativeReviewArrowHead.allCases, id: \.self) { head in
                            Text(head.rawValue.capitalized).tag(head)
                        }
                    }
                    Picker("Blur", selection: $reviewState.style.blurIntensity) {
                        ForEach(NativeReviewBlurIntensity.allCases, id: \.self) { intensity in
                            Text(intensity.rawValue.capitalized).tag(intensity)
                        }
                    }
                    Picker("Text Align", selection: $reviewState.style.textAlignment) {
                        ForEach(NativeReviewTextAlignment.allCases, id: \.self) { align in
                            Text(align.rawValue.capitalized).tag(align)
                        }
                    }
                    Stepper("Corner \(Int(reviewState.style.cornerRadius))", value: $reviewState.style.cornerRadius, in: 0...48, step: 2)
                    Stepper("Font \(Int(reviewState.style.fontSize))", value: $reviewState.style.fontSize, in: 10...96, step: 2)
                } label: {
                    Image(systemName: "slider.horizontal.3")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(Color.white.opacity(0.92))
                        .frame(width: 34, height: 34)
                }
                .accessibilityLabel("Style controls")

                layerMenu
            }
            .padding(5)
        }
        .nibGlassSurface(tint: Color.white.opacity(0.20), cornerRadius: 13, reduceTransparency: reduceTransparency)
    }

    private var layerMenu: some View {
        Menu {
            if reviewState.annotations.isEmpty {
                Text("No layers")
            } else {
                ForEach(reviewState.annotations.reversed()) { annotation in
                    let layer = reviewState.layers[annotation.id, default: NativeReviewLayerState()]
                    Button {
                        reviewState.selectedIDs = [annotation.id]
                    } label: {
                        Label(annotation.type.capitalized, systemImage: reviewState.selectedIDs.contains(annotation.id) ? "checkmark.circle.fill" : "circle")
                    }
                    Button {
                        reviewState.layers[annotation.id, default: NativeReviewLayerState()].visible.toggle()
                    } label: {
                        Label(layer.visible ? "Hide \(annotation.type)" : "Show \(annotation.type)", systemImage: layer.visible ? "eye.slash" : "eye")
                    }
                    Button {
                        reviewState.layers[annotation.id, default: NativeReviewLayerState()].locked.toggle()
                    } label: {
                        Label(layer.locked ? "Unlock \(annotation.type)" : "Lock \(annotation.type)", systemImage: layer.locked ? "lock.open" : "lock")
                    }
                }
                Divider()
                Button("Group Selected") {
                    let groupID = UUID().uuidString
                    for id in reviewState.selectedIDs {
                        reviewState.layers[id, default: NativeReviewLayerState()].groupID = groupID
                    }
                }
                Button("Ungroup Selected") {
                    for id in reviewState.selectedIDs {
                        reviewState.layers[id, default: NativeReviewLayerState()].groupID = nil
                    }
                }
                Button("Delete Selected", role: .destructive) {
                    NibDocumentReviewAdapter.deleteSelected(in: &reviewState)
                }
                .disabled(reviewState.selectedIDs.isEmpty)
            }
        } label: {
            Image(systemName: "square.3.layers.3d")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Color.white.opacity(0.92))
                .frame(width: 34, height: 34)
        }
        .accessibilityLabel("Layers")
    }

    private var toolbarDivider: some View {
        Rectangle()
            .fill(Color.white.opacity(0.18))
            .frame(width: 1, height: 25)
    }

    private var panArrowMenu: some View {
        Menu {
            Button {
                pauseVideo()
                tool = .pan
            } label: {
                Label("Pan", systemImage: NativeReviewTool.pan.systemImage)
            }
            Button {
                pauseVideo()
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

    @ViewBuilder
    private var decisionDock: some View {
        #if os(visionOS)
        decisionDockContent
        #else
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: 9) { decisionDockContent }
        } else {
            decisionDockContent
        }
        #endif
    }

    private var decisionDockContent: some View {
        HStack(spacing: 9) {
            decisionButton("Approve", color: NibTheme.green) {
                await submitAfterDissolve("approve")
            }
            decisionButton("Reject", color: NibTheme.red) {
                await submitAfterDissolve("reject")
            }
            decisionButton("Comment", color: Color(red: 0.290, green: 0.290, blue: 0.290), disabled: normalizedComment == nil && replyStatus != "Reply video attached") {
                await submitAfterDissolve("comment")
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
            .nibGlassSurface(tint: Color.white.opacity(0.20), cornerRadius: 13, reduceTransparency: reduceTransparency)
            .accessibilityLabel("Comment text")
    }

    private var replyMediaControl: some View {
        let replyLabel = replyStatus ?? "Attach MP4 reply"
        return HStack(spacing: 10) {
            PhotosPicker(selection: $replyVideo, matching: .videos) {
                Label(replyLabel, systemImage: "paperclip")
                    .font(.subheadline.weight(.medium))
                    .frame(maxWidth: .infinity)
                    .frame(height: 42)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.white)
            .nibGlassSurface(
                tint: Color.white.opacity(0.20),
                cornerRadius: 12,
                interactive: true,
                reduceTransparency: reduceTransparency
            )
        }
    }

    @MainActor
    private func uploadSelectedReply() async {
        guard let replyVideo else { return }
        guard replyVideo.supportedContentTypes.contains(.mpeg4Movie) else {
            replyStatus = "MP4 required"
            return
        }
        replyStatus = "Uploading..."
        do {
            guard let data = try await replyVideo.loadTransferable(type: Data.self), !data.isEmpty else {
                throw NSError(domain: "Nib", code: 2, userInfo: [NSLocalizedDescriptionKey: "The selected video could not be read"])
            }
            try await uploadReply(data, "reply-\(Int(Date().timeIntervalSince1970)).mp4")
            replyStatus = "Reply video attached"
        } catch {
            replyStatus = error.localizedDescription
        }
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
        .nibGlassSurface(
            tint: color,
            cornerRadius: 14,
            interactive: true,
            reduceTransparency: reduceTransparency
        )
        .disabled(sending || !request.isActive || disabled)
        .accessibilityLabel(label)
    }

    private func undo() {
        NibDocumentReviewAdapter.undo(
            in: &reviewState,
            pageIndex: pdfURL == nil ? nil : pdfPageIndex,
            timeMs: videoURL == nil ? nil : currentTimeMs
        )
    }

    @MainActor
    private func createNewNib() async {
        guard let nibURL else {
            derivativeStatus = "Create New Nib requires an opened .nib file."
            return
        }
        derivativeStatus = "Creating derivative..."
        do {
            let sourceURL = try await materializedNibSource(from: nibURL)
            let destination = try NibDocumentReviewAdapter.exportDerivative(from: sourceURL)
            derivativeStatus = "Created \(destination.lastPathComponent)"
        } catch {
            derivativeStatus = error.localizedDescription
        }
    }

    private func materializedNibSource(from url: URL) async throws -> URL {
        if url.isFileURL { return url }
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), !data.isEmpty else {
            throw NSError(domain: "Nib", code: 4, userInfo: [NSLocalizedDescriptionKey: "Nib file unavailable"])
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("NibDerivatives", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let source = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension("nib")
        try data.write(to: source, options: .atomic)
        return source
    }

    private func redo() {
        NibDocumentReviewAdapter.redo(
            in: &reviewState,
            pageIndex: pdfURL == nil ? nil : pdfPageIndex,
            timeMs: videoURL == nil ? nil : currentTimeMs
        )
    }

    private func cycleColor() {
        let colors = ["#0A84FF", "#FFD60A", "#FF453A", "#30D158"]
        guard let index = colors.firstIndex(of: reviewState.style.color) else {
            reviewState.style.color = colors[0]
            return
        }
        reviewState.style.color = colors[(index + 1) % colors.count]
    }

    private func addTextAnnotation() {
        guard let point = textPoint else { return }
        let content = textAnnotation.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return }
        var annotation = NibReviewAnnotation(
            id: UUID().uuidString,
            type: "text",
            color: reviewState.style.color,
            x: point.x,
            y: point.y,
            content: content,
            fontSize: reviewState.style.fontSize,
            align: reviewState.style.textAlignment.rawValue
        )
        if videoURL != nil { annotation.timeMs = currentTimeMs }
        if pdfURL != nil { annotation.pageIndex = pdfPageIndex }
        NibDocumentReviewAdapter.add(annotation, to: &reviewState)
        textPoint = nil
    }

    private func loadImage() async {
        image = nil
        loadError = nil
        guard let imageURL else {
            if pdfURL == nil && videoURL == nil { loadError = "Preview unavailable" }
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
                    selected ? (tool == .select ? Color.white.opacity(0.14) : NibTheme.blue) : Color.clear,
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
    var style: NativeReviewStyle
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
                guard tool.drawsFromDrag else { return }
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
                if tool == .number,
                   let annotation = NibDocumentReviewAdapter.makeAnnotation(
                    tool: .number,
                    start: end,
                    end: end,
                    points: [],
                    style: style,
                    pageIndex: nil,
                    timeMs: nil,
                    nextNumber: nextNumberValue()
                   ) {
                    annotations.append(annotation)
                    redoAnnotations = []
                    return
                }
                let start = dragStart ?? imagePoint(value.startLocation, canvasSize: canvasSize)
                let distance = hypot(end.x - start.x, end.y - start.y)
                guard distance >= 4 else { return }
                if let annotation = NibDocumentReviewAdapter.makeAnnotation(
                    tool: tool,
                    start: start,
                    end: end,
                    points: dragPoints,
                    style: style,
                    pageIndex: nil,
                    timeMs: nil,
                    nextNumber: nextNumberValue()
                ) {
                    annotations.append(annotation)
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
        if tool == .path, dragPoints.count > 1 {
            return NibDocumentReviewAdapter.apply(
                style: style,
                to: NibReviewAnnotation(
                id: "draft",
                type: "path",
                color: style.color,
                points: dragPoints.map { [$0.x, $0.y] }
                ),
                pageIndex: nil,
                timeMs: nil
            )
        }
        return NibDocumentReviewAdapter.makeAnnotation(
            tool: tool,
            id: "draft",
            start: start,
            end: end,
            points: dragPoints,
            style: style,
            pageIndex: nil,
            timeMs: nil,
            nextNumber: nextNumberValue()
        )
    }

    private func nextNumberValue() -> Int {
        annotations
            .filter { $0.type == "number" }
            .compactMap { $0.content.flatMap(Int.init) }
            .max()
            .map { $0 + 1 } ?? 1
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
                if ["arrow", "line"].contains(annotation.type),
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
                    if annotation.type == "arrow" {
                        drawArrowHead(context: &context, start: start, end: end, color: annotationColor, lineWidth: lineWidth)
                    }
                } else if ["rectangle", "highlight", "blur", "crop", "image"].contains(annotation.type),
                          let x = annotation.x,
                          let y = annotation.y,
                          let width = annotation.width,
                          let height = annotation.height {
                    let rect = CGRect(x: x * scaleX, y: y * scaleY, width: width * scaleX, height: height * scaleY)
                    switch annotation.type {
                    case "highlight":
                        context.fill(Path(roundedRect: rect, cornerRadius: 6), with: .color(annotationColor.opacity(0.28)))
                        context.stroke(Path(roundedRect: rect, cornerRadius: 6), with: .color(annotationColor), lineWidth: max(1, lineWidth * 0.5))
                    case "blur":
                        context.fill(Path(roundedRect: rect, cornerRadius: 6), with: .color(.white.opacity(0.22)))
                        context.stroke(Path(roundedRect: rect, cornerRadius: 6), with: .color(annotationColor.opacity(0.86)), lineWidth: max(1, lineWidth * 0.5))
                        context.draw(Text("Blur").font(.caption.weight(.bold)).foregroundStyle(annotationColor), at: CGPoint(x: rect.midX, y: rect.midY), anchor: .center)
                    case "crop":
                        context.stroke(Path(rect), with: .color(annotationColor), style: StrokeStyle(lineWidth: lineWidth, dash: [10, 6]))
                        drawCropCorners(context: &context, rect: rect, color: annotationColor, lineWidth: lineWidth)
                    case "image":
                        context.fill(Path(roundedRect: rect, cornerRadius: 6), with: .color(.black.opacity(0.28)))
                        context.stroke(Path(roundedRect: rect, cornerRadius: 6), with: .color(annotationColor), lineWidth: lineWidth)
                        context.draw(Image(systemName: "photo"), at: CGPoint(x: rect.midX, y: rect.midY), anchor: .center)
                    default:
                        context.stroke(Path(rect), with: .color(annotationColor), lineWidth: lineWidth)
                    }
                } else if annotation.type == "ellipse",
                          let x = annotation.x,
                          let y = annotation.y,
                          let width = annotation.width,
                          let height = annotation.height {
                    let rect = CGRect(x: x * scaleX, y: y * scaleY, width: width * scaleX, height: height * scaleY)
                    context.stroke(Path(ellipseIn: rect), with: .color(annotationColor), lineWidth: lineWidth)
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
                } else if annotation.type == "number",
                          let x = annotation.x,
                          let y = annotation.y {
                    let value = annotation.content ?? "1"
                    let point = CGPoint(x: x * scaleX, y: y * scaleY)
                    let radius = max(12, (annotation.fontSize ?? 20) * min(scaleX, scaleY) * 0.75)
                    let rect = CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)
                    context.fill(Path(ellipseIn: rect), with: .color(annotationColor))
                    context.stroke(Path(ellipseIn: rect), with: .color(.white), lineWidth: max(1, lineWidth * 0.45))
                    context.draw(
                        Text(value)
                            .font(.system(size: radius, weight: .bold))
                            .foregroundStyle(.white),
                        at: point,
                        anchor: .center
                    )
                }
            }
        }
    }

    private func drawCropCorners(
        context: inout GraphicsContext,
        rect: CGRect,
        color: Color,
        lineWidth: Double
    ) {
        let length = min(rect.width, rect.height, 28)
        var corners = Path()
        corners.move(to: rect.origin)
        corners.addLine(to: CGPoint(x: rect.minX + length, y: rect.minY))
        corners.move(to: rect.origin)
        corners.addLine(to: CGPoint(x: rect.minX, y: rect.minY + length))
        corners.move(to: CGPoint(x: rect.maxX, y: rect.minY))
        corners.addLine(to: CGPoint(x: rect.maxX - length, y: rect.minY))
        corners.move(to: CGPoint(x: rect.maxX, y: rect.minY))
        corners.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + length))
        corners.move(to: CGPoint(x: rect.minX, y: rect.maxY))
        corners.addLine(to: CGPoint(x: rect.minX + length, y: rect.maxY))
        corners.move(to: CGPoint(x: rect.minX, y: rect.maxY))
        corners.addLine(to: CGPoint(x: rect.minX, y: rect.maxY - length))
        corners.move(to: CGPoint(x: rect.maxX, y: rect.maxY))
        corners.addLine(to: CGPoint(x: rect.maxX - length, y: rect.maxY))
        corners.move(to: CGPoint(x: rect.maxX, y: rect.maxY))
        corners.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - length))
        context.stroke(corners, with: .color(color), style: StrokeStyle(lineWidth: lineWidth, lineCap: .square))
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
