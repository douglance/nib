import Foundation

public struct NibCloudFile: Identifiable, Codable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let contentType: String
    public let bytes: Int64
    public let sha256: String
    public let createdAt: Date
    public let derivedFromFileID: String?
    public let requestID: String?
    public let previewURL: URL?
    public let contentURL: URL?
    public let metadata: [String: String]

    public init(
        id: String,
        name: String,
        contentType: String,
        bytes: Int64,
        sha256: String,
        createdAt: Date,
        derivedFromFileID: String?,
        requestID: String?,
        previewURL: URL?,
        contentURL: URL?,
        metadata: [String: String] = [:]
    ) {
        self.id = id
        self.name = name
        self.contentType = contentType
        self.bytes = bytes
        self.sha256 = sha256
        self.createdAt = createdAt
        self.derivedFromFileID = derivedFromFileID
        self.requestID = requestID
        self.previewURL = previewURL
        self.contentURL = contentURL
        self.metadata = metadata
    }

    public var lineage: NibFileLineage {
        NibFileLineage(fileID: id, derivedFromFileID: derivedFromFileID, requestID: requestID)
    }

    enum CodingKeys: String, CodingKey {
        case id, name, contentType, bytes, sha256, createdAt, previewURL, contentURL, metadata
        case derivedFromFileID = "derivedFromFileId"
        case requestID = "requestId"
    }
}

public struct NibFileLineage: Codable, Hashable, Sendable {
    public let fileID: String
    public let derivedFromFileID: String?
    public let requestID: String?

    public init(fileID: String, derivedFromFileID: String?, requestID: String?) {
        self.fileID = fileID
        self.derivedFromFileID = derivedFromFileID
        self.requestID = requestID
    }

    public func derivative(fileID: String) -> NibFileLineage {
        NibFileLineage(
            fileID: fileID,
            derivedFromFileID: self.fileID,
            requestID: requestID
        )
    }
}

public struct NibFileUpload: Identifiable, Codable, Hashable, Sendable {
    public let fileID: String
    public let name: String
    public let contentType: String
    public let bytes: Int64
    public let sha256: String
    public let createdAt: Date
    public let lineage: NibFileLineage?
    public let metadata: [String: String]
    public let source: NibFileUploadSource
    public let idempotencyKey: String

    public var id: String { fileID }

    public init(
        fileID: String,
        name: String,
        contentType: String,
        bytes: Int64,
        sha256: String,
        createdAt: Date,
        lineage: NibFileLineage?,
        metadata: [String: String] = [:],
        source: NibFileUploadSource,
        idempotencyKey: String? = nil
    ) {
        self.fileID = fileID
        self.name = name
        self.contentType = contentType
        self.bytes = bytes
        self.sha256 = sha256
        self.createdAt = createdAt
        self.lineage = lineage
        self.metadata = metadata
        self.source = source
        self.idempotencyKey = idempotencyKey ?? Self.makeIdempotencyKey(
            fileID: fileID,
            name: name,
            bytes: bytes,
            sha256: sha256,
            lineage: lineage
        )
    }

    private static func makeIdempotencyKey(
        fileID: String,
        name: String,
        bytes: Int64,
        sha256: String,
        lineage: NibFileLineage?
    ) -> String {
        [
            "upload",
            fileID,
            name,
            String(bytes),
            sha256,
            lineage?.fileID ?? "",
            lineage?.derivedFromFileID ?? "",
            lineage?.requestID ?? ""
        ]
        .map(Self.keyComponent)
        .joined(separator: ":")
    }

    private static func keyComponent(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-"))
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}

public enum NibFileUploadSource: Codable, Hashable, Sendable {
    case memory
    case localFile(bookmark: Data)
}

public enum NibLibraryItemStatus: String, Codable, Hashable, Sendable {
    case available
    case queued
    case uploading
    case failed
}

public struct NibLibraryItem: Identifiable, Codable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let contentType: String
    public let bytes: Int64
    public let sha256: String?
    public let createdAt: Date
    public let status: NibLibraryItemStatus
    public let lineage: NibFileLineage?
    public let file: NibCloudFile?
    public let upload: NibFileUpload?

    public static func file(_ file: NibCloudFile) -> NibLibraryItem {
        NibLibraryItem(
            id: file.id,
            name: file.name,
            contentType: file.contentType,
            bytes: file.bytes,
            sha256: file.sha256,
            createdAt: file.createdAt,
            status: .available,
            lineage: file.lineage,
            file: file,
            upload: nil
        )
    }

    public static func queued(_ upload: NibFileUpload) -> NibLibraryItem {
        NibLibraryItem(
            id: upload.fileID,
            name: upload.name,
            contentType: upload.contentType,
            bytes: upload.bytes,
            sha256: upload.sha256,
            createdAt: upload.createdAt,
            status: .queued,
            lineage: upload.lineage,
            file: nil,
            upload: upload
        )
    }

    public init(
        id: String,
        name: String,
        contentType: String,
        bytes: Int64,
        sha256: String?,
        createdAt: Date,
        status: NibLibraryItemStatus,
        lineage: NibFileLineage?,
        file: NibCloudFile?,
        upload: NibFileUpload?
    ) {
        self.id = id
        self.name = name
        self.contentType = contentType
        self.bytes = bytes
        self.sha256 = sha256
        self.createdAt = createdAt
        self.status = status
        self.lineage = lineage
        self.file = file
        self.upload = upload
    }

    public var searchableText: String {
        [name, contentType, sha256, lineage?.fileID, lineage?.derivedFromFileID, lineage?.requestID]
            .compactMap { $0 }
            .joined(separator: " ")
            .lowercased()
    }
}

public enum NibLibrary {
    public static func sorted(_ items: [NibLibraryItem]) -> [NibLibraryItem] {
        items.sorted { lhs, rhs in
            if lhs.createdAt != rhs.createdAt {
                return lhs.createdAt > rhs.createdAt
            }
            return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
        }
    }

    public static func filter(_ items: [NibLibraryItem], query: String) -> [NibLibraryItem] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return items }
        return items.filter { $0.searchableText.contains(needle) }
    }
}

public protocol NibUploadDataProviding: Sendable {
    func data(for upload: NibFileUpload) async throws -> Data
}

public protocol NibConnectivityObserving: Sendable {
    var isOnline: Bool { get async }
}

public protocol NibLibraryCaching: Sendable {
    func loadLibraryItems() async throws -> [NibLibraryItem]
    func saveLibraryItems(_ items: [NibLibraryItem]) async throws
}
