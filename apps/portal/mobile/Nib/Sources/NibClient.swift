import Foundation
import CryptoKit
import NibNotifications
import Security

enum NibDefaults {
    static let defaultBaseURLString = "https://nibtool.com"
    static let registeredDeviceIDKey = "nib.registeredDeviceID"

    static var registeredDeviceID: String? {
        UserDefaults.standard.string(forKey: registeredDeviceIDKey)
    }

    static func rememberRegisteredDeviceID(_ deviceID: String) {
        UserDefaults.standard.set(deviceID, forKey: registeredDeviceIDKey)
    }

    static func rememberRegisteredDevice(_ device: NibDevice) {
        rememberRegisteredDeviceID(device.id)
    }

}

enum NibCredentialStore {
    private static let keyPrefix = "nib.localSession."

    static func token(for portal: URL) -> String? {
        guard let token = UserDefaults.standard.string(forKey: key(for: portal))?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty else {
            return nil
        }
        return token
    }

    static func store(_ token: String, for portal: URL) throws {
        let value = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            throw NSError(
                domain: "NibCredentialStore",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "The Nib credential is empty."]
            )
        }
        UserDefaults.standard.set(value, forKey: key(for: portal))
    }

    @discardableResult
    static func remove(for portal: URL) -> Bool {
        UserDefaults.standard.removeObject(forKey: key(for: portal))
        return true
    }

    private static func key(for portal: URL) -> String {
        var value = (portal.host() ?? portal.absoluteString).lowercased()
        if let port = portal.port { value += ":\(port)" }
        return keyPrefix + value
    }
}

struct NibAuthStatus: Decodable, Hashable {
    struct Account: Decodable, Hashable {
        var id: String
        var email: String
    }

    struct Session: Decodable, Hashable {
        var id: String
        var name: String
        var platform: String
    }

    var authenticated: Bool
    var account: Account
    var session: Session
    var kind: String { "session" }
    var subject: String { account.id }
    var name: String { session.name }
    var platform: String { session.platform }
    var scopes: [String] { [] }
}

struct NibAuthLogout: Codable, Hashable {
    var revoked: Bool
}

struct NibAccountDeletion: Codable, Hashable {
    var deleted: Bool
}

struct NibPendingSignIn: Codable, Hashable {
    var challengeId: String
    var verifier: String
    var expiresAt: Date
    var email: String
}

@MainActor
final class NibClient: ObservableObject {
    let baseURL: URL
    private let session: URLSession

    init(baseURL: URL = URL(string: NibDefaults.defaultBaseURLString)!, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func authStatus() async throws -> NibAuthStatus {
        try await get("/api/auth/session")
    }

    func beginEmailSignIn(email: String, name: String, platform: String) async throws -> NibPendingSignIn {
        let verifier = Self.pkceVerifier()
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()
        let response: NibAuthChallenge = try await postUnauthenticated(
            "/api/auth/challenges",
            body: NibAuthChallengeBody(
                email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                pkceChallenge: challenge,
                platform: platform,
                deviceName: name
            )
        )
        return NibPendingSignIn(
            challengeId: response.challengeId,
            verifier: verifier,
            expiresAt: ISO8601DateFormatter().date(from: response.expiresAt) ?? Date().addingTimeInterval(600),
            email: email.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    func pollEmailSignIn(_ pending: NibPendingSignIn) async throws -> NibAuthStatus? {
        var request = URLRequest(url: url("/api/auth/challenges/\(pending.challengeId)/token"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(NibAuthTokenBody(verifier: pending.verifier))
        let (data, response) = try await session.data(for: request)
        if (response as? HTTPURLResponse)?.statusCode == 202 { return nil }
        try validate(response: response, data: data)
        let issued = try JSONDecoder().decode(NibIssuedCredential.self, from: data)
        try NibCredentialStore.store(issued.token, for: baseURL)
        return try await authStatus()
    }

    func redeemEmailSignInCode(_ code: String, pending: NibPendingSignIn) async throws -> NibAuthStatus {
        let _: NibAuthVerification = try await postUnauthenticated(
            "/api/auth/challenges/\(pending.challengeId)/verify",
            body: NibAuthCodeBody(code: code)
        )
        guard let status = try await pollEmailSignIn(pending) else {
            throw NSError(
                domain: "NibClient",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "The sign-in code could not be completed."]
            )
        }
        return status
    }

    func logout() async throws -> NibAuthLogout {
        defer { NibCredentialStore.remove(for: baseURL) }
        return try await post("/api/auth/logout", body: EmptyBody())
    }

    func deleteAccount() async throws -> NibAccountDeletion {
        defer { NibCredentialStore.remove(for: baseURL) }
        var request = URLRequest(url: url("/api/account"))
        request.httpMethod = "DELETE"
        authorize(&request)
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder().decode(NibAccountDeletion.self, from: data)
    }

    func requests() async throws -> [NibRequest] {
        try await get("/api/requests")
    }

    func request(id: String) async throws -> NibRequest {
        try await get("/api/requests/\(id)")
    }

    func requestEvents() -> AsyncThrowingStream<NibRequestSocketEvent, Error> {
        AsyncThrowingStream { continuation in
            guard let socketURL = webSocketURL("/api/requests/socket") else {
                continuation.finish(throwing: NSError(
                    domain: "NibClient",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Request WebSocket URL is invalid"]
                ))
                return
            }

            var request = URLRequest(url: socketURL)
            authorize(&request)
            let socket = session.webSocketTask(with: request)
            socket.resume()
            let receiveTask = Task {
                do {
                    while !Task.isCancelled {
                        let message = try await socket.receive()
                        let data: Data
                        switch message {
                        case .data(let value):
                            data = value
                        case .string(let value):
                            data = Data(value.utf8)
                        @unknown default:
                            continue
                        }
                        continuation.yield(try JSONDecoder().decode(NibRequestSocketEvent.self, from: data))
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { _ in
                receiveTask.cancel()
                socket.cancel(with: .goingAway, reason: nil)
            }
        }
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
                    authorize(&request)
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
        annotations: [NibReviewAnnotation]? = nil,
        idempotencyKey: String = UUID().uuidString
    ) async throws -> NibRequest {
        try await post(
            "/api/requests/\(requestId)/respond",
            body: ResponseBody(
                text: text,
                choice: choice,
                choiceIndex: choiceIndex,
                decision: decision,
                comment: comment,
                annotations: annotations,
                deviceId: NibDefaults.registeredDeviceID,
                idempotencyKey: idempotencyKey
            ),
            headers: ["idempotency-key": idempotencyKey]
        )
    }

    func registerDevice(
        name: String,
        token: String,
        platform: String,
        apnsTopic: String?,
        apnsEnvironment: String? = NibNotificationContract.apnsEnvironment,
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
                apnsEnvironment: apnsEnvironment,
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

    func uploadResponseVideo(requestId: String, name: String, data: Data) async throws -> NibRequest.Attachment {
        var request = URLRequest(url: url("/api/requests/\(requestId)/response-attachments"))
        request.httpMethod = "POST"
        request.setValue("video/mp4", forHTTPHeaderField: "content-type")
        request.setValue(name, forHTTPHeaderField: "x-nib-filename")
        authorize(&request)
        let (responseData, response) = try await session.upload(for: request, from: data)
        try validate(response: response, data: responseData)
        return try JSONDecoder().decode(NibRequest.Attachment.self, from: responseData)
    }

    func absoluteURL(_ value: String?) -> URL? {
        guard let value, !value.isEmpty else { return nil }
        return URL(string: value, relativeTo: baseURL)?.absoluteURL
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        var request = URLRequest(url: url(path))
        authorize(&request)
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func post<T: Decodable, Body: Encodable>(
        _ path: String,
        body: Body,
        headers: [String: String] = [:]
    ) async throws -> T {
        var request = URLRequest(url: url(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        request.httpBody = try JSONEncoder().encode(body)
        authorize(&request)
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func postUnauthenticated<T: Decodable, Body: Encodable>(
        _ path: String,
        body: Body,
        bearer: String? = nil
    ) async throws -> T {
        var request = URLRequest(url: url(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        if let bearer, !bearer.isEmpty {
            request.setValue("Bearer \(bearer)", forHTTPHeaderField: "authorization")
        }
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func patch<T: Decodable, Body: Encodable>(_ path: String, body: Body) async throws -> T {
        var request = URLRequest(url: url(path))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        authorize(&request)
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func url(_ path: String) -> URL {
        URL(string: path, relativeTo: baseURL)!.absoluteURL
    }

    private func webSocketURL(_ path: String) -> URL? {
        guard var components = URLComponents(url: url(path), resolvingAgainstBaseURL: false) else {
            return nil
        }
        switch components.scheme?.lowercased() {
        case "https":
            components.scheme = "wss"
        case "http":
            components.scheme = "ws"
        default:
            return nil
        }
        return components.url
    }

    private func authorize(_ request: inout URLRequest) {
        guard let token = NibCredentialStore.token(for: baseURL) else { return }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
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

    private static func pkceVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(status == errSecSuccess, "Secure random generation failed")
        return Data(bytes).base64URLEncodedString()
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
    var deviceId: String?
    var idempotencyKey: String
}

private struct DeviceBody: Encodable {
    var name: String
    var platform: String
    var pushKind: String
    var token: String
    var apnsTopic: String?
    var apnsEnvironment: String?
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

private struct NibAuthChallengeBody: Encodable {
    var email: String
    var pkceChallenge: String
    var platform: String
    var deviceName: String
}

private struct NibAuthChallenge: Decodable {
    var challengeId: String
    var expiresAt: String
}

private struct NibAuthTokenBody: Encodable {
    var verifier: String
}

private struct NibAuthCodeBody: Encodable {
    var code: String
}

private struct NibAuthVerification: Decodable {
    var verified: Bool
}

private struct NibIssuedCredential: Decodable {
    var token: String
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
