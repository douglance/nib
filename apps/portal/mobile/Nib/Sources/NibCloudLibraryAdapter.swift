import Combine
import CryptoKit
import Foundation
import NibCloud
import NibDomain
import NibFeatures

@MainActor
final class NibCloudLibraryAdapter: ObservableObject {
    @Published private(set) var isRefreshing = false
    @Published private(set) var isOffline = false
    @Published private(set) var errorMessage: String?
    @Published private var revision = 0

    private let state: NibLibraryState
    private let tokenProvider: (URL) -> String?
    private let idFactory: () -> String
    private let dateProvider: () -> Date
    private let contentFetcher: (URLRequest) async throws -> (Data, URLResponse)
    private var baseURL: URL
    private var sourceBytesByItemID: [NibLibraryItem.ID: Data] = [:]
    private var uploadBytesByIdempotencyKey: [String: Data] = [:]

    init(
        baseURL: URL = URL(string: NibDefaults.defaultBaseURLString)!,
        state: NibLibraryState = NibLibraryState(),
        tokenProvider: @escaping (URL) -> String? = NibCredentialStore.token(for:),
        idFactory: @escaping () -> String = { UUID().uuidString.lowercased() },
        dateProvider: @escaping () -> Date = Date.init,
        contentFetcher: @escaping (URLRequest) async throws -> (Data, URLResponse) = {
            try await URLSession.shared.data(for: $0)
        }
    ) {
        self.baseURL = baseURL
        self.state = state
        self.tokenProvider = tokenProvider
        self.idFactory = idFactory
        self.dateProvider = dateProvider
        self.contentFetcher = contentFetcher
    }

    var items: [NibLibraryItem] {
        _ = revision
        return state.items
    }

    var queuedCount: Int {
        items.filter { $0.status == .queued || $0.status == .uploading }.count
    }

    var availableCount: Int {
        items.filter { $0.status == .available }.count
    }

    func configure(baseURL: URL) {
        guard self.baseURL != baseURL else { return }
        self.baseURL = baseURL
        errorMessage = nil
        isOffline = false
        markChanged()
    }

    func refresh() async {
        isRefreshing = true
        defer { isRefreshing = false }

        do {
            let client = NibCloudClient(
                baseURL: baseURL,
                bearerToken: tokenProvider(baseURL)
            )
            let files = try await client.library()
            state.replaceRemoteFiles(files)
            isOffline = false
            errorMessage = nil
            markChanged()
        } catch is CancellationError {
            return
        } catch {
            isOffline = true
            errorMessage = "Showing cached files. \(error.localizedDescription)"
            markChanged()
        }
    }

    @discardableResult
    func createNewNib(from item: NibLibraryItem) async -> NibFileUpload? {
        do {
            let sourceBytes = try await sourceBytes(for: item)
            let upload = makeCreateNewNibUpload(from: item, bytes: sourceBytes)
            state.queueOfflineUpload(upload)
            uploadBytesByIdempotencyKey[upload.idempotencyKey] = sourceBytes
            errorMessage = nil
            markChanged()
            return upload
        } catch is CancellationError {
            return nil
        } catch {
            errorMessage = error.localizedDescription
            markChanged()
            return nil
        }
    }

    func queuedData(for upload: NibFileUpload) -> Data? {
        uploadBytesByIdempotencyKey[upload.idempotencyKey]
    }

    private func makeCreateNewNibUpload(from item: NibLibraryItem, bytes: Data) -> NibFileUpload {
        let fileID = "local-\(idFactory())"
        let lineage = NibFileLineage(
            fileID: fileID,
            derivedFromFileID: item.lineage?.fileID ?? item.id,
            requestID: item.lineage?.requestID
        )
        let upload = NibFileUpload(
            fileID: fileID,
            name: createNewNibName(from: item.name),
            contentType: item.contentType,
            bytes: Int64(bytes.count),
            sha256: Self.sha256Hex(bytes),
            createdAt: dateProvider(),
            lineage: lineage,
            metadata: [
                "action": "create-new-nib",
                "sourceName": item.name
            ],
            source: .memory
        )
        return upload
    }

    private func sourceBytes(for item: NibLibraryItem) async throws -> Data {
        if let data = sourceBytesByItemID[item.id] {
            return data
        }
        if let upload = item.upload, let data = queuedData(for: upload) {
            return data
        }
        guard item.status == .available, let url = downloadURL(for: item) else {
            throw NSError(
                domain: "NibCloudLibraryAdapter",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Source bytes are not cached. Refresh when online, then create a new Nib."]
            )
        }

        var request = URLRequest(url: url)
        request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        if let token = tokenProvider(baseURL), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await contentFetcher(request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw NSError(
                domain: "NibCloudLibraryAdapter",
                code: http.statusCode,
                userInfo: [NSLocalizedDescriptionKey: "Could not download source file (\(http.statusCode))."]
            )
        }
        if item.bytes >= 0, Int64(data.count) != item.bytes {
            throw NSError(
                domain: "NibCloudLibraryAdapter",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Downloaded source size did not match file history."]
            )
        }
        if let expected = item.sha256?.lowercased(), !expected.isEmpty {
            let actual = Self.sha256Hex(data)
            guard actual == expected else {
                throw NSError(
                    domain: "NibCloudLibraryAdapter",
                    code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "Downloaded source checksum did not match file history."]
                )
            }
        }
        sourceBytesByItemID[item.id] = data
        return data
    }

    func previewURL(for item: NibLibraryItem) -> URL? {
        resolve(item.file?.previewURL)
    }

    func downloadURL(for item: NibLibraryItem) -> URL? {
        if let contentURL = resolve(item.file?.contentURL) {
            return contentURL
        }
        guard item.status == .available else { return nil }
        return URL(string: "/api/nib-files/\(Self.pathComponent(item.id))/content", relativeTo: baseURL)?.absoluteURL
    }

    func openURL(for item: NibLibraryItem) -> URL? {
        previewURL(for: item) ?? downloadURL(for: item)
    }

    func applyDeterministicMockState() {
        state.replaceRemoteFiles([
            NibCloudFile(
                id: "file-root",
                name: "Roadmap review.nib",
                contentType: "application/x-nib",
                bytes: 24_576,
                sha256: "mock-root",
                createdAt: Date(timeIntervalSince1970: 1_786_464_000),
                derivedFromFileID: nil,
                requestID: "req-root",
                previewURL: URL(string: "/api/nib-files/file-root/preview"),
                contentURL: URL(string: "/api/nib-files/file-root/content"),
                metadata: ["fixture": "deterministic"]
            ),
            NibCloudFile(
                id: "file-child",
                name: "Roadmap review notes.nib",
                contentType: "application/x-nib",
                bytes: 31_744,
                sha256: "mock-child",
                createdAt: Date(timeIntervalSince1970: 1_786_467_600),
                derivedFromFileID: "file-root",
                requestID: "req-child",
                previewURL: URL(string: "/api/nib-files/file-child/preview"),
                contentURL: URL(string: "/api/nib-files/file-child/content"),
                metadata: ["fixture": "deterministic"]
            )
        ])
        _ = state.queueOfflineUpload(NibFileUpload(
            fileID: "local-create-new-nib",
            name: "Queued Create New Nib.nib",
            contentType: "application/x-nib",
            bytes: 0,
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            createdAt: Date(timeIntervalSince1970: 1_786_471_200),
            lineage: NibFileLineage(fileID: "local-create-new-nib", derivedFromFileID: "file-child", requestID: "req-child"),
            metadata: ["action": "create-new-nib"],
            source: .memory
        ))
        isOffline = true
        errorMessage = "Showing cached files. Offline fixture."
        markChanged()
    }

    private func resolve(_ url: URL?) -> URL? {
        guard let url else { return nil }
        if url.scheme != nil { return url }
        return URL(string: url.relativeString, relativeTo: baseURL)?.absoluteURL
    }

    private func createNewNibName(from name: String) -> String {
        let path = name as NSString
        let base = path.deletingPathExtension
        let fallback = base.isEmpty ? "Untitled" : base
        let ext = path.pathExtension
        guard !ext.isEmpty else { return "\(fallback) Create New Nib.nib" }
        return "\(fallback) Create New Nib.\(ext)"
    }

    private static func pathComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }

    private static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func markChanged() {
        revision += 1
    }
}
