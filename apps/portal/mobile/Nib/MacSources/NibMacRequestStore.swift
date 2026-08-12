import Foundation

enum NibMacConnectionState: Equatable {
    case loading
    case live
    case reconnecting
    case signedOut
    case sample
}

@MainActor
final class NibMacRequestStore: ObservableObject {
    @Published private(set) var requests: [NibRequest] = []
    @Published private(set) var connectionState: NibMacConnectionState = .loading

    private let client: NibClient
    private var streamTask: Task<Void, Never>?
    private(set) var baseURLString: String

    init(
        baseURLString: String = NibDefaults.defaultBaseURLString,
        client: NibClient? = nil
    ) {
        self.baseURLString = baseURLString
        self.client = client ?? NibClient()
        self.client.configure(baseURLString: baseURLString)
    }

    var activeRequests: [NibRequest] {
        requests.filter(\.isActive)
    }

    var baseURL: URL {
        client.baseURL
    }

    func start(baseURLString: String) {
        let normalized = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return }
        self.baseURLString = normalized
        client.configure(baseURLString: normalized)
        streamTask?.cancel()
        connectionState = .loading
        streamTask = Task { [weak self] in
            guard let self else { return }
            do {
                let status = try await client.authStatus()
                guard status.authenticated else {
                    requests = []
                    connectionState = .signedOut
                    return
                }
                await consumeRequestEvents()
            } catch is CancellationError {
                return
            } catch {
                connectionState = .reconnecting
            }
        }
    }

    func reload() async {
        guard connectionState != .sample else { return }
        do {
            requests = try await client.requests().sorted { $0.updatedAt > $1.updatedAt }
            connectionState = .live
        } catch is CancellationError {
            return
        } catch {
            connectionState = .reconnecting
        }
    }

    func migrateLegacyCredentialIfNeeded() async throws {
        try await client.migrateLegacyCredentialIfNeeded(name: Host.current().localizedName ?? "Nib Mac", platform: "macos")
    }

    func authStatus() async throws -> NibAuthStatus {
        try await client.authStatus()
    }

    func login(open: (URL) -> Void) async throws -> NibAuthStatus {
        try await client.login(
            name: Host.current().localizedName ?? "Nib Mac",
            platform: "macos",
            open: open
        )
    }

    func enterSampleMode() {
        streamTask?.cancel()
        requests = NibSampleData.requests
        connectionState = .sample
    }

    func exitSampleMode() {
        requests = []
        start(baseURLString: baseURLString)
    }

    func completeSampleRequest(id: String) {
        guard connectionState == .sample,
              let index = requests.firstIndex(where: { $0.id == id }) else { return }
        requests[index].status = "responded"
    }

    func apply(_ event: NibRequestSocketEvent) {
        guard let request = event.request else { return }
        requests.removeAll { $0.id == request.id }
        requests.append(request)
        requests.sort { $0.updatedAt > $1.updatedAt }
    }

    func reviewURL(for request: NibRequest) -> URL? {
        URL(string: "/r/\(request.id)", relativeTo: baseURL)?.absoluteURL
    }

    private func consumeRequestEvents() async {
        var reconnectAttempt = 0
        await reload()

        while !Task.isCancelled {
            await reload()
            do {
                for try await event in client.requestEvents() {
                    try Task.checkCancellation()
                    if event.type == "ready" {
                        reconnectAttempt = 0
                        connectionState = .live
                        await reload()
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
}
