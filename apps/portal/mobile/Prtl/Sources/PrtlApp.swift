import PhotosUI
import SafariServices
import SwiftUI
import UIKit
import UserNotifications
import WebKit

@main
struct PrtlApp: App {
    @UIApplicationDelegateAdaptor(PrtlAppDelegate.self) private var appDelegate
    @StateObject private var client = PrtlClient()
    @AppStorage("prtl.baseURL") private var baseURLString = PrtlDefaults.defaultBaseURLString

    var body: some Scene {
        WindowGroup {
            RequestInboxView(baseURLString: $baseURLString)
                .environmentObject(client)
                .onAppear {
                    client.configure(baseURLString: baseURLString)
                }
                .onChange(of: baseURLString) { _, value in
                    client.configure(baseURLString: value)
                }
        }
    }
}

final class PrtlAppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        PrtlNotificationActions.register()
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        NotificationCenter.default.post(name: .prtlDeviceToken, object: token)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .prtlDeviceRegistrationFailed, object: error.localizedDescription)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        Task {
            await PrtlNotificationActions.handle(response: response)
            completionHandler()
        }
    }
}

extension Notification.Name {
    static let prtlDeviceToken = Notification.Name("prtlDeviceToken")
    static let prtlDeviceRegistrationFailed = Notification.Name("prtlDeviceRegistrationFailed")
    static let prtlOpenRequest = Notification.Name("prtlOpenRequest")
    static let prtlOpenProject = Notification.Name("prtlOpenProject")
    static let prtlOpenWebURL = Notification.Name("prtlOpenWebURL")
}

struct RequestInboxView: View {
    @EnvironmentObject private var client: PrtlClient
    @Binding var baseURLString: String
    @State private var projects: [PrtlProject] = []
    @State private var requests: [PrtlRequest] = []
    @State private var devices: [PrtlDevice] = []
    @State private var notificationStatus: PrtlNotificationStatus?
    @State private var waitingPanes: [PrtlWaitingPane] = []
    @State private var activity: [PrtlActivityEvent] = []
    @State private var error: String?
    @State private var notice: String?
    @State private var showingSettings = false
    @State private var loading = false
    @State private var sendingTestNotification = false
    @State private var navigationPath: [PrtlRequest] = []
    @State private var selectedProject: PrtlProject?
    @State private var safariRoute: SafariRoute?
    @State private var webRoute: WebRoute?
    @AppStorage("prtl.autoRegisteredNotifications") private var autoRegisteredNotifications = false

    private var activeRequests: [PrtlRequest] {
        requests.filter(\.isActive)
    }

    var body: some View {
        NavigationStack(path: $navigationPath) {
            ZStack {
                PrtlTheme.background.ignoresSafeArea()
                List {
                    Section {
                        PrtlStatusSurface(
                            activeCount: activeRequests.count,
                            server: client.baseURL.host() ?? client.baseURL.absoluteString,
                            deviceCount: notificationStatus?.deviceCount ?? devices.count,
                            apnsConfigured: notificationStatus?.apnsConfigured,
                            nativeReady: notificationStatus?.nativeReady,
                            apnsLastError: notificationStatus?.apnsLastError,
                            loading: loading,
                            refresh: { Task { await load() } },
                            configure: { showingSettings = true },
                            register: { Task { await registerForNotifications() } }
                        )
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    }

                    if !devices.isEmpty || notificationStatus != nil {
                        Section {
                            DeviceHealthSurface(
                                devices: devices,
                                status: notificationStatus,
                                sendingTest: sendingTestNotification,
                                sendTest: { Task { await sendTestNotification() } }
                            )
                                .listRowBackground(Color.clear)
                                .listRowSeparator(.hidden)
                        } header: {
                            Text("Devices")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(PrtlTheme.muted)
                        }
                    }

                    if !waitingPanes.isEmpty {
                        Section {
                            WaitingPaneSurface(waitingPanes: waitingPanes)
                                .listRowBackground(Color.clear)
                                .listRowSeparator(.hidden)
                        } header: {
                            Text("Waiting")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(PrtlTheme.muted)
                        }
                    }

                    if !projects.isEmpty {
                        Section {
                            ProjectSurface(projects: projects.prefix(6).map { $0 }) { project in
                                selectedProject = project
                            }
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                        } header: {
                            Text("Projects")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(PrtlTheme.muted)
                        }
                    }

                    Section {
                        ForEach(requests) { request in
                            NavigationLink(value: request) {
                                RequestRow(request: request)
                                    .padding(.vertical, 10)
                            }
                            .listRowBackground(PrtlTheme.surface)
                        }
                    } header: {
                        Text(activeRequests.isEmpty ? "Recent" : "Waiting")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(PrtlTheme.muted)
                    }

                    if !activity.isEmpty {
                        Section {
                            ForEach(activity.prefix(4)) { event in
                                ActivityRow(event: event)
                                    .padding(.vertical, 8)
                                    .listRowBackground(PrtlTheme.surface)
                            }
                        } header: {
                            Text("Activity")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(PrtlTheme.muted)
                        }
                    }
                }
                .scrollContentBackground(.hidden)
                .listStyle(.insetGrouped)
            }
            .navigationTitle("Prtl")
            .toolbarTitleDisplayMode(.large)
            .navigationDestination(for: PrtlRequest.self) { request in
                RequestDetailView(request: request)
            }
            .task {
                if let server = launchArgument("prtl.server") {
                    baseURLString = server
                    client.configure(baseURLString: server)
                }
                await load()
                if !autoRegisteredNotifications, PrtlEntitlements.hasAPSEnvironment {
                    autoRegisteredNotifications = true
                    await registerForNotifications()
                }
                if let requestId = launchArgument("prtl.openRequest") {
                    await openRequest(id: requestId)
                } else if let projectId = launchArgument("prtl.openProject") {
                    await openProject(id: projectId)
                } else {
                    await consumePendingNotificationRoute()
                }
            }
            .refreshable { await load() }
            .sheet(isPresented: $showingSettings) {
                NavigationStack {
                    SettingsView(baseURLString: $baseURLString)
                }
            }
            .sheet(item: $safariRoute) { route in
                SafariView(url: route.url)
            }
            .sheet(item: $webRoute) { route in
                RequestWebContainer(route: route) {
                    safariRoute = SafariRoute(url: route.url)
                }
            }
            .sheet(item: $selectedProject) { project in
                ProjectDetailView(project: project)
            }
            .onReceive(NotificationCenter.default.publisher(for: .prtlDeviceToken)) { payload in
                guard let token = payload.object as? String else { return }
                Task { await registerDevice(token: token) }
            }
            .onReceive(NotificationCenter.default.publisher(for: .prtlDeviceRegistrationFailed)) { payload in
                notice = payload.object as? String ?? "Device registration failed."
            }
            .onReceive(NotificationCenter.default.publisher(for: .prtlOpenRequest)) { payload in
                guard let requestId = payload.object as? String else { return }
                PrtlNotificationActions.clearPendingRequestId(requestId)
                Task { await openRequest(id: requestId) }
            }
            .onReceive(NotificationCenter.default.publisher(for: .prtlOpenProject)) { payload in
                guard let projectId = payload.object as? String else { return }
                PrtlNotificationActions.clearPendingProjectId(projectId)
                Task { await openProject(id: projectId) }
            }
            .onReceive(NotificationCenter.default.publisher(for: .prtlOpenWebURL)) { payload in
                guard let url = payload.object as? URL else { return }
                PrtlNotificationActions.clearPendingWebURL(url)
                webRoute = WebRoute(url: url, title: url.host ?? "prtl")
            }
            .onOpenURL { url in
                open(url: url)
            }
            .overlay(alignment: .bottom) {
                ToastView(message: error ?? notice)
                    .padding(.bottom, 10)
            }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            async let nextProjects = client.projects()
            async let nextRequests = client.requests()
            async let nextDevices = client.devices()
            async let nextNotificationStatus = client.notificationStatus()
            async let nextWaiting = client.waiting()
            async let nextActivity = client.activity()
            projects = try await nextProjects
            requests = try await nextRequests
            devices = try await nextDevices
            notificationStatus = try await nextNotificationStatus
            waitingPanes = try await nextWaiting
            activity = Array(try await nextActivity.prefix(8))
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func registerForNotifications() async {
        guard PrtlEntitlements.hasAPSEnvironment else {
            notice = "This build is missing the APS entitlement. Install a push-signed build to receive lock-screen requests."
            return
        }
        do {
            let center = UNUserNotificationCenter.current()
            let granted = try await center.requestAuthorization(options: [.alert, .badge, .sound])
            guard granted else {
                notice = "Notifications were not allowed."
                return
            }
            await MainActor.run {
                UIApplication.shared.registerForRemoteNotifications()
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func registerDevice(token: String) async {
        do {
            _ = try await client.registerDevice(
                name: UIDevice.current.name,
                token: token,
                platform: "ios",
                apnsTopic: Bundle.main.bundleIdentifier,
                capabilities: ["alert", "actions", "text", "open", "upload"]
            )
            notice = "This iPhone is registered."
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func sendTestNotification() async {
        sendingTestNotification = true
        defer { sendingTestNotification = false }
        do {
            let result = try await client.sendTestNotification()
            notice = result.sent == 1 ? "Sent 1 notification." : "Sent \(result.sent) notifications."
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func openRequest(id: String) async {
        do {
            let request = try await client.request(id: id)
            requests.removeAll { $0.id == request.id }
            requests.insert(request, at: 0)
            navigationPath = [request]
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func open(url: URL) {
        guard url.scheme == "prtl" else { return }
        if let server = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first(where: { $0.name == "server" })?
            .value {
            baseURLString = server
            client.configure(baseURLString: server)
        }
        guard let requestId = requestId(from: url) else {
            if let projectId = projectId(from: url) {
                Task { await openProject(id: projectId) }
                return
            }
            Task { await load() }
            if URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?
                .contains(where: { $0.name == "server" }) == true {
                return
            }
            notice = "Request link is not valid."
            return
        }
        Task { await openRequest(id: requestId) }
    }

    private func openProject(id: String) async {
        do {
            if let project = try await client.project(id: id) {
                selectedProject = project
                error = nil
            } else {
                notice = "Project is not available."
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func consumePendingNotificationRoute() async {
        if let requestId = PrtlNotificationActions.consumePendingRequestId() {
            await openRequest(id: requestId)
            return
        }
        if let projectId = PrtlNotificationActions.consumePendingProjectId() {
            await openProject(id: projectId)
            return
        }
        if let url = PrtlNotificationActions.consumePendingWebURL() {
            webRoute = WebRoute(url: url, title: url.host ?? "prtl")
        }
    }

    private func requestId(from url: URL) -> String? {
        if url.host == "request" || url.host == "requests" {
            return url.pathComponents.dropFirst().first
        }
        if url.host == "open" {
            return URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?
                .first(where: { $0.name == "requestId" || $0.name == "id" })?
                .value
        }
        return nil
    }

    private func projectId(from url: URL) -> String? {
        if url.host == "project" || url.host == "projects" {
            return url.pathComponents.dropFirst().first
        }
        if url.host == "open" {
            return URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?
                .first(where: { $0.name == "projectId" })?
                .value
        }
        return nil
    }

    private func launchArgument(_ name: String) -> String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-\(name)") else { return nil }
        let valueIndex = arguments.index(after: index)
        guard arguments.indices.contains(valueIndex) else { return nil }
        return arguments[valueIndex]
    }

}

struct PrtlStatusSurface: View {
    var activeCount: Int
    var server: String
    var deviceCount: Int
    var apnsConfigured: Bool?
    var nativeReady: Bool?
    var apnsLastError: String?
    var loading: Bool
    var refresh: () -> Void
    var configure: () -> Void
    var register: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(activeCount == 1 ? "1 request waiting" : "\(activeCount) requests waiting")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(PrtlTheme.text)
                    Text(server)
                        .font(.footnote)
                        .foregroundStyle(PrtlTheme.muted)
                        .lineLimit(1)
                    Text(deviceLine)
                        .font(.footnote)
                        .foregroundStyle(PrtlTheme.muted2)
                }
                Spacer()
                if loading {
                    ProgressView()
                }
            }

            HStack(spacing: 10) {
                Button(action: refresh) {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh")
                Button(action: register) {
                    Image(systemName: "bell.badge")
                }
                .accessibilityLabel("Register notifications")
                Button(action: configure) {
                    Image(systemName: "slider.horizontal.3")
                }
                .accessibilityLabel("Server")
            }
            .buttonStyle(PrtlIconButtonStyle())
        }
        .padding(20)
        .background(PrtlTheme.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(PrtlTheme.border)
        )
        .shadow(color: PrtlTheme.shadow, radius: 18, x: 0, y: 12)
    }

    private var deviceLine: String {
        let label = deviceCount == 1 ? "1 device" : "\(deviceCount) devices"
        if let apnsLastError, !apnsLastError.isEmpty {
            return "\(label) · APNs failed"
        }
        if nativeReady == false {
            return "\(label) · APNs not healthy"
        }
        guard let apnsConfigured else { return label }
        return apnsConfigured ? "\(label) · APNs ready" : "\(label) · APNs not configured"
    }
}

struct DeviceHealthSurface: View {
    var devices: [PrtlDevice]
    var status: PrtlNotificationStatus?
    var sendingTest: Bool
    var sendTest: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(summary)
                        .font(.headline)
                        .foregroundStyle(PrtlTheme.text)
                    Text(statusLine)
                        .font(.footnote)
                        .foregroundStyle(PrtlTheme.muted)
                }
                Spacer()
                Circle()
                    .fill(statusDot)
                    .frame(width: 10, height: 10)
            }

            ForEach(devices.prefix(3)) { device in
                HStack(spacing: 10) {
                    Image(systemName: icon(for: device.platform))
                        .foregroundStyle(PrtlTheme.blue)
                        .frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(device.name)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(PrtlTheme.text)
                        Text(deviceDetail(device))
                            .font(.caption)
                            .foregroundStyle(device.lastError == nil ? PrtlTheme.muted : PrtlTheme.amber)
                    }
                    Spacer()
                }
            }

            if let readinessDetail {
                Text(readinessDetail)
                    .font(.caption)
                    .foregroundStyle(PrtlTheme.muted)
                    .lineLimit(2)
            }

            Button(action: sendTest) {
                HStack(spacing: 8) {
                    if sendingTest {
                        ProgressView()
                            .tint(PrtlTheme.text)
                    } else {
                        Image(systemName: "paperplane")
                    }
                    Text(sendingTest ? "Sending" : "Send test")
                    Spacer()
                }
            }
            .buttonStyle(PrtlSecondaryButtonStyle())
            .disabled(sendingTest)
        }
        .padding(18)
        .background(PrtlTheme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(PrtlTheme.border))
    }

    private var summary: String {
        let count = status?.deviceCount ?? devices.count
        return count == 1 ? "1 registered device" : "\(count) registered devices"
    }

    private var statusLine: String {
        guard let status else { return "Checking delivery health" }
        let web = status.subscriptionCount == 1 ? "1 web subscription" : "\(status.subscriptionCount) web subscriptions"
        let nativeCount = status.apnsDeviceCount ?? devices.filter { $0.pushKind == "apns" }.count
        let native = nativeCount == 1 ? "1 native device" : "\(nativeCount) native devices"
        if nativeCount > 0 && status.nativeReady == false {
            return "\(web) · \(native) · APNs failed"
        }
        return status.apnsConfigured ? "\(web) · \(native) · APNs ready" : "\(web) · \(native) · APNs setup needed"
    }

    private var statusDot: Color {
        guard let status else { return PrtlTheme.muted2.opacity(0.6) }
        if status.nativeReady == true || status.webReady == true {
            return status.apnsConfigured || (status.apnsDeviceCount ?? 0) == 0 ? PrtlTheme.green : PrtlTheme.amber
        }
        return PrtlTheme.amber
    }

    private var readinessDetail: String? {
        guard let status else { return nil }
        if let issue = status.apnsIssues?.first, !issue.isEmpty {
            return issue
        }
        if let lastError = status.apnsLastError, !lastError.isEmpty {
            return lastError
        }
        if status.apnsConfigured {
            let environment = status.apnsEnvironment ?? "sandbox"
            if let topic = status.apnsTopic, !topic.isEmpty {
                return "APNs \(environment) · \(topic)"
            }
            return "APNs \(environment)"
        }
        if status.apnsKeyConfigured == false {
            return "Add APNs signing credentials on the server"
        }
        return nil
    }

    private func icon(for platform: String) -> String {
        switch platform {
        case "ios": return "iphone"
        case "watchos": return "applewatch"
        case "macos": return "macbook"
        case "web": return "globe"
        default: return "bell"
        }
    }

    private func deviceDetail(_ device: PrtlDevice) -> String {
        if let error = device.lastError, !error.isEmpty {
            return error
        }
        let capabilityText = device.capabilities.isEmpty ? device.pushKind : device.capabilities.joined(separator: ", ")
        return "\(device.platform) · \(capabilityText)"
    }
}

struct WaitingPaneSurface: View {
    var waitingPanes: [PrtlWaitingPane]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(waitingPanes.count == 1 ? "1 pane blocked" : "\(waitingPanes.count) panes blocked")
                        .font(.headline)
                        .foregroundStyle(PrtlTheme.text)
                    Text("Agents waiting for input")
                        .font(.footnote)
                        .foregroundStyle(PrtlTheme.muted)
                }
                Spacer()
                Image(systemName: "exclamationmark.triangle")
                    .foregroundStyle(PrtlTheme.amber)
            }

            ForEach(waitingPanes.prefix(4)) { pane in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(pane.window)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(PrtlTheme.text)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        Text("\(pane.session):\(pane.paneId)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(PrtlTheme.muted2)
                            .lineLimit(1)
                    }
                    Text(pane.reason)
                        .font(.footnote)
                        .foregroundStyle(PrtlTheme.muted)
                        .lineLimit(2)
                    Text(pane.since)
                        .font(.caption2)
                        .foregroundStyle(PrtlTheme.muted2)
                        .lineLimit(1)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(PrtlTheme.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(PrtlTheme.border))
            }
        }
        .padding(18)
        .background(PrtlTheme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(PrtlTheme.border))
    }
}

struct ProjectSurface: View {
    var projects: [PrtlProject]
    var inspect: (PrtlProject) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(summary)
                        .font(.headline)
                        .foregroundStyle(PrtlTheme.text)
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(PrtlTheme.muted)
                }
                Spacer()
            }

            ForEach(projects) { project in
                Button {
                    inspect(project)
                } label: {
                    HStack(spacing: 12) {
                        Circle()
                            .fill(project.status == "online" ? PrtlTheme.green : PrtlTheme.amber)
                            .frame(width: 9, height: 9)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(project.name)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(PrtlTheme.text)
                                .lineLimit(1)
                            Text(detail(project))
                                .font(.caption)
                                .foregroundStyle(PrtlTheme.muted)
                                .lineLimit(1)
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .foregroundStyle(PrtlTheme.blue)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(18)
        .background(PrtlTheme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(PrtlTheme.border))
    }

    private var summary: String {
        let online = projects.filter { $0.status == "online" }.count
        return online == 1 ? "1 project online" : "\(online) projects online"
    }

    private var subtitle: String {
        projects.count == 1 ? "Open the current target" : "Open current targets"
    }

    private func detail(_ project: PrtlProject) -> String {
        let kind = project.targetKind.replacingOccurrences(of: "-", with: " ")
        if let framework = project.framework, !framework.isEmpty {
            return "\(kind) · \(framework)"
        }
        if let port = project.port {
            return "\(kind) · :\(port)"
        }
        return kind
    }
}

struct ProjectDetailView: View {
    @EnvironmentObject private var client: PrtlClient
    @Environment(\.dismiss) private var dismiss
    @State var project: PrtlProject

    @State private var workspace: PrtlProjectWorkspace?
    @State private var activity: [PrtlActivityEvent] = []
    @State private var commandPresets: [PrtlCommandPreset] = []
    @State private var commandRuns: [PrtlCommandRun] = []
    @State private var commandText = ""
    @State private var noteText = ""
    @State private var loading = false
    @State private var savingNote = false
    @State private var capturingScreenshots = false
    @State private var runningCommand = false
    @State private var recheckingProject = false
    @State private var settingRoute: String?
    @State private var killingProject = false
    @State private var confirmingKill = false
    @State private var error: String?
    @State private var notice: String?
    @State private var safariRoute: SafariRoute?
    @State private var webRoute: WebRoute?
    @State private var commandStreamTask: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Text(project.status)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(project.status == "online" ? PrtlTheme.green : PrtlTheme.amber)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background((project.status == "online" ? PrtlTheme.green : PrtlTheme.amber).opacity(0.12), in: Capsule())
                            Spacer()
                            if let level = project.compatibility?.level {
                                Text(level)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(PrtlTheme.blue)
                            }
                        }

                        Text(project.name)
                            .font(.largeTitle.weight(.semibold))
                            .foregroundStyle(PrtlTheme.text)
                            .textSelection(.enabled)

                        Text(projectDetail)
                            .font(.body)
                            .foregroundStyle(PrtlTheme.muted)
                            .textSelection(.enabled)

                        if let sourcePath = project.sourcePath, !sourcePath.isEmpty {
                            Text(sourcePath)
                                .font(.caption)
                                .foregroundStyle(PrtlTheme.muted2)
                                .lineLimit(2)
                                .textSelection(.enabled)
                        }
                    }
                    .padding(22)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(PrtlTheme.surface, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).stroke(PrtlTheme.border))

                    HStack(spacing: 10) {
                        Button {
                            openWebsite()
                        } label: {
                            Label("Open website", systemImage: "globe")
                        }
                        .buttonStyle(PrtlSecondaryButtonStyle())

                        Button {
                            Task { await captureScreenshots() }
                        } label: {
                            if capturingScreenshots {
                                Label("Capturing", systemImage: "camera.viewfinder")
                            } else {
                                Label("Capture", systemImage: "camera.viewfinder")
                            }
                        }
                        .buttonStyle(PrtlSecondaryButtonStyle())
                        .disabled(capturingScreenshots)
                    }

                    ProjectOperationSurface(
                        project: project,
                        rechecking: recheckingProject,
                        settingRoute: settingRoute,
                        killing: killingProject,
                        recheck: { await recheckProject() },
                        setRoute: { mode in await setPreferredRoute(mode) },
                        kill: { confirmingKill = true }
                    )

                    CommandActionSurface(
                        presets: commandPresets,
                        runs: commandRuns,
                        customCommand: $commandText,
                        running: runningCommand,
                        runPreset: { preset in
                            await runCommand(preset.command, cwd: preset.cwd, clearCustom: false)
                        },
                        runCustom: { command in
                            await runCommand(command, cwd: nil, clearCustom: true)
                        },
                        refresh: {
                            await refreshCommands()
                        }
                    )

                    ScreenshotStatusSurface(screenshots: project.screenshots ?? [:])

                    VStack(alignment: .leading, spacing: 12) {
                        Text("Workspace")
                            .font(.headline)
                            .foregroundStyle(PrtlTheme.text)

                        if let workspace {
                            Text("Drawer \(workspace.viewer.drawer) · \(workspace.viewer.activeTab) · \(workspace.viewer.viewport)")
                                .font(.caption)
                                .foregroundStyle(PrtlTheme.muted)
                        } else if loading {
                            Text("Loading workspace")
                                .font(.caption)
                                .foregroundStyle(PrtlTheme.muted)
                        }

                        TextField("Add a note", text: $noteText, axis: .vertical)
                            .lineLimit(2...5)
                            .textFieldStyle(.plain)
                            .padding(14)
                            .background(PrtlTheme.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(PrtlTheme.border))

                        Button {
                            Task { await saveNote() }
                        } label: {
                            Label(savingNote ? "Saving" : "Save note", systemImage: "square.and.pencil")
                        }
                        .buttonStyle(PrtlSecondaryButtonStyle())
                        .disabled(savingNote || noteText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                        ForEach(workspace?.notes.prefix(3).map { $0 } ?? []) { note in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(note.text)
                                    .font(.subheadline)
                                    .foregroundStyle(PrtlTheme.text)
                                Text(note.createdAt)
                                    .font(.caption)
                                    .foregroundStyle(PrtlTheme.muted2)
                            }
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(PrtlTheme.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        }
                    }
                    .padding(18)
                    .background(PrtlTheme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(PrtlTheme.border))

                    if !activity.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Activity")
                                .font(.headline)
                                .foregroundStyle(PrtlTheme.text)
                            ForEach(activity.prefix(4)) { event in
                                ActivityRow(event: event)
                                    .padding(.vertical, 4)
                            }
                        }
                        .padding(18)
                        .background(PrtlTheme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(PrtlTheme.border))
                    }
                }
                .padding(18)
            }
            .background(PrtlTheme.background.ignoresSafeArea())
            .navigationTitle("Project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await load() }
            .onDisappear(perform: cancelCommandStream)
            .refreshable { await load() }
            .overlay(alignment: .bottom) {
                ToastView(message: error ?? notice)
                    .padding(.bottom, 10)
            }
            .sheet(item: $webRoute) { route in
                RequestWebContainer(route: route) {
                    safariRoute = SafariRoute(url: route.url)
                }
            }
            .sheet(item: $safariRoute) { route in
                SafariView(url: route.url)
            }
            .confirmationDialog(
                "Kill \(project.name)?",
                isPresented: $confirmingKill,
                titleVisibility: .visible
            ) {
                Button("Kill project", role: .destructive) {
                    Task { await killProject() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This asks the prtl server to terminate the backing local process.")
            }
        }
    }

    private var projectDetail: String {
        var parts = [project.targetKind.replacingOccurrences(of: "-", with: " ")]
        if let framework = project.framework, !framework.isEmpty {
            parts.append(framework)
        }
        if let port = project.port {
            parts.append(":\(port)")
        }
        if let code = project.statusCode {
            parts.append("HTTP \(code)")
        }
        return parts.joined(separator: " · ")
    }

    private func openWebsite() {
        guard let url = projectURL else {
            notice = "Project URL is not available."
            return
        }
        webRoute = WebRoute(url: url, title: project.name)
    }

    private var projectURL: URL? {
        if let url = URL(string: project.directUrl), url.scheme != nil {
            return url
        }
        return client.absoluteURL(project.openPath)
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            async let nextWorkspace = client.workspace(projectId: project.id)
            async let nextActivity = client.activity(projectId: project.id)
            workspace = try await nextWorkspace
            activity = try await nextActivity
            if let refreshed = try await client.project(id: project.id) {
                project = refreshed
            }
            await refreshCommands(reportErrors: false)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func saveNote() async {
        let text = noteText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        savingNote = true
        defer { savingNote = false }
        do {
            workspace = try await client.addWorkspaceNote(projectId: project.id, text: text)
            noteText = ""
            notice = "Note saved."
            activity = try await client.activity(projectId: project.id)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func captureScreenshots() async {
        capturingScreenshots = true
        defer { capturingScreenshots = false }
        do {
            let result = try await client.captureScreenshots(projectId: project.id)
            project.screenshots = result.screenshots
            if let refreshed = try await client.project(id: project.id) {
                project = refreshed
            }
            notice = "Screenshots captured."
            activity = try await client.activity(projectId: project.id)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func recheckProject() async {
        recheckingProject = true
        defer { recheckingProject = false }
        do {
            project = try await client.recheckProject(projectId: project.id)
            notice = "Project rechecked."
            error = nil
            activity = try await client.activity(projectId: project.id)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func setPreferredRoute(_ mode: String) async {
        settingRoute = mode
        defer { settingRoute = nil }
        do {
            project = try await client.setPreferredRoute(projectId: project.id, mode: mode)
            notice = "Route updated."
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func killProject() async {
        killingProject = true
        defer { killingProject = false }
        do {
            let result = try await client.killProject(projectId: project.id)
            notice = result.killed ? "Project killed." : "Kill requested."
            error = nil
            if let refreshed = try? await client.recheckProject(projectId: project.id) {
                project = refreshed
            }
            if let nextActivity = try? await client.activity(projectId: project.id) {
                activity = nextActivity
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func refreshCommands(reportErrors: Bool = true) async {
        do {
            async let presets = client.commandPresets(projectId: project.id)
            async let runs = client.commandRuns(projectId: project.id)
            commandPresets = try await presets
            commandRuns = try await runs
            if reportErrors {
                error = nil
            }
        } catch {
            if reportErrors {
                self.error = error.localizedDescription
            }
        }
    }

    private func runCommand(_ command: String, cwd: String?, clearCustom: Bool) async {
        let value = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        runningCommand = true
        defer { runningCommand = false }
        do {
            let run = try await client.runCommand(projectId: project.id, command: value, cwd: cwd)
            commandRuns.removeAll { $0.id == run.id }
            commandRuns.insert(run, at: 0)
            if clearCustom {
                commandText = ""
            }
            notice = "Command started."
            error = nil
            streamCommand(run.id)
            try? await Task.sleep(nanoseconds: 700_000_000)
            await refreshCommands(reportErrors: false)
            activity = try await client.activity(projectId: project.id)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func streamCommand(_ commandId: String) {
        commandStreamTask?.cancel()
        commandStreamTask = Task {
            do {
                for try await event in client.commandEvents(projectId: project.id, commandId: commandId) {
                    applyCommandEvent(event)
                }
                await refreshCommands(reportErrors: false)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func cancelCommandStream() {
        commandStreamTask?.cancel()
        commandStreamTask = nil
    }

    private func applyCommandEvent(_ event: PrtlCommandEvent) {
        switch event.data {
        case .run(let run):
            upsertCommandRun(run)
        case .text(let text):
            appendCommandOutput(commandId: event.commandId, type: event.type, text: text)
        case .message(let message):
            error = message
        case .unknown:
            break
        }
    }

    private func upsertCommandRun(_ run: PrtlCommandRun) {
        commandRuns.removeAll { $0.id == run.id }
        commandRuns.insert(run, at: 0)
    }

    private func appendCommandOutput(commandId: String, type: String, text: String) {
        guard let index = commandRuns.firstIndex(where: { $0.id == commandId }) else { return }
        if type == "stderr" || type == "error" {
            commandRuns[index].stderrTail = tail("\(commandRuns[index].stderrTail)\(text)")
            return
        }
        commandRuns[index].stdoutTail = tail("\(commandRuns[index].stdoutTail)\(text)")
    }

    private func tail(_ value: String, limit: Int = 20_000) -> String {
        guard value.count > limit else { return value }
        return String(value.suffix(limit))
    }
}

struct ProjectOperationSurface: View {
    var project: PrtlProject
    var rechecking: Bool
    var settingRoute: String?
    var killing: Bool
    var recheck: () async -> Void
    var setRoute: (String) async -> Void
    var kill: () -> Void

    private let routeModes = ["direct", "pathProxy", "hostProxy"]

    private var selectedRoute: PrtlRouteInfo? {
        guard let preferred = project.preferredRoute else { return nil }
        return project.routes?[preferred]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Operations")
                    .font(.headline)
                    .foregroundStyle(PrtlTheme.text)
                Spacer()
                Button {
                    Task { await recheck() }
                } label: {
                    Image(systemName: rechecking ? "arrow.triangle.2.circlepath" : "arrow.clockwise")
                }
                .buttonStyle(PrtlIconButtonStyle())
                .disabled(rechecking || settingRoute != nil || killing)
                .accessibilityLabel("Recheck project")
            }

            if let routes = project.routes, !routes.isEmpty {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                    ForEach(routeModes, id: \.self) { mode in
                        let route = routes[mode]
                        let active = project.preferredRoute == mode
                        Button {
                            Task { await setRoute(mode) }
                        } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                HStack(spacing: 6) {
                                    Image(systemName: active ? "checkmark.circle.fill" : "circle")
                                    Text(route?.label ?? routeLabel(mode))
                                        .lineLimit(1)
                                        .minimumScaleFactor(0.78)
                                }
                                Text(routeDetail(route))
                                    .font(.caption2)
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.8)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(PrtlRouteButtonStyle(active: active))
                        .opacity(route?.available == true ? 1 : 0.46)
                        .disabled(route?.available != true || settingRoute != nil || killing)
                    }
                }

                if let selectedRoute {
                    Text(selectedRoute.url)
                        .font(.caption)
                        .foregroundStyle(PrtlTheme.muted2)
                        .lineLimit(1)
                        .textSelection(.enabled)
                }
            }

            if project.killable == true {
                Button {
                    kill()
                } label: {
                    Label(killing ? "Killing" : "Kill project", systemImage: "power")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrtlDangerButtonStyle())
                .disabled(rechecking || settingRoute != nil || killing)
            }
        }
        .padding(18)
        .background(PrtlTheme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(PrtlTheme.border))
    }

    private func routeLabel(_ mode: String) -> String {
        switch mode {
        case "direct": return "Direct"
        case "pathProxy": return "Path proxy"
        case "hostProxy": return "Host proxy"
        default: return mode
        }
    }

    private func routeDetail(_ route: PrtlRouteInfo?) -> String {
        guard let route else { return "Unavailable" }
        if let code = route.statusCode { return "HTTP \(code)" }
        if route.available { return "Available" }
        return route.message ?? "Unavailable"
    }
}

struct CommandActionSurface: View {
    var presets: [PrtlCommandPreset]
    var runs: [PrtlCommandRun]
    @Binding var customCommand: String
    var running: Bool
    var runPreset: (PrtlCommandPreset) async -> Void
    var runCustom: (String) async -> Void
    var refresh: () async -> Void

    private var canRunCustom: Bool {
        !customCommand.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !running
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Actions")
                    .font(.headline)
                    .foregroundStyle(PrtlTheme.text)
                Spacer()
                Button {
                    Task { await refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(PrtlIconButtonStyle())
                .disabled(running)
                .accessibilityLabel("Refresh commands")
            }

            if !presets.isEmpty {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                    ForEach(presets.prefix(4)) { preset in
                        Button {
                            Task { await runPreset(preset) }
                        } label: {
                            Label(preset.label, systemImage: "terminal")
                                .lineLimit(1)
                                .minimumScaleFactor(0.82)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(PrtlSecondaryButtonStyle())
                        .disabled(running)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 10) {
                TextField("Run command", text: $customCommand, axis: .vertical)
                    .lineLimit(1...3)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.system(.subheadline, design: .monospaced))
                    .padding(14)
                    .background(PrtlTheme.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(PrtlTheme.border))

                Button {
                    Task { await runCustom(customCommand) }
                } label: {
                    Label(running ? "Running" : "Run command", systemImage: "play")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrtlPrimaryButtonStyle())
                .disabled(!canRunCustom)
            }

            if !runs.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Recent")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(PrtlTheme.muted)
                    ForEach(runs.prefix(3)) { run in
                        CommandRunRow(run: run)
                    }
                }
            }
        }
        .padding(18)
        .background(PrtlTheme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(PrtlTheme.border))
    }
}

struct CommandRunRow: View {
    var run: PrtlCommandRun

    private var output: String {
        let stderr = run.stderrTail.trimmingCharacters(in: .whitespacesAndNewlines)
        if !stderr.isEmpty { return stderr }
        return run.stdoutTail.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var statusColor: Color {
        switch run.status {
        case "running": return PrtlTheme.blue
        case "exited": return PrtlTheme.green
        default: return PrtlTheme.amber
        }
    }

    private var statusText: String {
        if run.status == "running" { return "running" }
        if let exitCode = run.exitCode { return "exit \(exitCode)" }
        if let signal = run.signal { return signal }
        return run.status
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 8, height: 8)
                Text(run.command)
                    .font(.system(.subheadline, design: .monospaced).weight(.semibold))
                    .foregroundStyle(PrtlTheme.text)
                    .lineLimit(2)
                Spacer(minLength: 8)
                Text(statusText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(statusColor)
            }

            Text(run.cwd)
                .font(.caption2)
                .foregroundStyle(PrtlTheme.muted2)
                .lineLimit(1)

            if !output.isEmpty {
                Text(output)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(run.stderrTail.isEmpty ? PrtlTheme.muted : PrtlTheme.amber)
                    .lineLimit(4)
                    .textSelection(.enabled)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PrtlTheme.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(PrtlTheme.border.opacity(0.8)))
    }
}

struct ScreenshotStatusSurface: View {
    var screenshots: [String: PrtlScreenshotInfo]

    private let viewports = ["phone", "tablet", "desktop"]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Screenshots")
                .font(.headline)
                .foregroundStyle(PrtlTheme.text)
            HStack(spacing: 8) {
                ForEach(viewports, id: \.self) { viewport in
                    let info = screenshots[viewport]
                    VStack(alignment: .leading, spacing: 6) {
                        Image(systemName: icon(for: info))
                            .foregroundStyle(color(for: info))
                        Text(viewport.capitalized)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(PrtlTheme.text)
                        Text(detail(for: info))
                            .font(.caption2)
                            .foregroundStyle(PrtlTheme.muted)
                            .lineLimit(2)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(PrtlTheme.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(PrtlTheme.border))
                }
            }
        }
        .padding(18)
        .background(PrtlTheme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(PrtlTheme.border))
    }

    private func icon(for info: PrtlScreenshotInfo?) -> String {
        if info?.error != nil { return "exclamationmark.triangle" }
        if info?.url != nil { return "checkmark.circle" }
        return "circle.dashed"
    }

    private func color(for info: PrtlScreenshotInfo?) -> Color {
        if info?.error != nil { return PrtlTheme.amber }
        if info?.url != nil { return PrtlTheme.green }
        return PrtlTheme.muted2
    }

    private func detail(for info: PrtlScreenshotInfo?) -> String {
        guard let info else { return "Not captured" }
        if let error = info.error, !error.isEmpty { return error }
        if info.url != nil { return "\(info.width)x\(info.height)" }
        return "Waiting"
    }
}

struct ActivityRow: View {
    var event: PrtlActivityEvent

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(PrtlTheme.blue)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 4) {
                Text(event.message)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(PrtlTheme.text)
                Text(event.kind)
                    .font(.caption)
                    .foregroundStyle(PrtlTheme.muted)
            }
        }
    }

    private var icon: String {
        switch event.kind {
        case "feedback": return "bubble.left"
        case "screenshot": return "camera.viewfinder"
        case "command": return "terminal"
        case "note": return "note.text"
        default: return "clock"
        }
    }
}

struct RequestRow: View {
    var request: PrtlRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline) {
                Text(request.title)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(PrtlTheme.text)
                Spacer()
                Text(request.status)
                    .font(.caption)
                    .foregroundStyle(statusColor)
            }
            Text(request.prompt)
                .font(.subheadline)
                .foregroundStyle(PrtlTheme.muted)
                .lineLimit(2)
            if let context = request.context, !context.isEmpty {
                Text(context)
                    .font(.caption)
                    .foregroundStyle(PrtlTheme.muted2)
                    .lineLimit(1)
            }
        }
    }

    private var statusColor: Color {
        switch request.status {
        case "open", "viewed": return PrtlTheme.blue
        case "answered", "acted", "resolved": return PrtlTheme.green
        case "stale", "expired": return PrtlTheme.amber
        default: return PrtlTheme.muted
        }
    }
}

struct RequestDetailView: View {
    @EnvironmentObject private var client: PrtlClient
    @Environment(\.openURL) private var openURL
    @State var request: PrtlRequest
    @State private var reply = ""
    @State private var error: String?
    @State private var notice: String?
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var showingCamera = false
    @State private var safariRoute: SafariRoute?
    @State private var webRoute: WebRoute?
    @State private var sending = false

    private var cameraAvailable: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 12) {
                    Text(request.kind)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(PrtlTheme.blue)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(PrtlTheme.blue.opacity(0.12), in: Capsule())
                    Text(request.title)
                        .font(.largeTitle.weight(.semibold))
                        .foregroundStyle(PrtlTheme.text)
                        .textSelection(.enabled)
                    Text(request.prompt)
                        .font(.body)
                        .foregroundStyle(PrtlTheme.muted)
                        .textSelection(.enabled)
                    if let context = request.context, !context.isEmpty {
                        Text(context)
                            .font(.footnote)
                            .foregroundStyle(PrtlTheme.muted2)
                            .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(22)
                .background(PrtlTheme.surface, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).stroke(PrtlTheme.border))

                if let url = client.absoluteURL(request.target.url) ?? client.absoluteURL(request.target.appPath) {
                    Button {
                        webRoute = WebRoute(url: url, title: request.target.projectName ?? request.title)
                    } label: {
                        Label("Open website", systemImage: "globe")
                    }
                    .buttonStyle(PrtlSecondaryButtonStyle())
                }

                if !request.attachments.isEmpty {
                    AttachmentStrip(request: request)
                }

                HStack(spacing: 10) {
                    PhotosPicker(selection: $selectedPhoto, matching: .images) {
                        Label("Attach image", systemImage: "photo.on.rectangle")
                    }
                    .buttonStyle(PrtlSecondaryButtonStyle())
                    .disabled(sending)
                    .onChange(of: selectedPhoto) { _, item in
                        guard let item else { return }
                        Task { await upload(item: item) }
                    }

                    if cameraAvailable {
                        Button {
                            showingCamera = true
                        } label: {
                            Label("Take photo", systemImage: "camera")
                        }
                        .buttonStyle(PrtlSecondaryButtonStyle())
                        .disabled(sending)
                    }
                }

                if request.isActive {
                    RequestActionSurface(request: request, reply: $reply, sending: sending, respond: respond)
                } else if let response = request.latestResponse {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Answered")
                            .font(.headline)
                        Text(response.choice ?? response.text)
                            .foregroundStyle(PrtlTheme.muted)
                    }
                    .padding(18)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(PrtlTheme.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                }
            }
            .padding(20)
        }
        .background(PrtlTheme.background)
        .navigationTitle("Request")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $safariRoute) { route in
            SafariView(url: route.url)
        }
        .sheet(item: $webRoute) { route in
            RequestWebContainer(route: route) {
                safariRoute = SafariRoute(url: route.url)
            }
        }
        .sheet(isPresented: $showingCamera) {
            CameraCaptureView { image in
                Task { await upload(image: image) }
            }
        }
        .overlay(alignment: .bottom) {
            ToastView(message: error ?? notice)
                .padding(.bottom, 10)
        }
    }

    private func respond(_ payload: RequestResponsePayload) async {
        sending = true
        defer { sending = false }
        do {
            request = try await client.respond(
                requestId: request.id,
                text: payload.text,
                choice: payload.choice,
                choiceIndex: payload.choiceIndex
            )
            reply = ""
            notice = "Response sent."
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func upload(item: PhotosPickerItem) async {
        sending = true
        defer {
            sending = false
            selectedPhoto = nil
        }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else {
                throw NSError(domain: "Prtl", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not read image."])
            }
            try await uploadImageData(data, prefix: "image")
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func upload(image: UIImage) async {
        sending = true
        defer { sending = false }
        do {
            guard let data = image.jpegData(compressionQuality: 0.86) else {
                throw NSError(domain: "Prtl", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not prepare image."])
            }
            try await uploadImageData(data, prefix: "camera")
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func uploadImageData(_ data: Data, prefix: String) async throws {
        let attachment = try await client.uploadImage(
            requestId: request.id,
            name: "\(prefix)-\(Int(Date().timeIntervalSince1970)).jpg",
            contentType: "image/jpeg",
            data: data
        )
        request.attachments.insert(attachment, at: 0)
        notice = "Image attached."
        error = nil
    }
}

struct RequestActionSurface: View {
    var request: PrtlRequest
    @Binding var reply: String
    var sending: Bool
    var respond: (RequestResponsePayload) async -> Void

    var body: some View {
        VStack(spacing: 12) {
            ForEach(Array(request.choices.enumerated()), id: \.offset) { index, choice in
                Button {
                    Task { await respond(RequestResponsePayload(choice: choice, choiceIndex: index)) }
                } label: {
                    HStack {
                        Text(choice)
                        Spacer()
                    }
                }
                .buttonStyle(PrtlPrimaryButtonStyle())
                .disabled(sending)
            }

            if request.allowText {
                VStack(alignment: .leading, spacing: 10) {
                    TextField("Reply", text: $reply, axis: .vertical)
                        .lineLimit(3...6)
                        .padding(14)
                        .background(Color.white.opacity(0.74), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(PrtlTheme.border))
                    Button {
                        let text = reply.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task { await respond(RequestResponsePayload(text: text)) }
                    } label: {
                        Text("Send reply")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PrtlPrimaryButtonStyle())
                    .disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
                }
            }
        }
    }
}

struct RequestResponsePayload {
    var text: String?
    var choice: String?
    var choiceIndex: Int?
}

struct AttachmentStrip: View {
    @EnvironmentObject private var client: PrtlClient
    var request: PrtlRequest

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                ForEach(request.attachments) { attachment in
                    AttachmentTile(attachment: attachment, url: client.absoluteURL(attachment.url))
                }
            }
        }
    }
}

struct AttachmentTile: View {
    var attachment: PrtlRequest.Attachment
    var url: URL?

    private var isImage: Bool {
        attachment.type == "image" || attachment.contentType.hasPrefix("image/")
    }

    private var bytesLabel: String {
        ByteCountFormatter.string(fromByteCount: Int64(attachment.bytes), countStyle: .file)
    }

    var body: some View {
        Group {
            if let url {
                Link(destination: url) {
                    content(url: url)
                }
            } else {
                content(url: nil)
            }
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func content(url: URL?) -> some View {
        if isImage {
            VStack(alignment: .leading, spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(PrtlTheme.background)
                    if let url {
                        AsyncImage(url: url) { phase in
                            switch phase {
                            case .success(let image):
                                image
                                    .resizable()
                                    .scaledToFill()
                            case .failure:
                                Image(systemName: "photo")
                                    .font(.title2)
                                    .foregroundStyle(PrtlTheme.muted)
                            case .empty:
                                ProgressView()
                                    .tint(PrtlTheme.muted)
                            @unknown default:
                                EmptyView()
                            }
                        }
                    } else {
                        Image(systemName: "photo")
                            .font(.title2)
                            .foregroundStyle(PrtlTheme.muted)
                    }
                }
                .frame(width: 188, height: 132)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))

                VStack(alignment: .leading, spacing: 3) {
                    Text(attachment.name)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(PrtlTheme.text)
                        .lineLimit(1)
                    Text(bytesLabel)
                        .font(.caption2)
                        .foregroundStyle(PrtlTheme.muted2)
                }
            }
            .padding(10)
            .frame(width: 208, alignment: .leading)
            .background(PrtlTheme.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(PrtlTheme.border))
            .shadow(color: Color.black.opacity(0.05), radius: 18, y: 10)
        } else {
            HStack(spacing: 10) {
                Image(systemName: "paperclip")
                    .font(.headline)
                    .foregroundStyle(PrtlTheme.muted)
                    .frame(width: 34, height: 34)
                    .background(PrtlTheme.background, in: Circle())
                VStack(alignment: .leading, spacing: 4) {
                    Text(attachment.name)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(PrtlTheme.text)
                        .lineLimit(1)
                    Text(bytesLabel)
                        .font(.caption2)
                        .foregroundStyle(PrtlTheme.muted2)
                }
            }
            .padding(12)
            .frame(width: 188, alignment: .leading)
            .background(PrtlTheme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(PrtlTheme.border))
        }
    }
}

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var baseURLString: String

    var body: some View {
        Form {
            Section {
                TextField("Server URL", text: $baseURLString)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
            } footer: {
                Text("Use the same prtl server URL that web, CLI, and notifications use.")
            }
        }
        .navigationTitle("Server")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
    }
}

struct ToastView: View {
    var message: String?

    var body: some View {
        if let message {
            Text(message)
                .font(.footnote)
                .foregroundStyle(PrtlTheme.text)
                .padding(12)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .padding()
        }
    }
}

struct SafariView: UIViewControllerRepresentable {
    var url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

struct SafariRoute: Identifiable {
    var url: URL
    var id: String { url.absoluteString }
}

struct CameraCaptureView: UIViewControllerRepresentable {
    var onCapture: (UIImage) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = .camera
        controller.cameraCaptureMode = .photo
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture)
    }

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        var onCapture: (UIImage) -> Void

        init(onCapture: @escaping (UIImage) -> Void) {
            self.onCapture = onCapture
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage {
                onCapture(image)
            }
            picker.dismiss(animated: true)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            picker.dismiss(animated: true)
        }
    }
}

struct WebRoute: Identifiable {
    var url: URL
    var title: String
    var id: String { url.absoluteString }
}

struct RequestWebContainer: View {
    @Environment(\.dismiss) private var dismiss
    var route: WebRoute
    var openInSafari: () -> Void

    var body: some View {
        NavigationStack {
            PrtlWebView(url: route.url)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle(route.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { dismiss() }
                    }
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            dismiss()
                            openInSafari()
                        } label: {
                            Image(systemName: "safari")
                        }
                        .accessibilityLabel("Open in Safari")
                    }
                }
        }
    }
}

struct PrtlWebView: UIViewRepresentable {
    var url: URL

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.backgroundColor = UIColor(PrtlTheme.background)
        webView.backgroundColor = UIColor(PrtlTheme.background)
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard webView.url != url else { return }
        webView.load(URLRequest(url: url))
    }
}

enum PrtlNotificationActions {
    static let open = "PRTL_OPEN"
    static let choice0 = "PRTL_CHOICE_0"
    static let choice1 = "PRTL_CHOICE_1"
    static let choice2 = "PRTL_CHOICE_2"
    static let text = "PRTL_TEXT_REPLY"
    private static let pendingRequestKey = "prtl.pendingNotification.requestId"
    private static let pendingProjectKey = "prtl.pendingNotification.projectId"
    private static let pendingURLKey = "prtl.pendingNotification.url"

    static func register() {
        let openAction = UNNotificationAction(identifier: open, title: "Open", options: [.foreground])
        let firstAction = UNNotificationAction(identifier: choice0, title: "First", options: [])
        let secondAction = UNNotificationAction(identifier: choice1, title: "Second", options: [])
        let thirdAction = UNNotificationAction(identifier: choice2, title: "Third", options: [])
        let textAction = UNTextInputNotificationAction(
            identifier: text,
            title: "Reply",
            options: [],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Reply"
        )
        var categories = [
            UNNotificationCategory(identifier: "PRTL_OPEN", actions: [openAction], intentIdentifiers: []),
            choiceCategory("PRTL_APPROVAL", "Approve", "Hold", openAction),
            UNNotificationCategory(identifier: "PRTL_CHOICE", actions: [firstAction, secondAction, thirdAction, textAction, openAction], intentIdentifiers: []),
            UNNotificationCategory(identifier: "PRTL_TEXT", actions: [textAction, openAction], intentIdentifiers: [])
        ]
        categories.append(contentsOf: choiceCategories(openAction: openAction))
        UNUserNotificationCenter.current().setNotificationCategories(Set(categories))
    }

    private static func choiceCategories(openAction: UNNotificationAction) -> [UNNotificationCategory] {
        [
            threeChoiceCategory("PRTL_SHIP_HOLD_REVISE", "Ship", "Hold", "Revise", openAction),
            choiceCategory("PRTL_APPROVE_HOLD", "Approve", "Hold", openAction),
            choiceCategory("PRTL_APPROVE_REJECT", "Approve", "Reject", openAction),
            choiceCategory("PRTL_ALLOW_DENY", "Allow", "Deny", openAction),
            choiceCategory("PRTL_YES_NO", "Yes", "No", openAction),
            choiceCategory("PRTL_SHIP_HOLD", "Ship", "Hold", openAction),
            choiceCategory("PRTL_USE_REVISE", "Use it", "Revise", openAction)
        ]
    }

    private static func choiceCategory(
        _ identifier: String,
        _ firstTitle: String,
        _ secondTitle: String,
        _ openAction: UNNotificationAction
    ) -> UNNotificationCategory {
        UNNotificationCategory(
            identifier: identifier,
            actions: [
                UNNotificationAction(identifier: choice0, title: firstTitle, options: []),
                UNNotificationAction(identifier: choice1, title: secondTitle, options: []),
                openAction
            ],
            intentIdentifiers: []
        )
    }

    private static func threeChoiceCategory(
        _ identifier: String,
        _ firstTitle: String,
        _ secondTitle: String,
        _ thirdTitle: String,
        _ openAction: UNNotificationAction
    ) -> UNNotificationCategory {
        UNNotificationCategory(
            identifier: identifier,
            actions: [
                UNNotificationAction(identifier: choice0, title: firstTitle, options: []),
                UNNotificationAction(identifier: choice1, title: secondTitle, options: []),
                UNNotificationAction(identifier: choice2, title: thirdTitle, options: []),
                openAction
            ],
            intentIdentifiers: []
        )
    }

    static func handle(response: UNNotificationResponse) async {
        let payload = prtlPayload(from: response.notification.request.content.userInfo)
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier || response.actionIdentifier == open {
            guard let requestId = payload["requestId"] as? String else {
                await openPayload(payload)
                return
            }
            storePendingRequestId(requestId)
            await markClicked(requestId: requestId)
            await MainActor.run {
                NotificationCenter.default.post(name: .prtlOpenRequest, object: requestId)
            }
            return
        }
        guard let requestId = payload["requestId"] as? String else {
            await openPayload(payload)
            return
        }
        if response.actionIdentifier == choice0 {
            await respond(requestId: requestId, body: ["choiceIndex": 0, "deviceId": "ios-notification"])
            return
        }
        if response.actionIdentifier == choice1 {
            await respond(requestId: requestId, body: ["choiceIndex": 1, "deviceId": "ios-notification"])
            return
        }
        if response.actionIdentifier == choice2 {
            await respond(requestId: requestId, body: ["choiceIndex": 2, "deviceId": "ios-notification"])
            return
        }
        if response.actionIdentifier == text, let textResponse = response as? UNTextInputNotificationResponse {
            let value = textResponse.userText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else { return }
            await respond(requestId: requestId, body: ["text": value, "deviceId": "ios-notification"])
        }
    }

    private static func openPayload(_ payload: [String: Any]) async {
        if let feedbackId = payload["feedbackId"] as? String, !feedbackId.isEmpty {
            await markFeedbackClicked(feedbackId: feedbackId)
        }
        if let projectId = payload["projectId"] as? String, !projectId.isEmpty {
            storePendingProjectId(projectId)
            await MainActor.run {
                NotificationCenter.default.post(name: .prtlOpenProject, object: projectId)
            }
            return
        }
        if let url = payloadURL(payload) {
            storePendingWebURL(url)
            await MainActor.run {
                NotificationCenter.default.post(name: .prtlOpenWebURL, object: url)
            }
        }
    }

    static func consumePendingRequestId() -> String? {
        consumePendingString(pendingRequestKey)
    }

    static func consumePendingProjectId() -> String? {
        consumePendingString(pendingProjectKey)
    }

    static func consumePendingWebURL() -> URL? {
        guard let value = consumePendingString(pendingURLKey) else { return nil }
        return URL(string: value)
    }

    static func clearPendingRequestId(_ requestId: String) {
        clearPendingString(pendingRequestKey, matching: requestId)
    }

    static func clearPendingProjectId(_ projectId: String) {
        clearPendingString(pendingProjectKey, matching: projectId)
    }

    static func clearPendingWebURL(_ url: URL) {
        clearPendingString(pendingURLKey, matching: url.absoluteString)
    }

    private static func prtlPayload(from userInfo: [AnyHashable: Any]) -> [String: Any] {
        if let payload = userInfo["prtl"] as? [String: Any] {
            return payload
        }
        if let payload = userInfo["prtl"] as? NSDictionary {
            return payload as? [String: Any] ?? [:]
        }
        return userInfo.reduce(into: [String: Any]()) { result, item in
            if let key = item.key as? String {
                result[key] = item.value
            }
        }
    }

    private static func markClicked(requestId: String) async {
        guard let url = endpoint("/api/requests/\(requestId)/notification-click") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        _ = try? await URLSession.shared.data(for: request)
    }

    private static func markFeedbackClicked(feedbackId: String) async {
        guard let url = endpoint("/api/feedback/\(feedbackId)/notification-click") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        _ = try? await URLSession.shared.data(for: request)
    }

    private static func respond(requestId: String, body: [String: Any]) async {
        guard let url = endpoint("/api/requests/\(requestId)/respond"),
              JSONSerialization.isValidJSONObject(body),
              let data = try? JSONSerialization.data(withJSONObject: body)
        else {
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = data
        _ = try? await URLSession.shared.data(for: request)
    }

    private static func endpoint(_ path: String) -> URL? {
        let base = UserDefaults.standard.string(forKey: "prtl.baseURL") ?? PrtlDefaults.defaultBaseURLString
        return URL(string: path, relativeTo: URL(string: base))?.absoluteURL
    }

    private static func payloadURL(_ payload: [String: Any]) -> URL? {
        guard let value = payload["url"] as? String, !value.isEmpty else { return nil }
        return endpoint(value)
    }

    private static func storePendingRequestId(_ requestId: String) {
        UserDefaults.standard.set(requestId, forKey: pendingRequestKey)
    }

    private static func storePendingProjectId(_ projectId: String) {
        UserDefaults.standard.set(projectId, forKey: pendingProjectKey)
    }

    private static func storePendingWebURL(_ url: URL) {
        UserDefaults.standard.set(url.absoluteString, forKey: pendingURLKey)
    }

    private static func consumePendingString(_ key: String) -> String? {
        let defaults = UserDefaults.standard
        guard let value = defaults.string(forKey: key), !value.isEmpty else { return nil }
        defaults.removeObject(forKey: key)
        return value
    }

    private static func clearPendingString(_ key: String, matching value: String) {
        let defaults = UserDefaults.standard
        guard defaults.string(forKey: key) == value else { return }
        defaults.removeObject(forKey: key)
    }
}

enum PrtlTheme {
    static let background = Color(red: 0.956, green: 0.944, blue: 0.918)
    static let surface = Color(red: 0.992, green: 0.984, blue: 0.960)
    static let text = Color(red: 0.142, green: 0.137, blue: 0.123)
    static let muted = Color(red: 0.435, green: 0.416, blue: 0.384)
    static let muted2 = Color(red: 0.568, green: 0.541, blue: 0.502)
    static let border = Color(red: 0.850, green: 0.820, blue: 0.768)
    static let blue = Color(red: 0.350, green: 0.498, blue: 0.600)
    static let green = Color(red: 0.368, green: 0.541, blue: 0.424)
    static let amber = Color(red: 0.718, green: 0.506, blue: 0.239)
    static let shadow = Color.black.opacity(0.08)
}

struct PrtlPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .frame(minHeight: 50)
            .background(
                LinearGradient(
                    colors: [Color(red: 0.220, green: 0.216, blue: 0.200), Color(red: 0.150, green: 0.146, blue: 0.135)],
                    startPoint: .top,
                    endPoint: .bottom
                ),
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

enum PrtlEntitlements {
    static var hasAPSEnvironment: Bool {
        #if targetEnvironment(simulator)
        true
        #else
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1) else {
            return false
        }
        return text.contains("<key>aps-environment</key>")
        #endif
    }
}

struct PrtlSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(PrtlTheme.text)
            .padding(.horizontal, 13)
            .frame(minHeight: 42)
            .background(PrtlTheme.surface, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous).stroke(PrtlTheme.border))
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct PrtlRouteButtonStyle: ButtonStyle {
    var active: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(active ? .white : PrtlTheme.text)
            .padding(12)
            .frame(minHeight: 70)
            .background(
                active
                    ? Color(red: 0.170, green: 0.166, blue: 0.154)
                    : PrtlTheme.background,
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(active ? Color.white.opacity(0.10) : PrtlTheme.border))
            .opacity(configuration.isPressed ? 0.88 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct PrtlDangerButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(PrtlTheme.amber)
            .padding(.horizontal, 16)
            .frame(minHeight: 50)
            .background(PrtlTheme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(PrtlTheme.amber.opacity(0.48)))
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct PrtlIconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.title3.weight(.semibold))
            .foregroundStyle(PrtlTheme.text)
            .frame(width: 58, height: 46)
            .background(PrtlTheme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(PrtlTheme.border))
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
