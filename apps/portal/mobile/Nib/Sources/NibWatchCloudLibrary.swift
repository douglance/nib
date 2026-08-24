import Foundation
import NibCloud
import NibDomain
import SwiftUI

@MainActor
final class NibWatchCloudLibrary: ObservableObject {
    @Published private(set) var files: [NibCloudFile] = []
    @Published private(set) var isLoading = false
    @Published private(set) var message: String?
    @Published private(set) var downloadedFileID: String?

    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    var hasFiles: Bool {
        !files.isEmpty
    }

    func refresh(baseURL: URL) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let client = NibCloudClient(
                baseURL: baseURL,
                bearerToken: NibCredentialStore.token(for: baseURL),
                transport: NibURLSessionTransport(session: session)
            )
            files = try await client.library()
                .filter(Self.isNibFile)
                .sorted { lhs, rhs in
                    if lhs.createdAt != rhs.createdAt { return lhs.createdAt > rhs.createdAt }
                    return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
                }
            message = files.isEmpty ? "No cloud .nib files." : nil
        } catch {
            message = error.localizedDescription
        }
    }

    func download(_ file: NibCloudFile, baseURL: URL) async {
        do {
            var request = try NibCloudRoute.download(fileID: file.id)
                .urlRequest(baseURL: baseURL, bearerToken: NibCredentialStore.token(for: baseURL))
            request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                message = "Download failed."
                return
            }
            let url = try localDownloadURL(for: file)
            try data.write(to: url, options: [.atomic])
            downloadedFileID = file.id
            message = "Downloaded \(Self.byteCount(data.count))."
        } catch {
            message = error.localizedDescription
        }
    }

    func handoffURL(for file: NibCloudFile, baseURL: URL) -> URL? {
        if let contentURL = file.contentURL {
            return contentURL
        }
        guard let request = try? NibCloudRoute.download(fileID: file.id)
            .urlRequest(baseURL: baseURL, bearerToken: NibCredentialStore.token(for: baseURL)) else {
            return nil
        }
        return request.url
    }

    static func isNibFile(_ file: NibCloudFile) -> Bool {
        file.name.lowercased().hasSuffix(".nib")
            || file.contentType.localizedCaseInsensitiveContains("x-nib")
            || file.contentType.localizedCaseInsensitiveContains("nib")
    }

    static func byteCount(_ bytes: Int64) -> String {
        byteCount(Int(bytes))
    }

    static func byteCount(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    static func lineageSummary(_ file: NibCloudFile) -> String {
        var parts: [String] = []
        if let requestID = file.requestID, !requestID.isEmpty {
            parts.append("request \(requestID)")
        }
        if let sourceID = file.derivedFromFileID, !sourceID.isEmpty {
            parts.append("from \(sourceID)")
        }
        return parts.isEmpty ? "original" : parts.joined(separator: " · ")
    }

    private func localDownloadURL(for file: NibCloudFile) throws -> URL {
        let root = try FileManager.default.url(
            for: .cachesDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        .appendingPathComponent("NibCloud", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let safeName = file.name.replacingOccurrences(of: "/", with: "-")
        return root.appendingPathComponent(safeName.isEmpty ? "\(file.id).nib" : safeName)
    }
}

struct WatchCloudLibrarySection: View {
    @ObservedObject var library: NibWatchCloudLibrary
    var baseURL: URL

    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Cloud")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(WatchTheme.muted)
                Spacer()
                if library.isLoading {
                    ProgressView()
                        .controlSize(.mini)
                }
            }

            if library.hasFiles {
                ForEach(library.files.prefix(4)) { file in
                    WatchCloudFileCard(
                        file: file,
                        downloaded: library.downloadedFileID == file.id,
                        download: {
                            Task { await library.download(file, baseURL: baseURL) }
                        },
                        open: {
                            guard let url = library.handoffURL(for: file, baseURL: baseURL) else { return }
                            openURL(url)
                        }
                    )
                }
            } else if let message = library.message {
                WatchNoticeSurface(message: message)
            }

            if let message = library.message, library.hasFiles {
                Text(message)
                    .font(.caption2)
                    .foregroundStyle(WatchTheme.muted)
                    .lineLimit(2)
            }
        }
    }
}

struct WatchCloudFileCard: View {
    var file: NibCloudFile
    var downloaded: Bool
    var download: () -> Void
    var open: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .top, spacing: 7) {
                preview
                VStack(alignment: .leading, spacing: 4) {
                    Text(file.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(WatchTheme.text)
                        .lineLimit(2)
                    Text(statusLine)
                        .font(.caption2)
                        .foregroundStyle(WatchTheme.blue)
                        .lineLimit(1)
                    Text(NibWatchCloudLibrary.lineageSummary(file))
                        .font(.caption2)
                        .foregroundStyle(WatchTheme.muted)
                        .lineLimit(1)
                }
            }

            HStack(spacing: 7) {
                Button(action: download) {
                    Image(systemName: downloaded ? "checkmark.circle.fill" : "arrow.down.circle")
                }
                .accessibilityLabel(downloaded ? "Downloaded" : "Download")

                Button(action: open) {
                    Image(systemName: "arrow.up.forward.app")
                }
                .accessibilityLabel("Open")
            }
            .buttonStyle(WatchMiniIconButtonStyle())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(WatchTheme.surfaceSoft, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(WatchTheme.border))
    }

    private var statusLine: String {
        "available · \(NibWatchCloudLibrary.byteCount(file.bytes))"
    }

    @ViewBuilder
    private var preview: some View {
        if let previewURL = file.previewURL {
            AsyncImage(url: previewURL) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFill()
                case .failure:
                    Image(systemName: "doc")
                        .foregroundStyle(WatchTheme.muted)
                case .empty:
                    ProgressView()
                @unknown default:
                    EmptyView()
                }
            }
            .frame(width: 38, height: 38)
            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            .background(WatchTheme.surface, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        } else {
            Image(systemName: "doc")
                .font(.title3)
                .foregroundStyle(WatchTheme.muted)
                .frame(width: 38, height: 38)
                .background(WatchTheme.surface, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
    }
}
