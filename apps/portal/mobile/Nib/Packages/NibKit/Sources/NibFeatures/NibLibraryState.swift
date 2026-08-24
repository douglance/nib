import Foundation
import NibCloud
import NibDomain
import Observation

@MainActor
@Observable
public final class NibLibraryState {
    private var remoteFiles: [NibCloudFile]
    private var outbox: NibUploadOutbox

    public init(remoteFiles: [NibCloudFile] = [], outbox: NibUploadOutbox = NibUploadOutbox()) {
        self.remoteFiles = remoteFiles
        self.outbox = outbox
    }

    public var items: [NibLibraryItem] {
        NibLibrary.sorted(remoteFiles.map(NibLibraryItem.file) + outbox.queuedLibraryItems)
    }

    public var queuedUploads: [NibFileUpload] {
        outbox.pendingUploads
    }

    public func replaceRemoteFiles(_ files: [NibCloudFile]) {
        remoteFiles = files
    }

    @discardableResult
    public func queueOfflineUpload(_ upload: NibFileUpload) -> Bool {
        outbox.enqueue(upload)
    }

    public func filteredItems(query: String) -> [NibLibraryItem] {
        NibLibrary.filter(items, query: query)
    }
}
