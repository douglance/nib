import Foundation
import NibDomain
import Testing

@Suite("Nib domain models")
struct NibDomainTests {
    @Test("Cloud files decode as immutable value records with lineage")
    func cloudFileDecodesWithLineage() throws {
        let data = Data("""
        {
          "id": "file_1",
          "name": "Review.pdf",
          "contentType": "application/pdf",
          "bytes": 2048,
          "sha256": "abc",
          "createdAt": "2026-08-11T10:00:00Z",
          "derivedFromFileId": "file_parent",
          "requestId": "request_1",
          "previewURL": "https://nib.example.test/previews/file_1",
          "contentURL": "https://nib.example.test/files/file_1",
          "metadata": { "role": "review" }
        }
        """.utf8)

        let file = try JSONDecoder.nibISO8601.decode(NibCloudFile.self, from: data)

        #expect(file.id == "file_1")
        #expect(file.name == "Review.pdf")
        #expect(file.bytes == 2048)
        #expect(file.sha256 == "abc")
        #expect(file.derivedFromFileID == "file_parent")
        #expect(file.requestID == "request_1")
        #expect(file.previewURL?.absoluteString == "https://nib.example.test/previews/file_1")
        #expect(file.contentURL?.absoluteString == "https://nib.example.test/files/file_1")
        #expect(file.metadata["role"] == "review")
        #expect(file.lineage.fileID == "file_1")
        #expect(file.lineage.derivedFromFileID == "file_parent")

        let copied = file
        #expect(copied == file)
    }

    @Test("Lineage projects immutable derivative ownership")
    func lineageProjectsDerivativeOwnership() {
        let root = NibFileLineage(fileID: "root", derivedFromFileID: nil, requestID: "request")

        let child = root.derivative(fileID: "child")

        #expect(child.fileID == "child")
        #expect(child.derivedFromFileID == "root")
        #expect(child.requestID == "request")
    }

    @Test("Library ordering is reverse chronological and filtering searches file fields")
    func libraryOrderingAndFiltering() {
        let older = NibLibraryItem.file(file(
            id: "old",
            name: "Sketch.png",
            contentType: "image/png",
            createdAt: date("2026-08-11T09:00:00Z")
        ))
        let newer = NibLibraryItem.file(file(
            id: "new",
            name: "Contract.pdf",
            contentType: "application/pdf",
            createdAt: date("2026-08-11T11:00:00Z")
        ))
        let queued = NibLibraryItem.queued(upload(
            fileID: "local",
            name: "Offline note.txt",
            contentType: "text/plain",
            createdAt: date("2026-08-11T10:00:00Z")
        ))

        let ordered = NibLibrary.sorted([older, newer, queued])
        #expect(ordered.map(\.id) == ["new", "local", "old"])

        #expect(NibLibrary.filter(ordered, query: "pdf").map(\.id) == ["new"])
        #expect(NibLibrary.filter(ordered, query: "offline").map(\.id) == ["local"])
        #expect(NibLibrary.filter(ordered, query: " ").map(\.id) == ["new", "local", "old"])
    }

    @Test("Upload idempotency identity is stable for the same local file generation")
    func uploadIdempotencyIdentityIsStable() {
        let lineage = NibFileLineage(fileID: "parent", derivedFromFileID: "root", requestID: "request")
        let first = upload(fileID: "file-1", name: "review.pdf", lineage: lineage)
        let duplicate = upload(fileID: "file-1", name: "review.pdf", lineage: lineage)
        let derivative = upload(fileID: "child", name: "review.pdf", lineage: lineage.derivative(fileID: "child"))

        #expect(first.idempotencyKey == duplicate.idempotencyKey)
        #expect(first.id == "file-1")
        #expect(first.idempotencyKey != derivative.idempotencyKey)
    }
}

private func file(
    id: String,
    name: String,
    contentType: String,
    createdAt: Date
) -> NibCloudFile {
    NibCloudFile(
        id: id,
        name: name,
        contentType: contentType,
        bytes: 128,
        sha256: "sha256:\(id)",
        createdAt: createdAt,
        derivedFromFileID: nil,
        requestID: nil,
        previewURL: nil,
        contentURL: nil,
        metadata: [:]
    )
}

private func upload(
    fileID: String,
    name: String,
    contentType: String = "application/pdf",
    createdAt: Date = date("2026-08-11T10:00:00Z"),
    lineage: NibFileLineage? = nil
) -> NibFileUpload {
    NibFileUpload(
        fileID: fileID,
        name: name,
        contentType: contentType,
        bytes: 512,
        sha256: "sha256:upload",
        createdAt: createdAt,
        lineage: lineage,
        metadata: [:],
        source: .localFile(bookmark: Data([1, 2, 3]))
    )
}

private func date(_ value: String) -> Date {
    ISO8601DateFormatter().date(from: value)!
}

private extension JSONDecoder {
    static var nibISO8601: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
