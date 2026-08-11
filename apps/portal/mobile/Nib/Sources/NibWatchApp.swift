import SwiftUI
import UserNotifications
import WatchKit

@main
struct NibWatchApp: App {
    @WKApplicationDelegateAdaptor(NibWatchDelegate.self) private var delegate
    @StateObject private var client = NibClient()
    @AppStorage("nib.baseURL") private var baseURLString = NibDefaults.defaultBaseURLString

    var body: some Scene {
        WindowGroup {
            WatchRequestListView(baseURLString: $baseURLString)
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

final class NibWatchDelegate: NSObject, WKApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching() {
        NibWatchNotificationActions.register()
        UNUserNotificationCenter.current().delegate = self
    }

    func didRegisterForRemoteNotifications(withDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        NotificationCenter.default.post(name: .nibWatchDeviceToken, object: token)
    }

    func didFailToRegisterForRemoteNotificationsWithError(_ error: Error) {
        NotificationCenter.default.post(name: .nibWatchDeviceRegistrationFailed, object: error.localizedDescription)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        Task { @MainActor in
            await NibWatchNotificationActions.handle(response: response)
            completionHandler()
        }
    }
}

extension Notification.Name {
    static let nibWatchDeviceToken = Notification.Name("nibWatchDeviceToken")
    static let nibWatchDeviceRegistrationFailed = Notification.Name("nibWatchDeviceRegistrationFailed")
    static let nibWatchOpenRequest = Notification.Name("nibWatchOpenRequest")
    static let nibWatchOpenProject = Notification.Name("nibWatchOpenProject")
}

enum WatchTheme {
    static let background = Color(red: 0.063, green: 0.063, blue: 0.063)
    static let surface = Color(red: 0.094, green: 0.094, blue: 0.094)
    static let surfaceSoft = Color(red: 0.173, green: 0.173, blue: 0.173)
    static let text = Color(red: 0.949, green: 0.949, blue: 0.949)
    static let muted = Color(red: 0.800, green: 0.800, blue: 0.800)
    static let blue = Color(red: 0.000, green: 0.471, blue: 0.831)
    static let green = Color(red: 0.180, green: 0.490, blue: 0.196)
    static let amber = Color(red: 0.718, green: 0.475, blue: 0.122)
    static let border = Color.white.opacity(0.14)
}

struct WatchRequestListView: View {
    @EnvironmentObject private var client: NibClient
    @Binding var baseURLString: String
    @State private var projects: [NibProject] = []
    @State private var requests: [NibRequest] = []
    @State private var waitingPanes: [NibWaitingPane] = []
    @State private var error: String?
    @State private var notice: String?
    @State private var showingSettings = false
    @State private var loading = false
    @State private var navigationPath: [NibRequest] = []
    @State private var selectedProject: NibProject?

    private var activeRequests: [NibRequest] {
        requests.filter(\.isActive)
    }

    private var visibleProjects: [NibProject] {
        Array(projects.prefix(4))
    }

    var body: some View {
        NavigationStack(path: $navigationPath) {
            ZStack {
                WatchTheme.background.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        WatchStatusSurface(
                            count: activeRequests.count,
                            projectCount: projects.count,
                            waitingCount: waitingPanes.count,
                            waitingPane: waitingPanes.first,
                            server: client.baseURL.host() ?? client.baseURL.absoluteString,
                            loading: loading,
                            refresh: { Task { await load() } },
                            register: { Task { await registerForNotifications() } },
                            settings: { showingSettings = true }
                        )

                        if !waitingPanes.isEmpty {
                            Text("Waiting")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(WatchTheme.muted)
                                .padding(.top, 2)
                            ForEach(waitingPanes.prefix(3)) { pane in
                                WatchWaitingPaneCard(pane: pane)
                            }
                        }

                        if !visibleProjects.isEmpty {
                            Text("Projects")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(WatchTheme.muted)
                                .padding(.top, 2)
                            ForEach(visibleProjects) { project in
                                NavigationLink {
                                    WatchProjectDetailView(project: project)
                                } label: {
                                    WatchProjectCard(project: project)
                                }
                                .buttonStyle(.plain)
                            }
                        }

                        if !activeRequests.isEmpty {
                            Text("Requests")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(WatchTheme.muted)
                                .padding(.top, 2)
                            ForEach(activeRequests) { request in
                                NavigationLink(value: request) {
                                    WatchRequestCard(request: request)
                                }
                                .buttonStyle(.plain)
                            }
                        } else {
                            WatchNoticeSurface(message: error ?? notice ?? "No active requests.")
                        }
                    }
                    .padding(.horizontal, 2)
                    .padding(.bottom, 8)
                }
            }
            .navigationTitle("Nib")
            .navigationDestination(for: NibRequest.self) { request in
                WatchRequestDetailView(request: request)
            }
            .task {
                if let server = launchArgument("nib.server") {
                    baseURLString = server
                    client.configure(baseURLString: server)
                }
                do {
                    try await client.migrateLegacyCredentialIfNeeded(
                        name: WKInterfaceDevice.current().name,
                        platform: "watchos"
                    )
                } catch {
                    self.error = error.localizedDescription
                }
                await load()
                if NibEntitlements.hasAPSEnvironment {
                    await registerForNotifications()
                }
                if let requestId = launchArgument("nib.openRequest") {
                    await openRequest(id: requestId)
                } else if let projectId = launchArgument("nib.openProject") {
                    await openProject(id: projectId)
                } else {
                    await consumePendingNotificationRoute()
                }
            }
            .sheet(isPresented: $showingSettings) {
                WatchSettingsView(baseURLString: $baseURLString)
            }
            .sheet(item: $selectedProject) { project in
                NavigationStack {
                    WatchProjectDetailView(project: project)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .nibWatchDeviceToken)) { payload in
                guard let token = payload.object as? String else { return }
                Task { await registerDevice(token: token) }
            }
            .onReceive(NotificationCenter.default.publisher(for: .nibWatchDeviceRegistrationFailed)) { payload in
                notice = payload.object as? String ?? "Device registration failed."
            }
            .onReceive(NotificationCenter.default.publisher(for: .nibWatchOpenRequest)) { payload in
                guard let requestId = payload.object as? String else { return }
                NibWatchNotificationActions.clearPendingRequestId(requestId)
                Task { await openRequest(id: requestId) }
            }
            .onReceive(NotificationCenter.default.publisher(for: .nibWatchOpenProject)) { payload in
                guard let projectId = payload.object as? String else { return }
                NibWatchNotificationActions.clearPendingProjectId(projectId)
                Task { await openProject(id: projectId) }
            }
            .onOpenURL { url in
                open(url: url)
            }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            async let nextRequests = client.requests()
            async let nextProjects = client.projects()
            async let nextWaiting = client.waiting()
            requests = try await nextRequests
            projects = try await nextProjects
            waitingPanes = try await nextWaiting
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func registerForNotifications() async {
        guard NibEntitlements.hasAPSEnvironment else {
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
            WKApplication.shared().registerForRemoteNotifications()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func registerDevice(token: String) async {
        do {
            let device = try await client.registerDevice(
                name: WKInterfaceDevice.current().name,
                token: token,
                platform: "watchos",
                apnsTopic: Bundle.main.bundleIdentifier,
                capabilities: ["alert", "actions", "text", "open", "projects", "routes", "recheck", "kill"]
            )
            NibDefaults.rememberRegisteredDevice(device)
            notice = "Watch registered."
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
        if let requestId = NibWatchNotificationActions.consumePendingRequestId() {
            await openRequest(id: requestId)
            return
        }
        if let projectId = NibWatchNotificationActions.consumePendingProjectId() {
            await openProject(id: projectId)
        }
    }

    private func open(url: URL) {
        guard url.scheme == "nib" else { return }
        if let requestId = requestId(from: url) {
            Task { await openRequest(id: requestId) }
            return
        }
        if let projectId = projectId(from: url) {
            Task { await openProject(id: projectId) }
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

struct WatchStatusSurface: View {
    var count: Int
    var projectCount: Int
    var waitingCount: Int
    var waitingPane: NibWaitingPane?
    var server: String
    var loading: Bool
    var refresh: () -> Void
    var register: () -> Void
    var settings: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(count == 0 ? "Clear" : "\(count) waiting")
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(WatchTheme.text)
                    Text(projectCount == 1 ? "1 project" : "\(projectCount) projects")
                        .font(.caption2)
                        .foregroundStyle(WatchTheme.blue)
                    if waitingCount > 0 {
                        Text(waitingCount == 1 ? "1 waiting pane" : "\(waitingCount) waiting panes")
                            .font(.caption2)
                            .foregroundStyle(WatchTheme.amber)
                    }
                    if let waitingPane {
                        Text("\(waitingPane.window): \(waitingPane.reason)")
                            .font(.caption2)
                            .foregroundStyle(WatchTheme.muted)
                            .lineLimit(2)
                    }
                    Text(server)
                        .font(.caption2)
                        .foregroundStyle(WatchTheme.muted)
                        .lineLimit(1)
                }
                Spacer()
                Circle()
                    .fill(count == 0 ? WatchTheme.green : WatchTheme.amber)
                    .frame(width: 8, height: 8)
            }

            HStack(spacing: 7) {
                Button(action: refresh) {
                    Image(systemName: loading ? "arrow.triangle.2.circlepath" : "arrow.clockwise")
                }
                .accessibilityLabel("Refresh")
                Button(action: register) {
                    Image(systemName: "bell.badge")
                }
                .accessibilityLabel("Register notifications")
                Button(action: settings) {
                    Image(systemName: "slider.horizontal.3")
                }
                .accessibilityLabel("Server")
            }
            .buttonStyle(WatchIconButtonStyle())
        }
        .padding(12)
        .background(WatchTheme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(WatchTheme.border))
    }
}

struct WatchRequestCard: View {
    var request: NibRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(request.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(WatchTheme.text)
                .lineLimit(2)
            Text(request.prompt)
                .font(.caption2)
                .foregroundStyle(WatchTheme.muted)
                .lineLimit(3)
            if !request.choices.isEmpty {
                Text(request.choices.prefix(2).joined(separator: " / "))
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(WatchTheme.blue)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(WatchTheme.surfaceSoft, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(WatchTheme.border))
    }
}

struct WatchWaitingPaneCard: View {
    var pane: NibWaitingPane

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(WatchTheme.amber)
                Text(pane.window)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(WatchTheme.text)
                    .lineLimit(1)
            }
            Text(pane.reason)
                .font(.caption2)
                .foregroundStyle(WatchTheme.muted)
                .lineLimit(2)
            Text("\(pane.session):\(pane.paneId)")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(WatchTheme.muted)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(WatchTheme.surfaceSoft, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(WatchTheme.border))
    }
}

struct WatchProjectCard: View {
    var project: NibProject

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                Circle()
                    .fill(project.status == "online" ? WatchTheme.green : WatchTheme.amber)
                    .frame(width: 7, height: 7)
                Text(project.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(WatchTheme.text)
                    .lineLimit(2)
            }
            Text(detail)
                .font(.caption2)
                .foregroundStyle(WatchTheme.muted)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(WatchTheme.surfaceSoft, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(WatchTheme.border))
    }

    private var detail: String {
        var parts = [project.status]
        if let preferred = project.preferredRoute {
            parts.append(preferred.replacingOccurrences(of: "Proxy", with: " proxy"))
        }
        if let port = project.port {
            parts.append(":\(port)")
        }
        if let code = project.statusCode {
            parts.append("HTTP \(code)")
        }
        return parts.joined(separator: " · ")
    }
}

struct WatchNoticeSurface: View {
    var message: String

    var body: some View {
        Text(message)
            .font(.caption)
            .foregroundStyle(WatchTheme.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(WatchTheme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(WatchTheme.border))
    }
}

struct WatchIconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.footnote.weight(.semibold))
            .foregroundStyle(WatchTheme.text)
            .frame(width: 34, height: 30)
            .background(configuration.isPressed ? WatchTheme.surface : WatchTheme.surfaceSoft, in: Capsule())
            .overlay(Capsule().stroke(WatchTheme.border))
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
    }
}

enum NibEntitlements {
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

struct WatchMiniIconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.caption.weight(.semibold))
            .foregroundStyle(WatchTheme.text)
            .frame(width: 26, height: 24)
            .background(configuration.isPressed ? WatchTheme.surface : WatchTheme.surfaceSoft, in: Circle())
            .overlay(Circle().stroke(WatchTheme.border))
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
    }
}

struct WatchProjectDetailView: View {
    @EnvironmentObject private var client: NibClient
    @State var project: NibProject
    @State private var message: String?
    @State private var rechecking = false
    @State private var settingRoute: String?
    @State private var killing = false
    @State private var confirmingKill = false

    private let routeModes = ["pathProxy", "direct", "hostProxy"]

    var body: some View {
        ZStack {
            WatchTheme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 7) {
                            Text(project.status)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(project.status == "online" ? WatchTheme.green : WatchTheme.amber)
                            Spacer()
                            Text(project.compatibility?.level ?? "unknown")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(WatchTheme.blue)
                            Button {
                                Task { await recheckProject() }
                            } label: {
                                Image(systemName: rechecking ? "arrow.triangle.2.circlepath" : "arrow.clockwise")
                            }
                            .buttonStyle(WatchMiniIconButtonStyle())
                            .disabled(rechecking || settingRoute != nil || killing)
                            .accessibilityLabel("Recheck project")
                        }
                        Text(project.name)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(WatchTheme.text)
                            .lineLimit(2)
                        Text(projectDetail)
                            .font(.caption2)
                            .foregroundStyle(WatchTheme.muted)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(WatchTheme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(WatchTheme.border))

                    if let routes = project.routes, !routes.isEmpty {
                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 6) {
                            ForEach(routeModes, id: \.self) { mode in
                                let route = routes[mode]
                                let active = project.preferredRoute == mode
                                Button {
                                    Task { await setPreferredRoute(mode) }
                                } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack(spacing: 5) {
                                            Image(systemName: active ? "checkmark.circle.fill" : "circle")
                                            Text(route?.label ?? routeLabel(mode))
                                                .lineLimit(1)
                                                .minimumScaleFactor(0.78)
                                        }
                                        Text(routeDetail(route))
                                            .font(.caption2)
                                            .foregroundStyle(active ? WatchTheme.background.opacity(0.74) : WatchTheme.muted)
                                            .lineLimit(1)
                                            .minimumScaleFactor(0.78)
                                    }
                                }
                                .buttonStyle(WatchRouteButtonStyle(active: active))
                                .opacity(route?.available == true ? 1 : 0.46)
                                .disabled(route?.available != true || settingRoute != nil || killing)
                            }
                        }
                    }

                    if project.killable == true {
                        Button {
                            confirmingKill = true
                        } label: {
                            Label(killing ? "Killing" : "Kill project", systemImage: "power")
                        }
                        .buttonStyle(WatchDangerButtonStyle())
                        .disabled(rechecking || settingRoute != nil || killing)
                    }

                    if let message {
                        WatchNoticeSurface(message: message)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 2)
                .padding(.bottom, 8)
            }
        }
        .navigationTitle("Project")
        .confirmationDialog("Kill \(project.name)?", isPresented: $confirmingKill, titleVisibility: .visible) {
            Button("Kill project", role: .destructive) {
                Task { await killProject() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This terminates the backing local process through the nib server.")
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

    private func recheckProject() async {
        rechecking = true
        defer { rechecking = false }
        do {
            project = try await client.recheckProject(projectId: project.id)
            message = "Rechecked."
        } catch {
            message = error.localizedDescription
        }
    }

    private func setPreferredRoute(_ mode: String) async {
        settingRoute = mode
        defer { settingRoute = nil }
        do {
            project = try await client.setPreferredRoute(projectId: project.id, mode: mode)
            message = "Route updated."
        } catch {
            message = error.localizedDescription
        }
    }

    private func killProject() async {
        killing = true
        defer { killing = false }
        do {
            let result = try await client.killProject(projectId: project.id)
            message = result.killed ? "Project killed." : "Kill requested."
            if let refreshed = try? await client.recheckProject(projectId: project.id) {
                project = refreshed
            }
        } catch {
            message = error.localizedDescription
        }
    }

    private func routeLabel(_ mode: String) -> String {
        switch mode {
        case "direct": return "Direct"
        case "pathProxy": return "Proxy"
        case "hostProxy": return "Host proxy"
        default: return mode
        }
    }

    private func routeDetail(_ route: NibRouteInfo?) -> String {
        guard let route else { return "Unavailable" }
        if let code = route.statusCode {
            return "HTTP \(code)"
        }
        return route.message ?? (route.available ? "Available" : "Unavailable")
    }
}

struct WatchRequestDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var client: NibClient
    @State var request: NibRequest
    @State private var reply = ""
    @State private var message: String?
    @State private var sending = false
    @State private var inspectingImage = ProcessInfo.processInfo.arguments.contains("-nib.inspectImage")

    var body: some View {
        ZStack {
            WatchTheme.background.ignoresSafeArea()
            if request.kind == "visual-review" {
                if inspectingImage, let imageURL = visualReviewImageURL {
                    WatchImageInspectionView(url: imageURL) {
                        inspectingImage = false
                    }
                } else {
                    visualReview
                }
            } else {
                standardRequest
            }
        }
        .navigationTitle("Request")
    }

    private var visualReview: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    dismiss()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                        Text("Request")
                    }
                }
                .buttonStyle(.plain)
                .font(.headline.weight(.semibold))
                .foregroundStyle(WatchTheme.blue)
                .padding(.horizontal, 10)

                Text(request.prompt)
                    .font(.caption)
                    .foregroundStyle(WatchTheme.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)

                if let imageURL = visualReviewImageURL {
                    Button {
                        inspectingImage = true
                    } label: {
                        WatchReviewImagePreview(url: imageURL)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Inspect review image")
                    .accessibilityHint("Opens zoom and pan controls")
                    .padding(.horizontal, 4)
                } else {
                    ContentUnavailableView(
                        "No preview",
                        systemImage: "photo",
                        description: Text("Open this review on iPhone or Mac.")
                    )
                    .frame(height: 180)
                }

                if request.isActive {
                    HStack(spacing: 6) {
                        Button("Reject") {
                            Task { await respond(decision: "reject") }
                        }
                        .buttonStyle(WatchDecisionButtonStyle(color: .red))

                        Button("Approve") {
                            Task { await respond(decision: "approve") }
                        }
                        .buttonStyle(WatchDecisionButtonStyle(color: .green))
                    }
                    .disabled(sending)
                } else if let response = request.latestResponse {
                    WatchNoticeSurface(message: response.choice ?? response.text)
                }

                if let message {
                    Text(message)
                        .font(.caption2)
                        .foregroundStyle(WatchTheme.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, 2)
            .padding(.top, 14)
            .padding(.bottom, 8)
        }
        .scrollIndicators(.visible)
        .overlay(alignment: .topTrailing) {
            Capsule()
                .fill(WatchTheme.muted.opacity(0.55))
                .frame(width: 3, height: 40)
                .padding(.top, 28)
                .padding(.trailing, 2)
        }
        .ignoresSafeArea(edges: .top)
        .toolbar(.hidden, for: .navigationBar)
    }

    private var visualReviewImageURL: URL? {
        client.absoluteURL(request.visualReviewImage?.url)
    }

    private var standardRequest: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(request.title)
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(WatchTheme.text)
                    Text(request.prompt)
                        .font(.footnote)
                        .foregroundStyle(WatchTheme.muted)
                    if let context = request.context, !context.isEmpty {
                        Text(context)
                            .font(.caption2)
                            .foregroundStyle(WatchTheme.muted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(WatchTheme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(WatchTheme.border))

                ForEach(Array(request.choices.enumerated()), id: \.offset) { index, choice in
                    Button(choice) {
                        Task { await respond(choice: choice, index: index) }
                    }
                    .buttonStyle(WatchChoiceButtonStyle())
                    .disabled(sending || !request.isActive)
                }

                if request.allowText && request.isActive {
                    TextField("Reply", text: $reply)
                    Button("Send") {
                        Task { await respond(text: reply) }
                    }
                    .buttonStyle(WatchChoiceButtonStyle())
                    .disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
                }

                if let message {
                    WatchNoticeSurface(message: message)
                } else if !request.isActive, let response = request.latestResponse {
                    WatchNoticeSurface(message: response.choice ?? response.text)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 2)
            .padding(.bottom, 8)
        }
    }

    private func respond(decision: String) async {
        sending = true
        defer { sending = false }
        do {
            request = try await client.respond(requestId: request.id, decision: decision, annotations: [])
            message = "Sent."
        } catch {
            message = error.localizedDescription
        }
    }

    private func respond(choice: String, index: Int) async {
        sending = true
        defer { sending = false }
        do {
            request = try await client.respond(requestId: request.id, choice: choice, choiceIndex: index)
            message = "Sent."
        } catch {
            message = error.localizedDescription
        }
    }

    private func respond(text: String) async {
        sending = true
        defer { sending = false }
        do {
            request = try await client.respond(requestId: request.id, text: text)
            reply = ""
            message = "Sent."
        } catch {
            message = error.localizedDescription
        }
    }
}

struct WatchReviewImagePreview: View {
    let url: URL

    var body: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .empty:
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .success(let image):
                image
                    .resizable()
                    .scaledToFill()
            case .failure:
                ContentUnavailableView("Preview unavailable", systemImage: "photo.badge.exclamationmark")
            @unknown default:
                EmptyView()
            }
        }
        .frame(height: 110)
        .frame(maxWidth: .infinity)
        .clipped()
        .background(Color.black)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(WatchTheme.border))
        .overlay {
            Text("Tap to inspect")
                .font(.caption.weight(.medium))
                .foregroundStyle(WatchTheme.text)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.black.opacity(0.68), in: Capsule())
        }
    }
}

struct WatchImageInspectionView: View {
    let url: URL
    let onDone: () -> Void

    private var startsZoomedForVisualTest: Bool {
        ProcessInfo.processInfo.arguments.contains("-nib.zoomed")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Button("Done", action: onDone)
                .buttonStyle(.plain)
                .font(.headline.weight(.semibold))
                .foregroundStyle(WatchTheme.blue)

            WatchZoomableImage(
                url: url,
                initialZoom: startsZoomedForVisualTest ? 2 : 1,
                initialOffset: startsZoomedForVisualTest ? CGSize(width: -50, height: -70) : .zero
            )
            .frame(height: 138)
        }
        .padding(.horizontal, 2)
        .padding(.top, 12)
        .padding(.bottom, 4)
        .ignoresSafeArea(edges: .top)
        .toolbar(.hidden, for: .navigationBar)
    }
}

struct WatchZoomableImage: View {
    let url: URL

    @State private var loadedImage: UIImage?
    @State private var loadFailed = false
    @State private var zoom: Double
    @State private var offset: CGSize
    @State private var settledOffset: CGSize
    @FocusState private var crownFocused: Bool

    init(url: URL, initialZoom: Double = 1, initialOffset: CGSize = .zero) {
        self.url = url
        _zoom = State(initialValue: initialZoom)
        _offset = State(initialValue: initialOffset)
        _settledOffset = State(initialValue: initialOffset)
    }

    var body: some View {
        GeometryReader { proxy in
            if let loadedImage {
                let imageSize = renderedSize(for: loadedImage.size, in: proxy.size)
                Image(uiImage: loadedImage)
                    .resizable()
                    .frame(
                        width: imageSize.width * zoom,
                        height: imageSize.height * zoom
                    )
                    .offset(offset)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .gesture(panGesture(imageSize: imageSize, viewportSize: proxy.size))
            } else if loadFailed {
                ContentUnavailableView("Preview unavailable", systemImage: "photo.badge.exclamationmark")
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .background(Color.black, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(WatchTheme.border))
        .overlay(alignment: .topTrailing) {
            HStack(spacing: 4) {
                Text(String(format: "%.1fx", zoom))
                    .monospacedDigit()
                Image(systemName: "digitalcrown.horizontal.arrow.clockwise")
            }
                .font(.caption2)
                .foregroundStyle(WatchTheme.text)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(.black.opacity(0.65), in: Capsule())
                .padding(5)
        }
        .focusable()
        .focused($crownFocused)
        .digitalCrownRotation(
            $zoom,
            from: 1,
            through: 4,
            by: 0.1,
            sensitivity: .medium,
            isContinuous: false,
            isHapticFeedbackEnabled: true
        )
        .onAppear { crownFocused = true }
        .task(id: url) {
            do {
                let (data, _) = try await URLSession.shared.data(from: url)
                loadedImage = UIImage(data: data)
                loadFailed = loadedImage == nil
            } catch {
                loadFailed = true
            }
        }
        .onChange(of: zoom) { _, value in
            if value <= 1 {
                settledOffset = offset
            }
        }
    }

    private func panGesture(imageSize: CGSize, viewportSize: CGSize) -> some Gesture {
        DragGesture()
            .onChanged { value in
                offset = clamped(
                    CGSize(
                        width: settledOffset.width + value.translation.width,
                        height: settledOffset.height + value.translation.height
                    ),
                    imageSize: imageSize,
                    viewportSize: viewportSize
                )
            }
            .onEnded { _ in
                settledOffset = offset
            }
    }

    private func renderedSize(for imageSize: CGSize, in viewportSize: CGSize) -> CGSize {
        guard imageSize.width > 0, imageSize.height > 0 else { return viewportSize }
        let scale = max(viewportSize.width / imageSize.width, viewportSize.height / imageSize.height)
        return CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
    }

    private func clamped(_ proposed: CGSize, imageSize: CGSize, viewportSize: CGSize) -> CGSize {
        let horizontalLimit = max(0, (imageSize.width * zoom - viewportSize.width) / 2)
        let verticalLimit = max(0, (imageSize.height * zoom - viewportSize.height) / 2)
        return CGSize(
            width: min(max(proposed.width, -horizontalLimit), horizontalLimit),
            height: min(max(proposed.height, -verticalLimit), verticalLimit)
        )
    }
}

struct WatchDecisionButtonStyle: ButtonStyle {
    let color: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 7)
            .background(color.opacity(configuration.isPressed ? 0.35 : 0.22), in: Capsule())
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
    }
}

struct WatchChoiceButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.footnote.weight(.semibold))
            .foregroundStyle(WatchTheme.text)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                configuration.isPressed ? WatchTheme.surface : WatchTheme.surfaceSoft,
                in: RoundedRectangle(cornerRadius: 15, style: .continuous)
            )
            .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(WatchTheme.border))
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
    }
}

struct WatchRouteButtonStyle: ButtonStyle {
    var active: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.caption.weight(.semibold))
            .foregroundStyle(active ? WatchTheme.background : WatchTheme.text)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 9)
            .padding(.vertical, 8)
            .background(
                active
                    ? WatchTheme.text
                    : (configuration.isPressed ? WatchTheme.surface : WatchTheme.surfaceSoft),
                in: RoundedRectangle(cornerRadius: 15, style: .continuous)
            )
            .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(active ? Color.white.opacity(0.14) : WatchTheme.border))
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
    }
}

struct WatchDangerButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.footnote.weight(.semibold))
            .foregroundStyle(WatchTheme.amber)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(configuration.isPressed ? WatchTheme.surfaceSoft : WatchTheme.surface, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(WatchTheme.amber.opacity(0.55)))
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
    }
}

struct WatchSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @EnvironmentObject private var client: NibClient
    @Binding var baseURLString: String
    @State private var authState = "Checking"
    @State private var authError: String?
    @State private var signingIn = false

    var body: some View {
        NavigationStack {
            Form {
                TextField("Server URL", text: $baseURLString)
                    .textInputAutocapitalization(.never)
                Text(authState)
                    .foregroundStyle(.secondary)
                Button(signingIn ? "Waiting for browser..." : "Sign in") {
                    Task { await login() }
                }
                .disabled(signingIn)
                if let authError {
                    Text(authError)
                        .font(.caption2)
                        .foregroundStyle(.red)
                }
            }
            .navigationTitle("Server")
            .task { await refreshAuthStatus() }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func refreshAuthStatus() async {
        client.configure(baseURLString: baseURLString)
        do {
            let status = try await client.authStatus()
            authState = status.authenticated ? "Signed in" : "Signed out"
        } catch {
            authState = "Signed out"
        }
    }

    private func login() async {
        signingIn = true
        defer { signingIn = false }
        client.configure(baseURLString: baseURLString)
        do {
            let status = try await client.login(
                name: WKInterfaceDevice.current().name,
                platform: "watchos",
                open: { openURL($0) }
            )
            authState = status.authenticated ? "Signed in" : "Signed out"
            authError = nil
        } catch {
            authState = "Signed out"
            authError = error.localizedDescription
        }
    }
}

@MainActor
enum NibWatchNotificationActions {
    static let open = "NIB_OPEN"
    static let choice0 = "NIB_CHOICE_0"
    static let choice1 = "NIB_CHOICE_1"
    static let choice2 = "NIB_CHOICE_2"
    static let text = "NIB_TEXT_REPLY"
    private static let pendingRequestKey = "nib.pendingNotification.requestId"
    private static let pendingProjectKey = "nib.pendingNotification.projectId"

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
            UNNotificationCategory(identifier: "NIB_OPEN", actions: [openAction], intentIdentifiers: []),
            choiceCategory("NIB_APPROVAL", "Approve", "Hold", openAction),
            UNNotificationCategory(identifier: "NIB_CHOICE", actions: [firstAction, secondAction, thirdAction, textAction, openAction], intentIdentifiers: []),
            UNNotificationCategory(identifier: "NIB_TEXT", actions: [textAction, openAction], intentIdentifiers: [])
        ]
        categories.append(contentsOf: choiceCategories(openAction: openAction))
        UNUserNotificationCenter.current().setNotificationCategories(Set(categories))
    }

    private static func choiceCategories(openAction: UNNotificationAction) -> [UNNotificationCategory] {
        [
            threeChoiceCategory("NIB_SHIP_HOLD_REVISE", "Ship", "Hold", "Revise", openAction),
            choiceCategory("NIB_APPROVE_HOLD", "Approve", "Hold", openAction),
            choiceCategory("NIB_APPROVE_REJECT", "Approve", "Reject", openAction),
            choiceCategory("NIB_ALLOW_DENY", "Allow", "Deny", openAction),
            choiceCategory("NIB_YES_NO", "Yes", "No", openAction),
            choiceCategory("NIB_SHIP_HOLD", "Ship", "Hold", openAction),
            choiceCategory("NIB_USE_REVISE", "Use it", "Revise", openAction)
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
        let payload = nibPayload(from: response.notification.request.content.userInfo)
        if let deviceId = payload["deviceId"] as? String, !deviceId.isEmpty {
            NibDefaults.rememberRegisteredDeviceID(deviceId)
        }
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier || response.actionIdentifier == open {
            guard let requestId = payload["requestId"] as? String else {
                await openPayload(payload)
                return
            }
            storePendingRequestId(requestId)
            await markClicked(requestId: requestId)
            await MainActor.run {
                NotificationCenter.default.post(name: .nibWatchOpenRequest, object: requestId)
            }
            return
        }
        guard let requestId = payload["requestId"] as? String else {
            await openPayload(payload)
            return
        }
        let deviceId = payload["deviceId"] as? String ?? "watch-notification"
        let isVisualReview = payload["type"] as? String == "visual-review"
        if response.actionIdentifier == choice0 {
            let body: [String: Any] = isVisualReview
                ? ["decision": "approve", "annotations": [], "deviceId": deviceId, "notificationResponse": true]
                : ["choiceIndex": 0, "deviceId": deviceId, "notificationResponse": true]
            await respond(requestId: requestId, body: body)
            return
        }
        if response.actionIdentifier == choice1 {
            let body: [String: Any] = isVisualReview
                ? ["decision": "reject", "annotations": [], "deviceId": deviceId, "notificationResponse": true]
                : ["choiceIndex": 1, "deviceId": deviceId, "notificationResponse": true]
            await respond(requestId: requestId, body: body)
            return
        }
        if response.actionIdentifier == choice2 {
            await respond(
                requestId: requestId,
                body: ["choiceIndex": 2, "deviceId": deviceId, "notificationResponse": true]
            )
            return
        }
        if response.actionIdentifier == text, let textResponse = response as? UNTextInputNotificationResponse {
            let value = textResponse.userText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else { return }
            let body: [String: Any] = isVisualReview
                ? [
                    "decision": "comment",
                    "comment": value,
                    "annotations": [],
                    "deviceId": deviceId,
                    "notificationResponse": true
                ]
                : ["text": value, "deviceId": deviceId, "notificationResponse": true]
            await respond(requestId: requestId, body: body)
        }
    }

    private static func openPayload(_ payload: [String: Any]) async {
        if let feedbackId = payload["feedbackId"] as? String, !feedbackId.isEmpty {
            await markFeedbackClicked(feedbackId: feedbackId)
        }
        guard let projectId = payload["projectId"] as? String, !projectId.isEmpty else { return }
        storePendingProjectId(projectId)
        await MainActor.run {
            NotificationCenter.default.post(name: .nibWatchOpenProject, object: projectId)
        }
    }

    static func consumePendingRequestId() -> String? {
        consumePendingString(pendingRequestKey)
    }

    static func consumePendingProjectId() -> String? {
        consumePendingString(pendingProjectKey)
    }

    static func clearPendingRequestId(_ requestId: String) {
        clearPendingString(pendingRequestKey, matching: requestId)
    }

    static func clearPendingProjectId(_ projectId: String) {
        clearPendingString(pendingProjectKey, matching: projectId)
    }

    private static func nibPayload(from userInfo: [AnyHashable: Any]) -> [String: Any] {
        if let payload = userInfo["nib"] as? [String: Any] {
            return payload
        }
        if let payload = userInfo["nib"] as? NSDictionary {
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
        authorize(&request)
        _ = try? await URLSession.shared.data(for: request)
    }

    private static func markFeedbackClicked(feedbackId: String) async {
        guard let url = endpoint("/api/feedback/\(feedbackId)/notification-click") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        authorize(&request)
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
        authorize(&request)
        _ = try? await URLSession.shared.data(for: request)
    }

    private static func endpoint(_ path: String) -> URL? {
        let base = UserDefaults.standard.string(forKey: "nib.baseURL") ?? NibDefaults.defaultBaseURLString
        return URL(string: path, relativeTo: URL(string: base))?.absoluteURL
    }

    private static func authorize(_ request: inout URLRequest) {
        guard let url = request.url,
              let portal = URL(string: "/", relativeTo: url)?.absoluteURL,
              let token = NibCredentialStore.token(for: portal) else { return }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    }

    private static func storePendingRequestId(_ requestId: String) {
        UserDefaults.standard.set(requestId, forKey: pendingRequestKey)
    }

    private static func storePendingProjectId(_ projectId: String) {
        UserDefaults.standard.set(projectId, forKey: pendingProjectKey)
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
