import NibDomain
import SwiftUI

public struct NibLibraryStatusView: View {
    private let queuedCount: Int
    private let availableCount: Int
    private let isOffline: Bool

    public init(queuedCount: Int, availableCount: Int, isOffline: Bool) {
        self.queuedCount = queuedCount
        self.availableCount = availableCount
        self.isOffline = isOffline
    }

    public var body: some View {
        HStack(spacing: 10) {
            Label("\(availableCount) files", systemImage: "doc")
            if queuedCount > 0 {
                Label("\(queuedCount) queued", systemImage: "tray.and.arrow.up")
            }
            Spacer(minLength: 8)
            Label(isOffline ? "Offline" : "Synced", systemImage: isOffline ? "wifi.slash" : "checkmark.icloud")
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

public struct NibLibraryEmptyView: View {
    public init() {}

    public var body: some View {
        ContentUnavailableView("No files", systemImage: "doc.badge.plus")
    }
}

public struct NibLibraryErrorView: View {
    private let message: String

    public init(message: String) {
        self.message = message
    }

    public var body: some View {
        ContentUnavailableView("Files unavailable", systemImage: "exclamationmark.triangle", description: Text(message))
    }
}

public struct NibLibraryListView: View {
    private let items: [NibLibraryItem]
    private let selectedID: NibLibraryItem.ID?
    private let select: (NibLibraryItem) -> Void

    public init(
        items: [NibLibraryItem],
        selectedID: NibLibraryItem.ID?,
        select: @escaping (NibLibraryItem) -> Void
    ) {
        self.items = items
        self.selectedID = selectedID
        self.select = select
    }

    public var body: some View {
        List(items) { item in
            Button {
                select(item)
            } label: {
                NibLibraryRowView(item: item)
            }
            .buttonStyle(.plain)
            .listRowBackground(rowBackground(for: item))
        }
        .nibLibraryListStyle()
    }

    @ViewBuilder
    private func rowBackground(for item: NibLibraryItem) -> some View {
        if item.id == selectedID {
            Color.accentColor.opacity(0.12)
        }
    }
}

public struct NibLibraryRowView: View {
    private let item: NibLibraryItem

    public init(item: NibLibraryItem) {
        self.item = item
    }

    public var body: some View {
        HStack(spacing: 12) {
            Image(systemName: iconName)
                .font(.title3)
                .foregroundStyle(item.status == .queued ? Color.orange : Color.accentColor)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 3) {
                Text(item.name)
                    .lineLimit(1)
                    .font(.body)
                Text(detailLine)
                    .lineLimit(1)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            if item.status == .queued {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Queued")
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }

    private var iconName: String {
        if item.contentType == "application/pdf" { return "doc.richtext" }
        if item.contentType.starts(with: "image/") { return "photo" }
        if item.contentType.starts(with: "video/") { return "film" }
        return "doc"
    }

    private var detailLine: String {
        let bytes = ByteCountFormatter.string(fromByteCount: item.bytes, countStyle: .file)
        return "\(item.contentType) · \(bytes)"
    }
}

public struct NibLibraryDetailView: View {
    private let item: NibLibraryItem?

    public init(item: NibLibraryItem?) {
        self.item = item
    }

    public var body: some View {
        if let item {
            Form {
                Section {
                    LabeledContent("Name", value: item.name)
                    LabeledContent("Type", value: item.contentType)
                    LabeledContent("Size", value: ByteCountFormatter.string(fromByteCount: item.bytes, countStyle: .file))
                    LabeledContent("Status", value: item.status.rawValue)
                }
                if let lineage = item.lineage {
                    Section("Lineage") {
                        LabeledContent("File", value: lineage.fileID)
                        if let source = lineage.derivedFromFileID {
                            LabeledContent("Derived from", value: source)
                        }
                        if let request = lineage.requestID {
                            LabeledContent("Request", value: request)
                        }
                    }
                }
            }
            .formStyle(.grouped)
        } else {
            NibLibraryEmptyView()
        }
    }
}

private extension View {
    @ViewBuilder
    func nibLibraryListStyle() -> some View {
        #if os(macOS)
        self.listStyle(.sidebar)
        #else
        self.listStyle(.plain)
        #endif
    }
}
