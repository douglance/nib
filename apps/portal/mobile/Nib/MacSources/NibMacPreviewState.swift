import Foundation

enum NibMacPreviewState: String {
    case populated
    case empty
    case offline
    case uploading
    case historyAll = "history-all"
    case historyApproved = "history-approved"
    case historyRejected = "history-rejected"
    case historyCommented = "history-commented"
    case historyCaptures = "history-captures"

    static func current(arguments: [String] = ProcessInfo.processInfo.arguments) -> Self? {
        guard let index = arguments.firstIndex(of: "--nib-preview-state"),
              arguments.indices.contains(index + 1) else {
            return nil
        }
        return Self(rawValue: arguments[index + 1])
    }

    var sidebarSection: NibMacSidebarSection {
        switch self {
        case .historyAll, .historyApproved, .historyRejected, .historyCommented, .historyCaptures:
            return .history
        default:
            return .inbox
        }
    }

    var historyFilter: NibMacHistoryFilter {
        switch self {
        case .historyApproved:
            return .approved
        case .historyRejected:
            return .rejected
        case .historyCommented:
            return .commented
        case .historyCaptures:
            return .captures
        default:
            return .all
        }
    }

    var connectionState: NibMacConnectionState {
        self == .offline ? .reconnecting : .live
    }

    var selectedRequestID: String? {
        switch self {
        case .populated:
            return "approve-layout"
        case .uploading:
            return "uploading-capture"
        case .historyApproved:
            return "approved-state"
        case .historyRejected:
            return "rejected-state"
        case .historyCommented:
            return "commented-state"
        case .historyCaptures:
            return "video-capture"
        case .empty, .offline, .historyAll:
            return nil
        }
    }

    var selectedLibraryItemID: String? {
        self == .historyAll ? "file-child" : nil
    }

    var requests: [NibRequest] {
        switch self {
        case .empty, .offline:
            return []
        case .uploading:
            return [
                Self.request(
                    id: "uploading-capture",
                    title: "Upload visual capture",
                    prompt: "Capture upload is waiting for review.",
                    status: "open",
                    priority: "high",
                    source: "macos",
                    updatedAt: "2026-08-12T01:20:00.000Z",
                    attachmentType: "capture",
                    attachmentContentType: "image/png"
                )
            ]
        case .populated:
            return Self.inboxRequests + Self.historyRequests
        case .historyAll, .historyApproved, .historyRejected, .historyCommented, .historyCaptures:
            return Self.historyRequests
        }
    }

    var projects: [NibProject] {
        [
            NibProject(
                id: "portal",
                name: "Portal",
                targetKind: "web",
                processId: 4120,
                killable: true,
                framework: "Vite",
                sourcePath: "/Users/douglance/Developer/lb/nib/apps/portal",
                port: 5173,
                host: "localhost",
                command: "npm run dev",
                status: "live",
                statusCode: 200,
                contentType: "text/html",
                openPath: "/projects/portal",
                directUrl: "http://localhost:5173",
                routes: nil,
                preferredRoute: nil,
                compatibility: nil,
                lastSeenAt: "2026-08-12T01:20:00.000Z",
                screenshots: nil
            )
        ]
    }

    var devices: [NibDevice] {
        [
            NibDevice(
                id: "doug-mac",
                name: "Doug Mac",
                platform: "macos",
                pushKind: "apns",
                token: "preview",
                apnsTopic: "com.douglance.nib.macos",
                capabilities: ["requests", "visual-review"],
                lastSuccessAt: "2026-08-12T01:19:00.000Z",
                lastError: nil,
                updatedAt: "2026-08-12T01:20:00.000Z"
            )
        ]
    }

    var activityEvents: [NibActivityEvent] {
        [
            NibActivityEvent(
                id: "activity-1",
                projectId: "portal",
                kind: "request.created",
                message: "Visual review requested for Portal",
                createdAt: "2026-08-12T01:20:00.000Z"
            )
        ]
    }

    private static var inboxRequests: [NibRequest] {
        [
            request(
                id: "approve-layout",
                title: "Approve layout",
                prompt: "Check the macOS request detail hierarchy.",
                status: "open",
                priority: "normal",
                source: "visual-review",
                updatedAt: "2026-08-12T01:21:00.000Z"
            ),
            request(
                id: "choose-route",
                kind: "choice",
                title: "Choose route",
                prompt: "Pick the next portal route.",
                status: "viewed",
                priority: "normal",
                source: "agent",
                updatedAt: "2026-08-12T01:20:00.000Z"
            )
        ]
    }

    private static var historyRequests: [NibRequest] {
        [
            request(
                id: "approved-state",
                title: "Approved capture",
                prompt: "Accepted the screenshot.",
                status: "answered",
                priority: "normal",
                source: "visual-review",
                updatedAt: "2026-08-12T01:19:00.000Z",
                responseChoice: "approve"
            ),
            request(
                id: "rejected-state",
                title: "Rejected layout",
                prompt: "Needs spacing changes.",
                status: "answered",
                priority: "normal",
                source: "visual-review",
                updatedAt: "2026-08-12T01:18:00.000Z",
                responseChoice: "reject",
                responseText: "The toolbar controls are too dense."
            ),
            request(
                id: "commented-state",
                title: "Commented motion",
                prompt: "Recorded a comment-only review.",
                status: "answered",
                priority: "normal",
                source: "visual-review",
                updatedAt: "2026-08-12T01:17:00.000Z",
                responseChoice: "comment",
                responseText: "Keep the state but revise copy."
            ),
            request(
                id: "video-capture",
                title: "Video capture",
                prompt: "Review a motion capture artifact.",
                status: "answered",
                priority: "normal",
                source: "capture",
                updatedAt: "2026-08-12T01:16:00.000Z",
                attachmentType: "video",
                attachmentContentType: "video/mp4",
                responseChoice: "approve"
            )
        ]
    }

    private static func request(
        id: String,
        kind: String = "visual-review",
        title: String,
        prompt: String,
        status: String,
        priority: String,
        source: String,
        updatedAt: String,
        attachmentType: String = "image",
        attachmentContentType: String = "image/png",
        responseChoice: String? = nil,
        responseText: String? = nil
    ) -> NibRequest {
        NibRequest(
            id: id,
            kind: kind,
            title: title,
            prompt: prompt,
            body: "Preview request body for visual acceptance.",
            context: nil,
            choices: kind == "choice" ? ["Use", "Revise"] : [],
            allowText: true,
            target: NibRequest.Target(
                projectId: "portal",
                projectName: "Portal",
                appPath: nil,
                url: nil
            ),
            status: status,
            priority: priority,
            source: source,
            createdAt: "2026-08-12T01:10:00.000Z",
            updatedAt: updatedAt,
            attachments: [
                NibRequest.Attachment(
                    id: "\(id)-attachment",
                    requestId: id,
                    name: attachmentType == "video" ? "capture.mp4" : "capture.png",
                    type: attachmentType,
                    contentType: attachmentContentType,
                    bytes: 1024,
                    url: "/api/requests/\(id)/attachments/capture",
                    createdAt: "2026-08-12T01:10:00.000Z"
                )
            ],
            responses: responseChoice.map { choice in
                [
                    NibRequest.Response(
                        id: "\(id)-response",
                        kind: kind,
                        text: responseText ?? choice,
                        choice: choice,
                        choiceIndex: 0,
                        deviceId: "doug-mac",
                        device: nil,
                        createdAt: "2026-08-12T01:20:00.000Z"
                    )
                ]
            } ?? []
        )
    }
}
