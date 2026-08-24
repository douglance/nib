import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import NibDomain

public enum NibCloudError: Error, Equatable, Sendable {
    case invalidBaseURL
    case nonHTTPResponse
    case idempotencyConflict
    case requestFailed(statusCode: Int)
}

public enum NibCloudRoute: Sendable {
    case library
    case initiateUpload(NibFileUpload)
    case uploadContent(uploadID: String, contentType: String, idempotencyKey: String)
    case completeUpload(uploadID: String, preview: NibUploadPreview?, idempotencyKey: String)
    case abortUpload(uploadID: String, idempotencyKey: String)
    case download(fileID: String)

    public func urlRequest(baseURL: URL, bearerToken: String? = nil) throws -> URLRequest {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              components.scheme != nil,
              components.host != nil else {
            throw NibCloudError.invalidBaseURL
        }

        components.path = path
        components.query = nil
        guard let url = components.url else { throw NibCloudError.invalidBaseURL }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let bearerToken {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }

        switch self {
        case .library, .download:
            break
        case .initiateUpload(let upload):
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(upload.idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
            request.httpBody = try JSONEncoder.nibISO8601.encode(InitiateUploadBody(upload: upload))
        case .uploadContent(_, let contentType, let idempotencyKey):
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        case .completeUpload(_, let preview, let idempotencyKey):
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
            request.httpBody = try JSONEncoder.nibISO8601.encode(CompleteUploadBody(preview: preview))
        case .abortUpload(_, let idempotencyKey):
            request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        }

        return request
    }

    private var method: String {
        switch self {
        case .library, .download:
            return "GET"
        case .initiateUpload, .completeUpload, .abortUpload:
            return "POST"
        case .uploadContent:
            return "PUT"
        }
    }

    private var path: String {
        switch self {
        case .library:
            return "/api/nib-files"
        case .initiateUpload:
            return "/api/nib-files/uploads"
        case .uploadContent(let uploadID, _, _):
            return "/api/nib-files/uploads/\(Self.pathComponent(uploadID))/content"
        case .completeUpload(let uploadID, _, _):
            return "/api/nib-files/uploads/\(Self.pathComponent(uploadID))/complete"
        case .abortUpload(let uploadID, _):
            return "/api/nib-files/uploads/\(Self.pathComponent(uploadID))/abort"
        case .download(let fileID):
            return "/api/nib-files/\(Self.pathComponent(fileID))"
        }
    }

    private static func pathComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }
}

public protocol NibCloudTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct NibURLSessionTransport: NibCloudTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw NibCloudError.nonHTTPResponse
        }
        return (data, httpResponse)
    }
}

public struct NibCloudClient: Sendable {
    public let baseURL: URL
    public let bearerToken: String?
    private let transport: any NibCloudTransport

    public init(
        baseURL: URL,
        bearerToken: String? = nil,
        transport: any NibCloudTransport = NibURLSessionTransport()
    ) {
        self.baseURL = baseURL
        self.bearerToken = bearerToken
        self.transport = transport
    }

    public func library() async throws -> [NibCloudFile] {
        let request = try NibCloudRoute.library.urlRequest(baseURL: baseURL, bearerToken: bearerToken)
        let response: LibraryResponse = try await perform(request)
        return response.files
    }

    public func initiateUpload(_ upload: NibFileUpload) async throws -> NibUploadSession {
        let request = try NibCloudRoute.initiateUpload(upload).urlRequest(baseURL: baseURL, bearerToken: bearerToken)
        let response: UploadSessionResponse = try await perform(request)
        return response.upload
    }

    @discardableResult
    public func uploadContent(_ data: Data, for session: NibUploadSession, upload: NibFileUpload) async throws -> NibUploadSession {
        let request = try NibCloudRoute.uploadContent(
            uploadID: session.id,
            contentType: upload.contentType,
            idempotencyKey: "\(upload.idempotencyKey):content"
        )
        .urlRequest(baseURL: baseURL, bearerToken: bearerToken, endpoint: session.contentURL)
        let response: UploadSessionResponse = try await perform(request, body: data)
        return response.upload
    }

    public func completeUpload(
        _ session: NibUploadSession,
        preview: NibUploadPreview? = nil,
        idempotencyKey: String? = nil
    ) async throws -> NibCloudFile {
        let key = idempotencyKey ?? "\(session.id):complete"
        let request = try NibCloudRoute.completeUpload(uploadID: session.id, preview: preview, idempotencyKey: key)
            .urlRequest(baseURL: baseURL, bearerToken: bearerToken, endpoint: session.completeURL)
        let response: UploadCompletionResponse = try await perform(request)
        return response.file
    }

    public func abortUpload(_ session: NibUploadSession, idempotencyKey: String? = nil) async throws -> NibUploadSession {
        let key = idempotencyKey ?? "\(session.id):abort"
        let request = try NibCloudRoute.abortUpload(uploadID: session.id, idempotencyKey: key)
            .urlRequest(baseURL: baseURL, bearerToken: bearerToken, endpoint: session.abortURL)
        let response: UploadSessionResponse = try await perform(request)
        return response.upload
    }

    private func perform<Value: Decodable>(_ request: URLRequest) async throws -> Value {
        try await perform(request, body: nil)
    }

    private func perform<Value: Decodable>(_ request: URLRequest, body: Data?) async throws -> Value {
        var request = request
        if let body {
            request.httpBody = body
        }
        let (data, response) = try await transport.data(for: request)
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 409,
               let error = try? JSONDecoder.nibISO8601.decode(ErrorResponse.self, from: data),
               error.error.localizedCaseInsensitiveContains("idempotency key") {
                throw NibCloudError.idempotencyConflict
            }
            throw NibCloudError.requestFailed(statusCode: response.statusCode)
        }
        return try JSONDecoder.nibISO8601.decode(Value.self, from: data)
    }
}

private extension NibCloudRoute {
    func urlRequest(baseURL: URL, bearerToken: String?, endpoint: String?) throws -> URLRequest {
        guard let endpoint, !endpoint.isEmpty else {
            return try urlRequest(baseURL: baseURL, bearerToken: bearerToken)
        }
        let resolvedURL: URL
        if let absolute = URL(string: endpoint), absolute.scheme != nil {
            resolvedURL = absolute
        } else if let relative = URL(string: endpoint, relativeTo: baseURL)?.absoluteURL {
            resolvedURL = relative
        } else {
            throw NibCloudError.invalidBaseURL
        }
        var request = try urlRequest(baseURL: baseURL, bearerToken: bearerToken)
        request.url = resolvedURL
        return request
    }
}

public struct NibUploadOutbox: Sendable {
    private var uploadsByID: [String: NibFileUpload]

    public init(uploads: [NibFileUpload] = []) {
        uploadsByID = Dictionary(uniqueKeysWithValues: uploads.map { ($0.idempotencyKey, $0) })
    }

    public var pendingUploads: [NibFileUpload] {
        uploadsByID.values.sorted { lhs, rhs in
            if lhs.createdAt != rhs.createdAt { return lhs.createdAt < rhs.createdAt }
            return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
        }
    }

    public var queuedLibraryItems: [NibLibraryItem] {
        NibLibrary.sorted(pendingUploads.map(NibLibraryItem.queued))
    }

    @discardableResult
    public mutating func enqueue(_ upload: NibFileUpload) -> Bool {
        guard uploadsByID[upload.idempotencyKey] == nil else { return false }
        uploadsByID[upload.idempotencyKey] = upload
        return true
    }

    @discardableResult
    public mutating func remove(idempotencyKey: String) -> NibFileUpload? {
        uploadsByID.removeValue(forKey: idempotencyKey)
    }
}

public struct NibUploadSession: Identifiable, Codable, Hashable, Sendable {
    public let id: String
    public let fileID: String
    public let status: NibUploadSessionStatus
    public let contentURL: String?
    public let completeURL: String?
    public let abortURL: String?
    public let createdAt: Date

    public init(
        id: String,
        fileID: String,
        status: NibUploadSessionStatus,
        contentURL: String?,
        completeURL: String?,
        abortURL: String?,
        createdAt: Date
    ) {
        self.id = id
        self.fileID = fileID
        self.status = status
        self.contentURL = contentURL
        self.completeURL = completeURL
        self.abortURL = abortURL
        self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey {
        case id, status, contentURL, completeURL, abortURL, createdAt
        case fileID = "fileId"
    }
}

public enum NibUploadSessionStatus: String, Codable, Hashable, Sendable {
    case initiated
    case contentUploaded = "content-uploaded"
    case completed
    case aborted
}

public struct NibUploadPreview: Codable, Hashable, Sendable {
    public let contentType: String
    public let contentBase64: String
    public let sha256: String?

    public init(contentType: String, contentBase64: String, sha256: String? = nil) {
        self.contentType = contentType
        self.contentBase64 = contentBase64
        self.sha256 = sha256
    }
}

private struct LibraryResponse: Decodable {
    var files: [NibCloudFile]
}

private struct UploadSessionResponse: Decodable {
    var upload: NibUploadSession
}

private struct UploadCompletionResponse: Decodable {
    var file: NibCloudFile
}

private struct ErrorResponse: Decodable {
    var error: String
}

private struct InitiateUploadBody: Encodable {
    var id: String
    var name: String
    var contentType: String
    var bytes: Int64
    var sha256: String
    var derivedFromFileId: String?
    var requestId: String?
    var metadata: [String: String]

    init(upload: NibFileUpload) {
        id = upload.fileID
        name = upload.name
        contentType = upload.contentType
        bytes = upload.bytes
        sha256 = upload.sha256
        derivedFromFileId = upload.lineage?.derivedFromFileID
        requestId = upload.lineage?.requestID
        metadata = upload.metadata
    }
}

private struct CompleteUploadBody: Encodable {
    var previewContentBase64: String?
    var previewContentType: String?
    var previewSha256: String?

    init(preview: NibUploadPreview?) {
        previewContentBase64 = preview?.contentBase64
        previewContentType = preview?.contentType
        previewSha256 = preview?.sha256
    }
}

private extension JSONDecoder {
    static var nibISO8601: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

private extension JSONEncoder {
    static var nibISO8601: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
}
