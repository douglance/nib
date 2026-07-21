import Foundation

enum NibDefaults {
    static let defaultBaseURLString = "https://dave.tail5d92b4.ts.net"
}

@MainActor
final class NibClient: ObservableObject {
    var baseURL: URL
    private let session: URLSession

    init(baseURL: URL = URL(string: NibDefaults.defaultBaseURLString)!, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func configure(baseURLString: String) {
        guard let next = URL(string: baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return
        }
        baseURL = next
    }

    func requests() async throws -> [NibRequest] {
        try await get("/api/requests")
    }

    func request(id: String) async throws -> NibRequest {
        try await get("/api/requests/\(id)")
    }

    func projects() async throws -> [NibProject] {
        let response: NibProjectsResponse = try await get("/api/projects")
        return response.projects
    }

    func project(id: String) async throws -> NibProject? {
        try await projects().first { $0.id == id }
    }

    func workspace(projectId: String) async throws -> NibProjectWorkspace {
        try await get("/api/projects/\(projectId)/workspace")
    }

    func addWorkspaceNote(projectId: String, text: String, screenshotUrl: String? = nil) async throws -> NibProjectWorkspace {
        try await patch(
            "/api/projects/\(projectId)/workspace",
            body: WorkspacePatchBody(note: text, screenshotUrl: screenshotUrl)
        )
    }

    func captureScreenshots(projectId: String) async throws -> NibProjectScreenshotsResponse {
        try await post("/api/projects/\(projectId)/screenshots", body: EmptyBody())
    }

    func recheckProject(projectId: String) async throws -> NibProject {
        try await post("/api/projects/\(projectId)/recheck", body: EmptyBody())
    }

    func setPreferredRoute(projectId: String, mode: String) async throws -> NibProject {
        try await post(
            "/api/projects/\(projectId)/preferred-route",
            body: RouteBody(mode: mode)
        )
    }

    func killProject(projectId: String) async throws -> NibKillResult {
        try await post("/api/projects/\(projectId)/kill", body: EmptyBody())
    }

    func commandPresets(projectId: String) async throws -> [NibCommandPreset] {
        try await get("/api/projects/\(projectId)/command-presets")
    }

    func commandRuns(projectId: String) async throws -> [NibCommandRun] {
        try await get("/api/projects/\(projectId)/commands")
    }

    func runCommand(projectId: String, command: String, cwd: String? = nil) async throws -> NibCommandRun {
        try await post(
            "/api/projects/\(projectId)/commands",
            body: CommandBody(command: command, cwd: cwd)
        )
    }

    func commandEvents(projectId: String, commandId: String) -> AsyncThrowingStream<NibCommandEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = URLRequest(url: url("/api/projects/\(projectId)/commands/\(commandId)/events"))
                    request.setValue("text/event-stream", forHTTPHeaderField: "accept")
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                        throw NSError(domain: "NibClient", code: 1, userInfo: [NSLocalizedDescriptionKey: "Command event stream failed"])
                    }

                    var dataLines: [String] = []
                    for try await line in bytes.lines {
                        if line.isEmpty {
                            try yieldCommandEvent(dataLines: dataLines, continuation: continuation)
                            dataLines.removeAll()
                            continue
                        }
                        if line.hasPrefix("data:") {
                            dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
                        }
                    }
                    try yieldCommandEvent(dataLines: dataLines, continuation: continuation)
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    func devices() async throws -> [NibDevice] {
        let response: NibDevicesResponse = try await get("/api/devices")
        return response.devices
    }

    func notificationStatus() async throws -> NibNotificationStatus {
        try await get("/api/notifications/status")
    }

    func sendTestNotification() async throws -> NibNotificationTestResult {
        try await post("/api/notifications/test", body: EmptyBody())
    }

    func activity(projectId: String? = nil) async throws -> [NibActivityEvent] {
        if let projectId {
            return try await get("/api/activity?projectId=\(Self.escapePathComponent(projectId))")
        }
        return try await get("/api/activity")
    }

    func waiting() async throws -> [NibWaitingPane] {
        try await get("/api/waiting")
    }

    func respond(
        requestId: String,
        text: String? = nil,
        choice: String? = nil,
        choiceIndex: Int? = nil,
        decision: String? = nil,
        comment: String? = nil,
        annotations: [NibReviewAnnotation]? = nil
    ) async throws -> NibRequest {
        try await post(
            "/api/requests/\(requestId)/respond",
            body: ResponseBody(
                text: text,
                choice: choice,
                choiceIndex: choiceIndex,
                decision: decision,
                comment: comment,
                annotations: annotations
            )
        )
    }

    func registerDevice(
        name: String,
        token: String,
        platform: String,
        apnsTopic: String?,
        capabilities: [String]
    ) async throws -> NibDevice {
        try await post(
            "/api/devices",
            body: DeviceBody(
                name: name,
                platform: platform,
                pushKind: "apns",
                token: token,
                apnsTopic: apnsTopic,
                capabilities: capabilities
            )
        )
    }

    func uploadImage(requestId: String, name: String, contentType: String, data: Data) async throws -> NibRequest.Attachment {
        try await post(
            "/api/requests/\(requestId)/attachments",
            body: AttachmentBody(name: name, contentType: contentType, contentBase64: data.base64EncodedString())
        )
    }

    func absoluteURL(_ value: String?) -> URL? {
        guard let value, !value.isEmpty else { return nil }
        return URL(string: value, relativeTo: baseURL)?.absoluteURL
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let (data, response) = try await session.data(from: url(path))
        try validate(response: response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func post<T: Decodable, Body: Encodable>(_ path: String, body: Body) async throws -> T {
        var request = URLRequest(url: url(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func patch<T: Decodable, Body: Encodable>(_ path: String, body: Body) async throws -> T {
        var request = URLRequest(url: url(path))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func url(_ path: String) -> URL {
        URL(string: path, relativeTo: baseURL)!.absoluteURL
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let text = String(data: data, encoding: .utf8) ?? "Request failed"
            throw NSError(domain: "NibClient", code: 1, userInfo: [NSLocalizedDescriptionKey: text])
        }
    }

    private static func escapePathComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
    }

    private func yieldCommandEvent(
        dataLines: [String],
        continuation: AsyncThrowingStream<NibCommandEvent, Error>.Continuation
    ) throws {
        let payload = dataLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !payload.isEmpty else { return }
        if let event = try? JSONDecoder().decode(NibCommandEvent.self, from: Data(payload.utf8)) {
            continuation.yield(event)
            return
        }
        if let object = try? JSONDecoder().decode([String: String].self, from: Data(payload.utf8)),
           let message = object["message"] {
            throw NSError(domain: "NibClient", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
        }
    }
}

private struct ResponseBody: Encodable {
    var text: String?
    var choice: String?
    var choiceIndex: Int?
    var decision: String?
    var comment: String?
    var annotations: [NibReviewAnnotation]?
}

private struct DeviceBody: Encodable {
    var name: String
    var platform: String
    var pushKind: String
    var token: String
    var apnsTopic: String?
    var capabilities: [String]
}

private struct AttachmentBody: Encodable {
    var name: String
    var contentType: String
    var contentBase64: String
}

private struct WorkspacePatchBody: Encodable {
    var note: String?
    var screenshotUrl: String?
}

private struct CommandBody: Encodable {
    var command: String
    var cwd: String?
}

private struct RouteBody: Encodable {
    var mode: String
}

private struct EmptyBody: Encodable {}
