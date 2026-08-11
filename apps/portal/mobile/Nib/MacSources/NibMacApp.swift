import AppKit
import SwiftUI

@main
struct NibMacApp: App {
    @NSApplicationDelegateAdaptor(NibMacAppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra {
            NibMenuBarRequestsView(store: appDelegate.store)
        } label: {
            NibMacMenuBarLabel(store: appDelegate.store)
        }
        .menuBarExtraStyle(.window)

        Settings {
            NibMacSettingsView(store: appDelegate.store)
        }
    }

}

@MainActor
final class NibMacAppDelegate: NSObject, NSApplicationDelegate {
    let store = NibMacRequestStore(
        baseURLString: UserDefaults.standard.string(forKey: "nib.baseURL")
            ?? NibDefaults.defaultBaseURLString
    )
    let launcher = NibNativeReviewLauncher.shared

    func applicationDidFinishLaunching(_ notification: Notification) {
        Task {
            try? await store.migrateLegacyCredentialIfNeeded()
            store.start(baseURLString: store.baseURLString)
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            guard url.scheme == "nib",
                  url.host == "request",
                  let requestID = url.pathComponents.dropFirst().first,
                  !requestID.isEmpty else {
                continue
            }
            launcher.open(requestID: requestID, portalURL: store.baseURL)
        }
    }
}

private struct NibMacMenuBarLabel: View {
    @ObservedObject var store: NibMacRequestStore

    var body: some View {
        Image(systemName: store.activeRequests.isEmpty
            ? "pencil.tip.crop.circle"
            : "pencil.tip.crop.circle.badge.plus")
            .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        let count = store.activeRequests.count
        return count == 0 ? "Nib, no waiting requests" : "Nib, \(count) waiting requests"
    }
}

private struct NibMenuBarRequestsView: View {
    @ObservedObject var store: NibMacRequestStore
    @ObservedObject private var launcher = NibNativeReviewLauncher.shared
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
            Divider()
            footer
        }
        .frame(width: 380)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "pencil.tip.crop.circle")
                .font(.title3)
            Text("Requests")
                .font(.headline)
            Spacer()
            Circle()
                .fill(store.connectionState == .live ? NibMacTheme.blue : .secondary)
                .frame(width: 8, height: 8)
            Text(connectionLabel)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button {
                Task { await store.reload() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .help("Refresh Requests")
            .keyboardShortcut("r", modifiers: .command)
        }
        .padding(.horizontal, 14)
        .frame(height: 54)
    }

    @ViewBuilder
    private var content: some View {
        if store.connectionState == .reconnecting {
            reconnectingState
        } else if store.activeRequests.isEmpty {
            emptyState
        } else {
            requestList
        }
    }

    private var requestList: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(store.activeRequests.count) waiting")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)

            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(store.activeRequests) { request in
                        Button {
                            open(request)
                        } label: {
                            NibMacRequestRow(request: request)
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button("Open Request") { open(request) }
                                .keyboardShortcut(.return, modifiers: .command)
                            Button("Copy Request Link") { copyLink(for: request) }
                                .keyboardShortcut("c", modifiers: [.command, .shift])
                        }

                        if request.id != store.activeRequests.last?.id {
                            Divider()
                                .padding(.leading, 48)
                        }
                    }
                }
            }
            .frame(maxHeight: 390)
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("Nothing to review", systemImage: "checkmark.circle")
        } description: {
            Text("New requests will appear here on this Mac.")
        }
        .frame(height: 240)
    }

    private var reconnectingState: some View {
        VStack(spacing: 14) {
            Image(systemName: "network.slash")
                .font(.system(size: 34, weight: .regular))
                .foregroundStyle(.secondary)
            Text("Requests are temporarily unavailable")
                .font(.headline)
            Text("Nib will reconnect to your portal automatically.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Retry now") {
                store.start(baseURLString: store.baseURLString)
            }
            .keyboardShortcut("r", modifiers: .command)
            Divider()
            LabeledContent("Portal") {
                Text(store.baseURL.host() ?? store.baseURL.absoluteString)
                    .foregroundStyle(.secondary)
            }
            .font(.subheadline)
        }
        .padding(20)
        .frame(height: 290)
    }

    private var footer: some View {
        VStack(spacing: 6) {
            if let error = launcher.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Button("Open Nib") {
                    NSWorkspace.shared.open(store.baseURL)
                }
                .buttonStyle(.borderless)
                .keyboardShortcut("o", modifiers: .command)
                Spacer()
                Button {
                    openSettings()
                } label: {
                    Image(systemName: "gearshape")
                }
                .buttonStyle(.borderless)
                .help("Nib Settings")
                .keyboardShortcut(",", modifiers: .command)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(minHeight: 48)
    }

    private var connectionLabel: String {
        switch store.connectionState {
        case .loading:
            return "Connecting..."
        case .live:
            return "Live"
        case .reconnecting:
            return "Reconnecting..."
        }
    }

    private func open(_ request: NibRequest) {
        launcher.open(requestID: request.id, portalURL: store.baseURL)
    }

    private func copyLink(for request: NibRequest) {
        guard let url = store.reviewURL(for: request) else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url.absoluteString, forType: .string)
    }
}

private struct NibMacRequestRow: View {
    let request: NibRequest

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(NibMacTheme.blue)
                .frame(width: 24, height: 24)

            VStack(alignment: .leading, spacing: 4) {
                Text(request.title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(request.prompt)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(metadata)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
    }

    private var metadata: String {
        let source = request.source?.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = source.flatMap { $0.isEmpty ? nil : $0 }
            ?? request.target.projectName
            ?? request.kind.replacingOccurrences(of: "-", with: " ")
        return "\(label) · \(relativeTime)"
    }

    private var relativeTime: String {
        guard let date = ISO8601DateFormatter().date(from: request.createdAt) else { return "now" }
        let seconds = max(0, Int(Date().timeIntervalSince(date)))
        if seconds < 60 { return "now" }
        if seconds < 3_600 { return "\(seconds / 60)m" }
        if seconds < 86_400 { return "\(seconds / 3_600)h" }
        return "\(seconds / 86_400)d"
    }

    private var icon: String {
        switch request.kind {
        case "visual-review":
            return "photo"
        case "choice":
            return "list.bullet.circle"
        case "confirmation":
            return "checkmark.circle"
        default:
            return "text.bubble"
        }
    }
}

private struct NibMacSettingsView: View {
    @ObservedObject var store: NibMacRequestStore
    @AppStorage("nib.baseURL") private var baseURLString = NibDefaults.defaultBaseURLString
    @State private var authState = "Checking"
    @State private var authError: String?
    @State private var signingIn = false

    var body: some View {
        Form {
            TextField("Portal URL", text: $baseURLString)
                .textFieldStyle(.roundedBorder)
            LabeledContent("Authentication", value: authState)
            if let authError {
                Text(authError)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            HStack {
                Button(signingIn ? "Waiting for browser..." : "Sign in") {
                    Task { await login() }
                }
                .disabled(signingIn)
                Spacer()
                Button("Apply") {
                    store.start(baseURLString: baseURLString)
                    Task { await refreshAuthStatus() }
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 440)
        .task { await refreshAuthStatus() }
    }

    private func refreshAuthStatus() async {
        store.start(baseURLString: baseURLString)
        do {
            let status = try await store.authStatus()
            authState = status.authenticated ? "Signed in" : "Signed out"
            authError = nil
        } catch {
            authState = "Signed out"
        }
    }

    private func login() async {
        signingIn = true
        defer { signingIn = false }
        store.start(baseURLString: baseURLString)
        do {
            let status = try await store.login { NSWorkspace.shared.open($0) }
            authState = status.authenticated ? "Signed in" : "Signed out"
            authError = nil
        } catch {
            authState = "Signed out"
            authError = error.localizedDescription
        }
    }
}

private enum NibMacTheme {
    static let blue = Color(red: 0, green: 0.47, blue: 0.83)
}
