import Foundation
import Security

enum NibDefaults {
    static let defaultBaseURLString = "https://app.nibtool.com"
    static let registeredDeviceIDKey = "nib.registeredDeviceID"
    static let authTokenKey = "nib.authToken"
    static let bootstrapAuthTokenKey = "nib.bootstrapAuthToken"

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
    private static let service = "com.douglance.nib.auth"

    static func token(for portal: URL) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(for: portal),
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let token = String(data: data, encoding: .utf8)?
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
                code: Int(errSecParam),
                userInfo: [NSLocalizedDescriptionKey: "The Nib credential is empty."]
            )
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(for: portal)
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw keychainError(updateStatus)
        }
        var item = query
        attributes.forEach { item[$0.key] = $0.value }
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw keychainError(addStatus) }
    }

    @discardableResult
    static func remove(for portal: URL) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(for: portal)
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    private static func account(for portal: URL) -> String {
        var value = (portal.host() ?? portal.absoluteString).lowercased()
        if let port = portal.port { value += ":\(port)" }
        return value
    }

    private static func keychainError(_ status: OSStatus) -> NSError {
        NSError(
            domain: "NibCredentialStore",
            code: Int(status),
            userInfo: [
                NSLocalizedDescriptionKey: SecCopyErrorMessageString(status, nil) as String?
                    ?? "Keychain returned \(status)."
            ]
        )
    }
}

struct NibAuthStatus: Codable, Hashable {
    var authenticated: Bool
    var kind: String
    var subject: String
    var name: String
    var platform: String
    var scopes: [String]
}

struct NibAuthLogout: Codable, Hashable {
    var revoked: Bool
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

    func authStatus() async throws -> NibAuthStatus {
        var request = URLRequest(url: url("/api/account"))
        authorize(&request)
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            return NibAuthStatus(
                authenticated: false,
                kind: "anonymous",
                subject: "",
                name: "",
                platform: "",
                scopes: []
            )
        }
        try validate(response: response, data: data)
        return try JSONDecoder().decode(NibAuthStatus.self, from: data)
    }

    func login(
        name: String,
        platform: String,
        open: (URL) -> Void
    ) async throws -> NibAuthStatus {
        let authorization: NibDeviceAuthorization = try await postUnauthenticated(
            "/api/auth/device/code",
            body: DeviceAuthorizationBody(
                clientID: "nib-apple",
                scope: "reviews:read reviews:write",
                name: "\(name) (\(platform))"
            )
        )
        guard let verificationURL = URL(string: authorization.verificationURIComplete) else {
            throw NSError(
                domain: "NibClient",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Nib returned an invalid sign-in URL."]
            )
        }
        open(verificationURL)
        let token = try await pollDeviceAuthorization(authorization)
        try NibCredentialStore.store(token, for: baseURL)
        return try await authStatus()
    }

    func logout() async throws -> NibAuthLogout {
        defer { NibCredentialStore.remove(for: baseURL) }
        return try await post("/api/auth/logout", body: EmptyBody())
    }

    func migrateLegacyCredentialIfNeeded(name: String, platform: String) async throws {
        guard NibCredentialStore.token(for: baseURL) == nil else { return }
        let defaults = UserDefaults.standard
        _ = name
        _ = platform
        defaults.removeObject(forKey: NibDefaults.authTokenKey)
        defaults.removeObject(forKey: NibDefaults.bootstrapAuthTokenKey)
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
                annotations: annotations,
                deviceId: NibDefaults.registeredDeviceID
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

    private func post<T: Decodable, Body: Encodable>(_ path: String, body: Body) async throws -> T {
        var request = URLRequest(url: url(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
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

    private func pollDeviceAuthorization(_ authorization: NibDeviceAuthorization) async throws -> String {
        let deadline = Date().addingTimeInterval(TimeInterval(authorization.expiresIn))
        var interval = max(authorization.interval, 1)
        while Date() < deadline {
            try await Task.sleep(nanoseconds: UInt64(interval) * 1_000_000_000)
            var request = URLRequest(url: url("/api/auth/device/token"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONEncoder().encode(DeviceTokenBody(
                grantType: "urn:ietf:params:oauth:grant-type:device_code",
                deviceCode: authorization.deviceCode,
                clientID: "nib-apple"
            ))
            let (data, response) = try await session.data(for: request)
            if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                return try JSONDecoder().decode(DeviceTokenResponse.self, from: data).accessToken
            }
            let error = try? JSONDecoder().decode(DeviceAuthorizationError.self, from: data)
            switch error?.error {
            case "authorization_pending":
                continue
            case "slow_down":
                interval += 5
            case "access_denied":
                throw deviceAuthorizationError("Nib sign-in was denied.")
            case "expired_token":
                throw deviceAuthorizationError("Nib sign-in expired.")
            default:
                try validate(response: response, data: data)
            }
        }
        throw deviceAuthorizationError("Nib sign-in expired.")
    }

    private func deviceAuthorizationError(_ message: String) -> NSError {
        NSError(domain: "NibClient", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
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

private struct DeviceAuthorizationBody: Encodable {
    var clientID: String
    var scope: String
    var name: String

    enum CodingKeys: String, CodingKey {
        case clientID = "client_id"
        case scope
        case name
    }
}

private struct NibDeviceAuthorization: Decodable {
    var deviceCode: String
    var verificationURIComplete: String
    var expiresIn: Int
    var interval: Int

    enum CodingKeys: String, CodingKey {
        case deviceCode = "device_code"
        case verificationURIComplete = "verification_uri_complete"
        case expiresIn = "expires_in"
        case interval
    }
}

private struct DeviceTokenBody: Encodable {
    var grantType: String
    var deviceCode: String
    var clientID: String

    enum CodingKeys: String, CodingKey {
        case grantType = "grant_type"
        case deviceCode = "device_code"
        case clientID = "client_id"
    }
}

private struct DeviceTokenResponse: Decodable {
    var accessToken: String

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
    }
}

private struct DeviceAuthorizationError: Decodable {
    var error: String
}
