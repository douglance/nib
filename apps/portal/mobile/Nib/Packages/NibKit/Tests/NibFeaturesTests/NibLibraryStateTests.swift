import Foundation
import NibDomain
import NibFeatures
import SwiftUI
import Testing

@Suite("Shared library state")
@MainActor
struct NibLibraryStateTests {
    @Test("Offline new files appear as queued before sync")
    func offlineNewFilesAppearAsQueuedBeforeSync() {
        let state = NibLibraryState()
        let upload = NibFileUpload(
            fileID: "offline-1",
            name: "Offline capture.pdf",
            contentType: "application/pdf",
            bytes: 10,
            sha256: "offline",
            createdAt: Date(timeIntervalSince1970: 20),
            lineage: nil,
            metadata: [:],
            source: .memory
        )

        state.replaceRemoteFiles([])
        state.queueOfflineUpload(upload)
        state.queueOfflineUpload(upload)

        #expect(state.items.map(\.id) == ["offline-1"])
        #expect(state.items.first?.status == .queued)
        #expect(state.filteredItems(query: "capture").map(\.id) == ["offline-1"])
    }

    @Test("Remote files and queued files remain chronologically ordered")
    func remoteAndQueuedFilesRemainChronologicallyOrdered() {
        let state = NibLibraryState()
        state.replaceRemoteFiles([
            NibCloudFile(
                id: "remote-old",
                name: "Remote old.pdf",
                contentType: "application/pdf",
                bytes: 1,
                sha256: "old",
                createdAt: Date(timeIntervalSince1970: 1),
                derivedFromFileID: nil,
                requestID: nil,
                previewURL: nil,
                contentURL: nil,
                metadata: [:]
            )
        ])
        state.queueOfflineUpload(NibFileUpload(
            fileID: "queued-new",
            name: "Queued new.pdf",
            contentType: "application/pdf",
            bytes: 2,
            sha256: "new",
            createdAt: Date(timeIntervalSince1970: 2),
            lineage: nil,
            metadata: [:],
            source: .memory
        ))

        #expect(state.items.map(\.id) == ["queued-new", "remote-old"])
    }

    @Test("Shared SwiftUI library primitives compile with platform-neutral inputs")
    func sharedSwiftUILibraryPrimitivesCompile() {
        let item = NibLibraryItem.queued(NibFileUpload(
            fileID: "queued-ui",
            name: "Queued UI.pdf",
            contentType: "application/pdf",
            bytes: 12,
            sha256: "ui",
            createdAt: Date(timeIntervalSince1970: 3),
            lineage: nil,
            metadata: [:],
            source: .memory
        ))

        let list = NibLibraryListView(items: [item], selectedID: nil) { _ in }
        let status = NibLibraryStatusView(queuedCount: 1, availableCount: 0, isOffline: true)
        let empty = NibLibraryEmptyView()
        let error = NibLibraryErrorView(message: "Offline")
        let detail = NibLibraryDetailView(item: item)

        #expect(String(describing: type(of: list)).contains("NibLibraryListView"))
        #expect(String(describing: type(of: status)).contains("NibLibraryStatusView"))
        #expect(String(describing: type(of: empty)).contains("NibLibraryEmptyView"))
        #expect(String(describing: type(of: error)).contains("NibLibraryErrorView"))
        #expect(String(describing: type(of: detail)).contains("NibLibraryDetailView"))
    }
}
