import Foundation
import NibDomain

enum NibMacSidebarSection: String, CaseIterable, Identifiable, Hashable {
    case inbox
    case history
    case projects
    case devices
    case activity

    var id: Self { self }

    var title: String {
        switch self {
        case .inbox:
            return "Inbox"
        case .history:
            return "History"
        case .projects:
            return "Projects"
        case .devices:
            return "Devices"
        case .activity:
            return "Activity"
        }
    }

    var systemImage: String {
        switch self {
        case .inbox:
            return "tray"
        case .history:
            return "clock.arrow.circlepath"
        case .projects:
            return "folder"
        case .devices:
            return "macbook.and.iphone"
        case .activity:
            return "waveform.path.ecg"
        }
    }
}

enum NibMacHistoryFilter: String, CaseIterable, Identifiable, Hashable {
    case all
    case approved
    case rejected
    case commented
    case captures

    var id: Self { self }

    var title: String {
        switch self {
        case .all:
            return "All"
        case .approved:
            return "Approved"
        case .rejected:
            return "Rejected"
        case .commented:
            return "Commented"
        case .captures:
            return "Captures"
        }
    }

    func filtered(_ requests: [NibRequest]) -> [NibRequest] {
        switch self {
        case .all:
            return requests
        case .approved:
            return requests.filter { $0.macDecision == "approve" }
        case .rejected:
            return requests.filter { $0.macDecision == "reject" }
        case .commented:
            return requests.filter { $0.macDecision == "comment" }
        case .captures:
            return requests.filter(\.hasMacCapture)
        }
    }
}

struct NibMacBadgeSnapshot: Equatable {
    var sidebar: [NibMacSidebarSection: Int]
    var dock: Int
    var menuBar: Int

    static let empty = NibMacBadgeSnapshot(sidebar: [:], dock: 0, menuBar: 0)
}

enum NibMacUploadState: Equatable {
    case queued
    case uploading(progress: Double?)
    case uploaded
    case failed(String)

    var label: String {
        switch self {
        case .queued:
            return "Queued"
        case .uploading:
            return "Uploading"
        case .uploaded:
            return "Uploaded"
        case .failed:
            return "Upload failed"
        }
    }
}

extension NibRequest {
    var isMacHistoryItem: Bool {
        !isActive || !responses.isEmpty
    }

    var macDecision: String? {
        latestResponse?.choice?.lowercased()
    }

    var hasMacCapture: Bool {
        visualReviewVideo != nil
            || visualReviewPDF != nil
            || attachments.contains { attachment in
                attachment.type.lowercased() == "capture"
            }
    }

    var macUploadState: NibMacUploadState? {
        if status == "uploading" {
            return .uploading(progress: nil)
        }
        if isActive, attachments.contains(where: { $0.type.lowercased() == "capture" }) {
            return .uploading(progress: 0.42)
        }
        return nil
    }

    var macLibraryItem: NibLibraryItem? {
        guard let attachment = attachments.first else { return nil }
        let created = ISO8601DateFormatter().date(from: attachment.createdAt) ?? Date(timeIntervalSince1970: 0)
        return NibLibraryItem(
            id: attachment.id,
            name: attachment.name,
            contentType: attachment.contentType,
            bytes: Int64(attachment.bytes),
            sha256: nil,
            createdAt: created,
            status: macUploadState == nil && !isActive ? .available : .queued,
            lineage: NibFileLineage(
                fileID: attachment.id,
                derivedFromFileID: nil,
                requestID: id
            ),
            file: nil,
            upload: nil
        )
    }
}
