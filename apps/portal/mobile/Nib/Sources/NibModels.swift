import Foundation

struct NibRequest: Identifiable, Codable, Hashable {
    struct Target: Codable, Hashable {
        var projectId: String?
        var projectName: String?
        var appPath: String?
        var url: String?
    }

    struct Attachment: Identifiable, Codable, Hashable {
        var id: String
        var requestId: String
        var name: String
        var type: String
        var contentType: String
        var bytes: Int
        var url: String
        var createdAt: String
    }

    struct Response: Identifiable, Codable, Hashable {
        var id: String
        var kind: String
        var text: String
        var choice: String?
        var choiceIndex: Int?
        var createdAt: String
    }

    var id: String
    var kind: String
    var title: String
    var prompt: String
    var body: String?
    var context: String?
    var choices: [String]
    var allowText: Bool
    var target: Target
    var status: String
    var priority: String
    var createdAt: String
    var updatedAt: String
    var attachments: [Attachment]
    var responses: [Response]

    var isActive: Bool {
        ["open", "viewed", "stale"].contains(status)
    }

    var targetURL: URL? {
        if let url = target.url, let resolved = URL(string: url) {
            return resolved
        }
        return nil
    }

    var latestResponse: Response? {
        responses.first
    }
}

struct NibReviewAnnotation: Identifiable, Codable, Hashable {
    var id: String
    var type: String
    var color: String
    var x: Double? = nil
    var y: Double? = nil
    var width: Double? = nil
    var height: Double? = nil
    var startX: Double? = nil
    var startY: Double? = nil
    var endX: Double? = nil
    var endY: Double? = nil
    var points: [[Double]]? = nil
    var content: String? = nil
    var strokeWidth: Double? = nil
    var fontSize: Double? = nil
    var align: String? = nil
    var head: String? = nil

    enum CodingKeys: String, CodingKey {
        case id, type, color, x, y, width, height, points, content, align, head
        case startX = "start_x"
        case startY = "start_y"
        case endX = "end_x"
        case endY = "end_y"
        case strokeWidth = "stroke_width"
        case fontSize = "font_size"
    }
}

struct NibDevice: Identifiable, Codable, Hashable {
    var id: String
    var name: String
    var platform: String
    var pushKind: String
    var token: String
    var apnsTopic: String?
    var capabilities: [String]
    var lastSuccessAt: String?
    var lastError: String?
    var updatedAt: String
}

struct NibDevicesResponse: Codable {
    var devices: [NibDevice]
}

struct NibNotificationStatus: Codable, Hashable {
    var subscriptionCount: Int
    var deviceCount: Int
    var webPushDeviceCount: Int?
    var apnsDeviceCount: Int?
    var apnsHealthyDeviceCount: Int?
    var apnsLastError: String?
    var apnsConfigured: Bool
    var apnsEnvironment: String?
    var apnsTopic: String?
    var apnsKeyConfigured: Bool?
    var apnsKeyReadable: Bool?
    var apnsMissing: [String]?
    var apnsIssues: [String]?
    var webReady: Bool?
    var nativeReady: Bool?
}

struct NibNotificationTestResult: Codable, Hashable {
    var sent: Int
    var requestId: String?
    var feedbackId: String?
    var type: String
}

struct NibActivityEvent: Identifiable, Codable, Hashable {
    var id: String
    var projectId: String?
    var kind: String
    var message: String
    var createdAt: String
}

struct NibWaitingPane: Identifiable, Codable, Hashable {
    var session: String
    var paneId: String
    var window: String
    var reason: String
    var since: String
    var fingerprint: String

    var id: String {
        "\(session):\(paneId)"
    }
}

struct NibViewerState: Codable, Hashable {
    var drawer: String
    var activeTab: String
    var viewport: String
}

struct NibWorkspaceNote: Identifiable, Codable, Hashable {
    var id: String
    var text: String
    var createdAt: String
    var screenshotUrl: String?
}

struct NibProjectWorkspace: Codable, Hashable {
    var projectId: String
    var notes: [NibWorkspaceNote]
    var viewer: NibViewerState
    var updatedAt: String
}

struct NibCommandPreset: Identifiable, Codable, Hashable {
    var id: String
    var label: String
    var command: String
    var cwd: String?
}

struct NibCommandRun: Identifiable, Codable, Hashable {
    var id: String
    var projectId: String
    var command: String
    var cwd: String
    var status: String
    var exitCode: Int?
    var signal: String?
    var startedAt: String
    var finishedAt: String?
    var durationMs: Int?
    var stdoutTail: String
    var stderrTail: String
}

struct NibCommandEvent: Codable, Hashable {
    var commandId: String
    var type: String
    var data: NibCommandEventData
    var createdAt: String
}

enum NibCommandEventData: Codable, Hashable {
    case text(String)
    case run(NibCommandRun)
    case message(String)
    case unknown

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let text = try? container.decode(String.self) {
            self = .text(text)
            return
        }
        if let run = try? container.decode(NibCommandRun.self) {
            self = .run(run)
            return
        }
        if let object = try? container.decode([String: String].self),
           let message = object["message"] {
            self = .message(message)
            return
        }
        self = .unknown
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .text(let text):
            try container.encode(text)
        case .run(let run):
            try container.encode(run)
        case .message(let message):
            try container.encode(["message": message])
        case .unknown:
            try container.encodeNil()
        }
    }
}

struct NibProjectsResponse: Codable {
    var projects: [NibProject]
}

struct NibScreenshotInfo: Codable, Hashable {
    var viewport: String
    var url: String?
    var capturedAt: String?
    var error: String?
    var width: Int
    var height: Int
}

struct NibCompatibilityInfo: Codable, Hashable {
    var level: String
    var updatedAt: String
}

struct NibProjectScreenshotsResponse: Codable, Hashable {
    var projectId: String
    var screenshots: [String: NibScreenshotInfo]
}

struct NibRouteInfo: Codable, Hashable {
    var mode: String
    var url: String
    var available: Bool
    var label: String
    var statusCode: Int?
    var message: String?
}

struct NibKillResult: Codable, Hashable {
    var projectId: String
    var name: String
    var killed: Bool
}

struct NibProject: Identifiable, Codable, Hashable {
    var id: String
    var name: String
    var targetKind: String
    var processId: Int?
    var killable: Bool?
    var framework: String?
    var sourcePath: String?
    var port: Int?
    var host: String?
    var command: String?
    var status: String
    var statusCode: Int?
    var contentType: String?
    var openPath: String
    var directUrl: String
    var routes: [String: NibRouteInfo]?
    var preferredRoute: String?
    var compatibility: NibCompatibilityInfo?
    var lastSeenAt: String?
    var screenshots: [String: NibScreenshotInfo]?
}
