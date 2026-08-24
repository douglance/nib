import Foundation
import NibCloud
import NibDomain
import Testing

@Suite("Nib cloud client primitives")
struct NibCloudTests {
    @Test("Routes build canonical API requests")
    func routeBuildsCanonicalAPIRequests() throws {
        let baseURL = try #require(URL(string: "https://nib.example.test/base/"))
        let upload = NibFileUpload(
            fileID: "file-1",
            name: "Review.pdf",
            contentType: "application/pdf",
            bytes: 42,
            sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            createdAt: Date(timeIntervalSince1970: 0),
            lineage: nil,
            metadata: ["role": "canonical"],
            source: .memory
        )

        let request = try NibCloudRoute.initiateUpload(upload).urlRequest(baseURL: baseURL, bearerToken: "token")
        let body = try #require(request.httpBody)
        let json = try JSONSerialization.jsonObject(with: body) as? [String: Any]

        #expect(request.url?.absoluteString == "https://nib.example.test/api/nib-files/uploads")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer token")
        #expect(request.value(forHTTPHeaderField: "Idempotency-Key") == upload.idempotencyKey)
        #expect(json?["id"] as? String == "file-1")
        #expect(json?["name"] as? String == "Review.pdf")
        #expect(json?["sha256"] as? String == upload.sha256)
        #expect(json?["localID"] == nil)
        #expect(json?["fileName"] == nil)
    }

    @Test("Client decodes library responses into domain files")
    func clientDecodesLibraryResponses() async throws {
        let transport = StubTransport(data: Data("""
        {
          "files": [
            {
              "id": "file_1",
              "name": "Review.pdf",
              "contentType": "application/pdf",
              "bytes": 42,
              "sha256": "abc",
              "createdAt": "2026-08-11T10:00:00Z",
              "derivedFromFileId": null,
              "requestId": null,
              "previewURL": null,
              "contentURL": null,
              "metadata": {}
            }
          ]
        }
        """.utf8))
        let client = NibCloudClient(
            baseURL: URL(string: "https://nib.example.test")!,
            bearerToken: "token",
            transport: transport
        )

        let files = try await client.library()

        #expect(files.map(\.id) == ["file_1"])
        #expect(transport.requests.first?.url?.absoluteString == "https://nib.example.test/api/nib-files")
    }

    @Test("Client runs initiate content complete upload flow")
    func clientRunsFullUploadSessionFlow() async throws {
        let upload = NibFileUpload(
            fileID: "file-1",
            name: "review.nib",
            contentType: "application/x-nib",
            bytes: 3,
            sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
            createdAt: Date(timeIntervalSince1970: 0),
            lineage: NibFileLineage(fileID: "file-1", derivedFromFileID: "source-1", requestID: "request-1"),
            metadata: ["role": "canonical"],
            source: .memory
        )
        let transport = SequencedTransport(responses: [
            response("""
            {
              "upload": {
                "id": "upload-1",
                "fileId": "file-1",
                "status": "initiated",
                "contentURL": "/api/nib-files/uploads/upload-1/content",
                "completeURL": "/api/nib-files/uploads/upload-1/complete",
                "abortURL": "/api/nib-files/uploads/upload-1/abort",
                "createdAt": "2026-08-11T10:00:00Z"
              }
            }
            """, statusCode: 201),
            response("""
            {
              "upload": {
                "id": "upload-1",
                "fileId": "file-1",
                "status": "content-uploaded",
                "contentURL": "/api/nib-files/uploads/upload-1/content",
                "completeURL": "/api/nib-files/uploads/upload-1/complete",
                "abortURL": "/api/nib-files/uploads/upload-1/abort",
                "createdAt": "2026-08-11T10:00:00Z"
              }
            }
            """),
            response("""
            {
              "file": {
                "id": "file-1",
                "name": "review.nib",
                "contentType": "application/x-nib",
                "bytes": 3,
                "sha256": "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
                "createdAt": "2026-08-11T10:01:00Z",
                "derivedFromFileId": "source-1",
                "requestId": "request-1",
                "previewURL": null,
                "contentURL": "/api/nib-files/file-1/content",
                "metadata": { "role": "canonical" }
              }
            }
            """, statusCode: 201)
        ])
        let client = NibCloudClient(
            baseURL: URL(string: "https://nib.example.test")!,
            bearerToken: "token",
            transport: transport
        )

        let session = try await client.initiateUpload(upload)
        try await client.uploadContent(Data([1, 2, 3]), for: session, upload: upload)
        let file = try await client.completeUpload(session)

        #expect(file.id == "file-1")
        #expect(file.derivedFromFileID == "source-1")
        #expect(transport.requests.map { $0.httpMethod ?? "" } == ["POST", "PUT", "POST"])
        #expect(transport.requests.map { $0.url?.absoluteString ?? "" } == [
            "https://nib.example.test/api/nib-files/uploads",
            "https://nib.example.test/api/nib-files/uploads/upload-1/content",
            "https://nib.example.test/api/nib-files/uploads/upload-1/complete"
        ])
        #expect(transport.requests[1].value(forHTTPHeaderField: "Idempotency-Key") == "\(upload.idempotencyKey):content")
        #expect(transport.requests[1].httpBody == Data([1, 2, 3]))
    }

    @Test("Client aborts upload sessions")
    func clientAbortsUploadSessions() async throws {
        let session = NibUploadSession(
            id: "upload-1",
            fileID: "file-1",
            status: .initiated,
            contentURL: "/api/nib-files/uploads/upload-1/content",
            completeURL: "/api/nib-files/uploads/upload-1/complete",
            abortURL: "/api/nib-files/uploads/upload-1/abort",
            createdAt: Date(timeIntervalSince1970: 0)
        )
        let transport = SequencedTransport(responses: [
            response("""
            {
              "upload": {
                "id": "upload-1",
                "fileId": "file-1",
                "status": "aborted",
                "contentURL": "/api/nib-files/uploads/upload-1/content",
                "completeURL": "/api/nib-files/uploads/upload-1/complete",
                "abortURL": "/api/nib-files/uploads/upload-1/abort",
                "createdAt": "2026-08-11T10:00:00Z"
              }
            }
            """)
        ])
        let client = NibCloudClient(
            baseURL: URL(string: "https://nib.example.test")!,
            transport: transport
        )

        let aborted = try await client.abortUpload(session, idempotencyKey: "abort-file-1")

        #expect(aborted.status == .aborted)
        #expect(transport.requests.first?.httpMethod == "POST")
        #expect(transport.requests.first?.url?.absoluteString == "https://nib.example.test/api/nib-files/uploads/upload-1/abort")
        #expect(transport.requests.first?.value(forHTTPHeaderField: "Idempotency-Key") == "abort-file-1")
    }

    @Test("Idempotency conflicts are surfaced as typed errors")
    func idempotencyConflictsAreTypedErrors() async throws {
        let transport = SequencedTransport(responses: [
            response("{ \"error\": \"Idempotency key was reused with a different request\" }", statusCode: 409)
        ])
        let client = NibCloudClient(
            baseURL: URL(string: "https://nib.example.test")!,
            transport: transport
        )

        await #expect(throws: NibCloudError.idempotencyConflict) {
            _ = try await client.library()
        }
    }

    @Test("Outbox keeps offline uploads as queued library items")
    func outboxKeepsOfflineUploadsQueued() {
        let upload = NibFileUpload(
            fileID: "local-offline",
            name: "Offline.pdf",
            contentType: "application/pdf",
            bytes: 10,
            sha256: "offline",
            createdAt: Date(timeIntervalSince1970: 10),
            lineage: nil,
            metadata: [:],
            source: .memory
        )
        var outbox = NibUploadOutbox()

        let inserted = outbox.enqueue(upload)
        let duplicate = outbox.enqueue(upload)

        #expect(inserted == true)
        #expect(duplicate == false)
        #expect(outbox.pendingUploads == [upload])
        #expect(outbox.queuedLibraryItems.map(\.id) == ["local-offline"])
        #expect(outbox.queuedLibraryItems.first?.status == .queued)
    }
}

private final class StubTransport: NibCloudTransport, @unchecked Sendable {
    private let data: Data
    private(set) var requests: [URLRequest] = []

    init(data: Data) {
        self.data = data
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        return (
            data,
            HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
        )
    }
}

private final class SequencedTransport: NibCloudTransport, @unchecked Sendable {
    private var responses: [(Data, Int)]
    private(set) var requests: [URLRequest] = []
    private(set) var uploads: [Data] = []

    init(responses: [(Data, Int)]) {
        self.responses = responses
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        if let body = request.httpBody {
            uploads.append(body)
        }
        let next = responses.removeFirst()
        return (
            next.0,
            HTTPURLResponse(
                url: request.url!,
                statusCode: next.1,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
        )
    }
}

private func response(_ body: String, statusCode: Int = 200) -> (Data, Int) {
    (Data(body.utf8), statusCode)
}
