import Foundation
import NibDomain

enum NibMacConnectionState: Equatable {
    case loading
    case live
    case reconnecting
}

@MainActor
final class NibMacRequestStore: ObservableObject {
    @Published private(set) var requests: [NibRequest] = []
    @Published private(set) var projects: [NibProject] = []
    @Published private(set) var devices: [NibDevice] = []
    @Published private(set) var activityEvents: [NibActivityEvent] = []
    @Published private(set) var captureArtifacts: [NibMacCaptureArtifact] = []
    @Published private(set) var notificationError: String?
    @Published private(set) var connectionState: NibMacConnectionState = .loading

    let client: NibClient
    private var streamTask: Task<Void, Never>?

    init(client: NibClient? = nil) {
        self.client = client ?? NibClient()
    }

    var activeRequests: [NibRequest] {
        requests.filter(\.isActive)
    }

    var inboxRequests: [NibRequest] {
        activeRequests
    }

    var historyRequests: [NibRequest] {
        requests.filter(\.isMacHistoryItem)
    }

    var badges: NibMacBadgeSnapshot {
        let inboxCount = inboxRequests.count
        let historyCount = historyRequests.count
        return NibMacBadgeSnapshot(
            sidebar: [
                .inbox: inboxCount,
                .history: historyCount
            ],
            dock: inboxCount,
            menuBar: inboxCount
        )
    }

    var captureLibraryItems: [NibLibraryItem] {
        captureArtifacts.map { artifact in
            NibLibraryItem(
                id: artifact.id,
                name: artifact.metadata.fileName,
                contentType: artifact.metadata.contentType,
                bytes: Int64(artifact.metadata.bytes),
                sha256: artifact.metadata.sha256,
                createdAt: artifact.metadata.createdAt,
                status: .queued,
                lineage: nil,
                file: nil,
                upload: nil
            )
        }
    }

    var baseURL: URL {
        client.baseURL
    }

    func start() {
        streamTask?.cancel()
        connectionState = .loading
        streamTask = Task { [weak self] in
            await self?.consumeRequestEvents()
        }
    }

    func stopAndClear() {
        streamTask?.cancel()
        streamTask = nil
        requests = []
        projects = []
        devices = []
        activityEvents = []
        captureArtifacts = []
        notificationError = nil
        connectionState = .loading
    }

    func reload() async {
        do {
            requests = try await client.requests().sorted { $0.updatedAt > $1.updatedAt }
            connectionState = .live
        } catch is CancellationError {
            return
        } catch {
            connectionState = .reconnecting
        }
    }

    func reloadDashboard() async {
        async let nextProjects = loadProjects()
        async let nextDevices = loadDevices()
        async let nextActivity = loadActivity()

        let values = await (nextProjects, nextDevices, nextActivity)
        projects = values.0
        devices = values.1
        activityEvents = values.2
    }

    func reloadAll() async {
        await reload()
        await reloadDashboard()
    }

    func applyPreviewState(
        requests: [NibRequest],
        projects: [NibProject] = [],
        devices: [NibDevice] = [],
        activityEvents: [NibActivityEvent] = [],
        connectionState: NibMacConnectionState = .live
    ) {
        streamTask?.cancel()
        self.requests = requests.sorted { $0.updatedAt > $1.updatedAt }
        self.projects = projects
        self.devices = devices
        self.activityEvents = activityEvents
        self.connectionState = connectionState
    }

    func authStatus() async throws -> NibAuthStatus {
        try await client.authStatus()
    }

    func registerMacPushDevice(token: Data, topic: String?) async {
        let tokenString = token.map { String(format: "%02x", $0) }.joined()
        do {
            let device = try await client.registerDevice(
                name: Host.current().localizedName ?? "Nib Mac",
                token: tokenString,
                platform: "macos",
                apnsTopic: topic,
                capabilities: ["requests", "visual-review", "capture"]
            )
            NibDefaults.rememberRegisteredDevice(device)
            notificationError = nil
            await reloadDashboard()
        } catch {
            notificationError = "Could not register this Mac for Nib notifications: \(error.localizedDescription)"
        }
    }

    func setNotificationRegistrationError(_ error: Error) {
        notificationError = "Could not register this Mac for Nib notifications: \(error.localizedDescription)"
    }

    func respondToNotification(
        requestID: String,
        choiceIndex: Int? = nil,
        text: String? = nil,
        idempotencyKey: String = UUID().uuidString
    ) async throws -> NibRequest {
        let request = try await client.respond(
            requestId: requestID,
            text: text,
            choiceIndex: choiceIndex,
            idempotencyKey: idempotencyKey
        )
        apply(NibRequestSocketEvent(type: "request", action: "responded", request: request))
        return request
    }

    func apply(_ event: NibRequestSocketEvent) {
        guard let request = event.request else { return }
        requests.removeAll { $0.id == request.id }
        requests.append(request)
        requests.sort { $0.updatedAt > $1.updatedAt }
    }

    func recordCaptureArtifact(_ artifact: NibMacCaptureArtifact) {
        captureArtifacts.removeAll { $0.id == artifact.id }
        captureArtifacts.insert(artifact, at: 0)
    }

    func reviewURL(for request: NibRequest) -> URL? {
        if let acceptanceURL = request.acceptanceReviewURL {
            return acceptanceURL
        }
        return URL(string: "/r/\(request.id)", relativeTo: baseURL)?.absoluteURL
    }

    func requestURL(for requestID: String) -> URL? {
        URL(string: "/r/\(requestID)", relativeTo: baseURL)?.absoluteURL
    }

    func projectURL(for project: NibProject) -> URL? {
        URL(string: project.openPath, relativeTo: baseURL)?.absoluteURL
    }

    private func consumeRequestEvents() async {
        var reconnectAttempt = 0
        await reloadAll()

        while !Task.isCancelled {
            await reloadAll()
            do {
                for try await event in client.requestEvents() {
                    try Task.checkCancellation()
                    if event.type == "ready" {
                        reconnectAttempt = 0
                        connectionState = .live
                        await reloadAll()
                    } else if event.type == "request" {
                        apply(event)
                        connectionState = .live
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                connectionState = .reconnecting
            }

            guard !Task.isCancelled else { return }
            connectionState = .reconnecting
            let delay = min(pow(2.0, Double(reconnectAttempt)), 8.0)
            reconnectAttempt += 1
            do {
                try await Task.sleep(for: .seconds(delay + Double.random(in: 0...0.25)))
            } catch {
                return
            }
        }
    }

    private func loadProjects() async -> [NibProject] {
        (try? await client.projects()) ?? projects
    }

    private func loadDevices() async -> [NibDevice] {
        (try? await client.devices()) ?? devices
    }

    private func loadActivity() async -> [NibActivityEvent] {
        (try? await client.activity()) ?? activityEvents
    }
}
