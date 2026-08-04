import PhotosUI
import SafariServices
import SwiftUI
import UIKit
import UserNotifications
import WebKit

@main
struct NibApp: App {
    @UIApplicationDelegateAdaptor(NibAppDelegate.self) private var appDelegate
    @StateObject private var client = NibClient()
    @AppStorage("nib.baseURL") private var baseURLString = NibDefaults.defaultBaseURLString
    @AppStorage("nib.darkMode") private var darkMode = false

    var body: some Scene {
        WindowGroup {
            RequestInboxView(baseURLString: $baseURLString)
                .environmentObject(client)
                .preferredColorScheme(darkMode ? .dark : .light)
                .onAppear {
                    client.configure(baseURLString: baseURLString)
                }
                .onChange(of: baseURLString) { _, value in
                    client.configure(baseURLString: value)
                }
        }
    }
}

final class NibAppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        NibNotificationActions.register()
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        NotificationCenter.default.post(name: .nibDeviceToken, object: token)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .nibDeviceRegistrationFailed, object: error.localizedDescription)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        Task {
            await NibNotificationActions.handle(response: response)
            completionHandler()
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }
}

extension Notification.Name {
    static let nibDeviceToken = Notification.Name("nibDeviceToken")
    static let nibDeviceRegistrationFailed = Notification.Name("nibDeviceRegistrationFailed")
    static let nibOpenRequest = Notification.Name("nibOpenRequest")
    static let nibOpenProject = Notification.Name("nibOpenProject")
    static let nibOpenWebURL = Notification.Name("nibOpenWebURL")
}

struct RequestInboxView: View {
    @EnvironmentObject private var client: NibClient
    @Binding var baseURLString: String
    @State private var projects: [NibProject] = []
    @State private var requests: [NibRequest] = []
    @State private var devices: [NibDevice] = []
    @State private var notificationStatus: NibNotificationStatus?
    @State private var waitingPanes: [NibWaitingPane] = []
    @State private var activity: [NibActivityEvent] = []
    @State private var error: String?
    @State private var notice: String?
    @State private var showingSettings = false
    @State private var showingSidebar = false
    @State private var sidebarDestination: NibSidebarDestination?
    @State private var loading = false
    @State private var sendingTestNotification = false
    @State private var selectedRequest: NibRequest?
    @State private var selectedProject: NibProject?
    @State private var safariRoute: SafariRoute?
    @State private var webRoute: WebRoute?
    @GestureState private var sidebarDragTranslation: CGFloat = 0
    @AppStorage("nib.darkMode") private var darkMode = false

    private var activeRequests: [NibRequest] {
        requests.filter(\.isActive)
    }

    private var historyRequests: [NibRequest] {
        requests.filter { !$0.isActive }
    }

    var body: some View {
        NavigationStack {
            GeometryReader { proxy in
                let drawerWidth = min(proxy.size.width * 0.76, 380)
                let drawerProgress = sidebarProgress(drawerWidth: drawerWidth)

                ZStack(alignment: .leading) {
                NibTheme.background.ignoresSafeArea()
                VStack(spacing: 0) {
                    HStack(alignment: .center, spacing: 12) {
                        Button {
                            withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
                                showingSidebar = true
                            }
                        } label: {
                            Image(systemName: "sidebar.left")
                                .font(.title3.weight(.semibold))
                                .frame(width: 44, height: 44)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(NibTheme.text)
                        .accessibilityLabel("Open sidebar")

                        NibWordmark()
                        Spacer()
                    }
                    .padding(.leading, 10)
                    .padding(.trailing, 20)
                    .padding(.top, 8)
                    .padding(.bottom, 18)

                    if activeRequests.isEmpty {
                        ContentUnavailableView {
                            Label("Nothing to review", systemImage: "checkmark.circle")
                        } description: {
                            Text("New actionable requests will appear here.")
                        }
                        .foregroundStyle(NibTheme.text)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                Text("Ready for review")
                                    .font(.largeTitle.weight(.bold))
                                    .foregroundStyle(NibTheme.text)
                                    .padding(.bottom, 18)

                                ForEach(activeRequests) { request in
                                    Button {
                                        selectedRequest = request
                                    } label: {
                                        ActionableRequestRow(request: request)
                                    }
                                    .buttonStyle(.plain)

                                    if request.id != activeRequests.last?.id {
                                        Divider()
                                            .padding(.leading, 52)
                                    }
                                }
                            }
                            .padding(.horizontal, 20)
                            .padding(.bottom, 24)
                        }
                        .refreshable { await load() }
                    }
                }

                if drawerProgress > 0.001 {
                    Color.black.opacity(0.42 * drawerProgress)
                        .ignoresSafeArea()
                        .contentShape(Rectangle())
                        .onTapGesture {
                            withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
                                showingSidebar = false
                            }
                        }
                }

                NibSidebarView(
                    serverName: serverDisplayName,
                    deviceLine: sidebarDeviceLine,
                    darkMode: $darkMode,
                    close: {
                        withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
                            showingSidebar = false
                        }
                    },
                    open: openSidebarDestination,
                    notifications: {
                        showingSidebar = false
                        Task { await registerForNotifications() }
                    },
                    reload: {
                        showingSidebar = false
                        Task { await load() }
                    },
                    settings: {
                        showingSidebar = false
                        showingSettings = true
                    }
                )
                .frame(width: drawerWidth)
                .frame(maxHeight: .infinity)
                .offset(x: -drawerWidth * (1 - drawerProgress))
                .shadow(color: Color.black.opacity(0.22 * drawerProgress), radius: 24, x: 10)
                .allowsHitTesting(drawerProgress > 0.98)
            }
                .contentShape(Rectangle())
                .simultaneousGesture(sidebarDragGesture(drawerWidth: drawerWidth))
                .animation(.spring(response: 0.34, dampingFraction: 0.86), value: showingSidebar)
            }
            .toolbar(.hidden, for: .navigationBar)
            .task {
                if let server = launchArgument("nib.server") {
                    baseURLString = server
                    client.configure(baseURLString: server)
                }
                do {
                    try await client.migrateLegacyCredentialIfNeeded(
                        name: UIDevice.current.name,
                        platform: authPlatform
                    )
                    if let pairingCode = launchArgument("nib.pairingCode") {
                        try await enroll(pairingCode: pairingCode)
                    }
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
            .task(id: baseURLString) {
                await consumeRequestEvents()
            }
            .refreshable { await load() }
            .sheet(isPresented: $showingSettings) {
                NavigationStack {
                    SettingsView(
                        baseURLString: $baseURLString,
                        notificationStatus: notificationStatus,
                        devices: devices,
                        waitingPanes: waitingPanes,
                        sendingTestNotification: sendingTestNotification,
                        registerNotifications: { Task { await registerForNotifications() } },
                        sendTestNotification: { Task { await sendTestNotification() } }
                    )
                }
            }
            .sheet(item: $sidebarDestination) { destination in
                NavigationStack {
                    sidebarContent(destination)
                        .navigationTitle(destination.title)
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Done") { sidebarDestination = nil }
                            }
                        }
                }
            }
            .sheet(item: $selectedRequest, onDismiss: {
                Task { await load() }
            }) { request in
                RequestDetailView(request: Binding(
                    get: { selectedRequest ?? request },
                    set: { selectedRequest = $0 }
                ), onSubmitted: advanceAfterSubmission)
                    .id(selectedRequest?.id ?? request.id)
                    .presentationDetents(
                        request.kind == "visual-review"
                            ? Set([.large])
                            : Set([.medium, .large])
                    )
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(30)
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
            .onReceive(NotificationCenter.default.publisher(for: .nibDeviceToken)) { payload in
                guard let token = payload.object as? String else { return }
                Task { await registerDevice(token: token) }
            }
            .onReceive(NotificationCenter.default.publisher(for: .nibDeviceRegistrationFailed)) { payload in
                notice = payload.object as? String ?? "Device registration failed."
            }
            .onReceive(NotificationCenter.default.publisher(for: .nibOpenRequest)) { payload in
                guard let requestId = payload.object as? String else { return }
                NibNotificationActions.clearPendingRequestId(requestId)
                Task { await openRequest(id: requestId) }
            }
            .onReceive(NotificationCenter.default.publisher(for: .nibOpenProject)) { payload in
                guard let projectId = payload.object as? String else { return }
                NibNotificationActions.clearPendingProjectId(projectId)
                Task { await openProject(id: projectId) }
            }
            .onReceive(NotificationCenter.default.publisher(for: .nibOpenWebURL)) { payload in
                guard let url = payload.object as? URL else { return }
                NibNotificationActions.clearPendingWebURL(url)
                webRoute = WebRoute(url: url, title: url.host ?? "nib")
            }
            .onOpenURL { url in
                open(url: url)
            }
            .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                guard let url = activity.webpageURL else { return }
                open(url: url)
            }
            .overlay(alignment: .bottom) {
                ToastView(message: error ?? notice)
                    .padding(.bottom, 10)
            }
        }
    }

    private func sidebarProgress(drawerWidth: CGFloat) -> CGFloat {
        guard drawerWidth > 0 else { return 0 }
        let restingPosition = showingSidebar ? drawerWidth : 0
        let translation = showingSidebar
            ? min(0, sidebarDragTranslation)
            : max(0, sidebarDragTranslation)
        return min(max((restingPosition + translation) / drawerWidth, 0), 1)
    }

    private func sidebarDragGesture(drawerWidth: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .global)
            .updating($sidebarDragTranslation) { value, state, _ in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                guard showingSidebar || value.startLocation.x <= 28 else { return }
                state = showingSidebar
                    ? min(0, value.translation.width)
                    : max(0, value.translation.width)
            }
            .onEnded { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                guard showingSidebar || value.startLocation.x <= 28 else { return }

                let projected = value.predictedEndTranslation.width
                let shouldOpen: Bool
                if showingSidebar {
                    shouldOpen = value.translation.width > -drawerWidth * 0.28
                        && projected > -drawerWidth * 0.55
                } else {
                    shouldOpen = value.translation.width > drawerWidth * 0.28
                        || projected > drawerWidth * 0.55
                }

                withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
                    showingSidebar = shouldOpen
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

    private func consumeRequestEvents() async {
        var reconnectAttempt = 0
        while !Task.isCancelled {
            do {
                for try await event in client.requestEvents() {
                    try Task.checkCancellation()
                    if event.type == "ready" {
                        reconnectAttempt = 0
                        await refreshRequests()
                    } else if event.type == "request", let request = event.request {
                        applyRequestEvent(
                            request,
                            presentImmediately: event.action == "created" || event.action == "published"
                        )
                        if !request.isActive {
                            await NibNotificationActions.clearDeliveredNotifications(requestId: request.id)
                        }
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                // Reconnect below; the HTTP refresh after the ready frame fills any event gap.
            }

            guard !Task.isCancelled else { return }
            let delay = min(pow(2.0, Double(reconnectAttempt)), 8.0)
            reconnectAttempt += 1
            do {
                try await Task.sleep(for: .seconds(delay + Double.random(in: 0...0.25)))
            } catch {
                return
            }
        }
    }

    private func refreshRequests() async {
        do {
            let nextRequests = try await client.requests()
            requests = nextRequests
            if let selectedRequest,
               let updatedSelection = nextRequests.first(where: { $0.id == selectedRequest.id }) {
                self.selectedRequest = updatedSelection
            }
            for request in nextRequests where !request.isActive {
                await NibNotificationActions.clearDeliveredNotifications(requestId: request.id)
            }
            error = nil
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func applyRequestEvent(_ request: NibRequest, presentImmediately: Bool) {
        requests.removeAll { $0.id == request.id }
        requests.append(request)
        requests.sort { $0.updatedAt > $1.updatedAt }
        if presentImmediately && request.isActive {
            showingSettings = false
            showingSidebar = false
            sidebarDestination = nil
            selectedProject = nil
            safariRoute = nil
            webRoute = nil
            selectedRequest = request
        } else if selectedRequest?.id == request.id {
            selectedRequest = request
        }
    }

    private func advanceAfterSubmission(_ submittedRequest: NibRequest) {
        requests.removeAll { $0.id == submittedRequest.id }
        requests.append(submittedRequest)
        requests.sort { $0.updatedAt > $1.updatedAt }
        selectedRequest = requests.first(where: \.isActive)
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
            await MainActor.run {
                UIApplication.shared.registerForRemoteNotifications()
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func registerDevice(token: String) async {
        do {
            let device = try await client.registerDevice(
                name: UIDevice.current.name,
                token: token,
                platform: {
                    #if os(visionOS)
                    "visionos"
                    #else
                    "ios"
                    #endif
                }(),
                apnsTopic: Bundle.main.bundleIdentifier,
                capabilities: ["alert", "actions", "text", "open", "upload"]
            )
            NibDefaults.rememberRegisteredDevice(device)
            #if os(visionOS)
            notice = "This Apple Vision Pro is registered."
            #else
            notice = "This iPhone is registered."
            #endif
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
            selectedRequest = request
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func open(url: URL) {
        guard let scheme = url.scheme?.lowercased(), ["nib", "http", "https"].contains(scheme) else { return }
        if scheme == "nib", let server = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first(where: { $0.name == "server" })?
            .value {
            baseURLString = server
            client.configure(baseURLString: server)
        }
        if scheme == "nib", url.host == "auth" {
            guard let pairingCode = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?
                .first(where: { $0.name == "code" })?
                .value else {
                notice = "Pairing link is not valid."
                return
            }
            Task {
                do {
                    try await enroll(pairingCode: pairingCode)
                    await load()
                } catch {
                    self.error = error.localizedDescription
                }
            }
            return
        }
        if scheme == "http" || scheme == "https" {
            guard url.host == client.baseURL.host() else { return }
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

    private var authPlatform: String {
        #if os(visionOS)
        "visionos"
        #else
        "ios"
        #endif
    }

    private func enroll(pairingCode: String) async throws {
        _ = try await client.redeemPairing(
            code: pairingCode.trimmingCharacters(in: .whitespacesAndNewlines),
            name: UIDevice.current.name,
            platform: authPlatform
        )
        notice = "This device is paired."
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
        if let requestId = NibNotificationActions.consumePendingRequestId() {
            await openRequest(id: requestId)
            return
        }
        if let projectId = NibNotificationActions.consumePendingProjectId() {
            await openProject(id: projectId)
            return
        }
        if let url = NibNotificationActions.consumePendingWebURL() {
            webRoute = WebRoute(url: url, title: url.host ?? "nib")
        }
    }

    private func requestId(from url: URL) -> String? {
        if ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
           ["r", "requests"].contains(url.pathComponents.dropFirst().first ?? "") {
            return url.pathComponents.dropFirst(2).first
        }
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

    private var serverDisplayName: String {
        guard let host = URL(string: baseURLString)?.host(), !host.isEmpty else {
            return "Nib server"
        }
        let name = host.split(separator: ".").first.map(String.init) ?? host
        return name.capitalized
    }

    private var sidebarDeviceLine: String {
        let deviceName = UIDevice.current.userInterfaceIdiom == .phone ? "iPhone" : UIDevice.current.name
        if let lastError = notificationStatus?.apnsLastError, !lastError.isEmpty {
            return "\(deviceName) · APNs needs attention"
        }
        if notificationStatus?.nativeReady == true {
            return "\(deviceName) · APNs ready"
        }
        if notificationStatus?.apnsConfigured == false {
            return "\(deviceName) · APNs not configured"
        }
        return "\(deviceName) · Connected"
    }

    private func openSidebarDestination(_ destination: NibSidebarDestination) {
        showingSidebar = false
        sidebarDestination = destination
    }

    @ViewBuilder
    private func sidebarContent(_ destination: NibSidebarDestination) -> some View {
        switch destination {
        case .projects:
            ScrollView {
                ProjectSurface(projects: projects) { project in
                    sidebarDestination = nil
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                        selectedProject = project
                    }
                }
                .padding(20)
            }
            .background(NibTheme.background)
        case .devices:
            SidebarDevicesView(devices: devices, status: notificationStatus)
                .background(NibTheme.background)
        case .history:
            if historyRequests.isEmpty {
                ContentUnavailableView("No history yet", systemImage: "clock.arrow.circlepath")
                    .background(NibTheme.background)
            } else {
                List(historyRequests) { request in
                    Button {
                        sidebarDestination = nil
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                            selectedRequest = request
                        }
                    } label: {
                        RequestRow(request: request)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(NibTheme.surface)
                }
                .scrollContentBackground(.hidden)
                .background(NibTheme.background)
            }
        case .activity:
            if activity.isEmpty && waitingPanes.isEmpty {
                ContentUnavailableView("No recent activity", systemImage: "waveform.path.ecg")
                    .background(NibTheme.background)
            } else {
                List {
                    if !waitingPanes.isEmpty {
                        Section("Waiting") {
                            ForEach(waitingPanes) { pane in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(pane.reason)
                                        .font(.subheadline.weight(.semibold))
                                    Text("\(pane.session):\(pane.paneId)")
                                        .font(.caption.monospaced())
                                        .foregroundStyle(NibTheme.muted)
                                }
                                .padding(.vertical, 4)
                            }
                        }
                    }
                    if !activity.isEmpty {
                        Section("Recent") {
                            ForEach(activity) { event in
                                ActivityRow(event: event)
                                    .padding(.vertical, 5)
                            }
                        }
                    }
                }
                .scrollContentBackground(.hidden)
                .background(NibTheme.background)
            }
        }
    }

}

enum NibSidebarDestination: String, Identifiable, CaseIterable {
    case projects
    case devices
    case history
    case activity

    var id: String { rawValue }

    var title: String {
        rawValue.capitalized
    }

    var icon: String {
        switch self {
        case .projects: return "folder"
        case .devices: return "iphone"
        case .history: return "clock"
        case .activity: return "chart.line.uptrend.xyaxis"
        }
    }
}

struct NibWordmark: View {
    var body: some View {
        Text("nib")
            .font(.system(size: 30, weight: .black, design: .rounded))
            .tracking(-1.5)
            .foregroundStyle(NibTheme.text)
            .accessibilityAddTraits(.isHeader)
    }
}

struct ActionableRequestRow: View {
    var request: NibRequest

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(NibTheme.blue)
                .frame(width: 38, height: 38)
                .background(NibTheme.blue.opacity(0.12), in: RoundedRectangle(cornerRadius: 11, style: .continuous))

            VStack(alignment: .leading, spacing: 6) {
                Text(request.title)
                    .font(.headline)
                    .foregroundStyle(NibTheme.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(request.prompt)
                    .font(.subheadline)
                    .foregroundStyle(NibTheme.muted)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(NibTheme.muted2)
                    .lineLimit(1)
            }

            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(NibTheme.muted2)
                .padding(.top, 12)
        }
        .padding(.vertical, 16)
        .contentShape(Rectangle())
    }

    private var detail: String {
        if let projectName = request.target.projectName, !projectName.isEmpty {
            return projectName
        }
        return request.kind.replacingOccurrences(of: "-", with: " ").capitalized
    }

    private var icon: String {
        switch request.kind {
        case "visual-review": return "photo"
        case "choice": return "list.bullet.circle"
        case "confirmation": return "checkmark.circle"
        default: return "text.bubble"
        }
    }
}

struct NibSidebarView: View {
    var serverName: String
    var deviceLine: String
    @Binding var darkMode: Bool
    var close: () -> Void
    var open: (NibSidebarDestination) -> Void
    var notifications: () -> Void
    var reload: () -> Void
    var settings: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                NibWordmark()
                Spacer()
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.body.weight(.semibold))
                        .frame(width: 44, height: 44)
                        .background(NibTheme.surface, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close sidebar")
            }
            .padding(.leading, 20)
            .padding(.trailing, 10)
            .padding(.top, 8)

            HStack(alignment: .top, spacing: 10) {
                Circle()
                    .fill(deviceLine.contains("ready") || deviceLine.contains("Connected") ? NibTheme.green : NibTheme.amber)
                    .frame(width: 9, height: 9)
                    .padding(.top, 5)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Connected to \(serverName)")
                        .font(.subheadline.weight(.semibold))
                    Text(deviceLine)
                        .font(.caption)
                        .foregroundStyle(NibTheme.muted)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .padding(.bottom, 22)

            VStack(spacing: 0) {
                ForEach(Array(NibSidebarDestination.allCases.enumerated()), id: \.element.id) { index, destination in
                    NibSidebarRow(title: destination.title, icon: destination.icon) {
                        open(destination)
                    }
                    if index < NibSidebarDestination.allCases.count - 1 {
                        Divider()
                            .padding(.leading, 50)
                    }
                }
            }
            .padding(.horizontal, 10)

            Spacer(minLength: 20)

            Divider()
                .padding(.horizontal, 20)

            VStack(spacing: 0) {
                NibSidebarRow(title: "Notifications", icon: "bell") {
                    notifications()
                }
                Divider()
                    .padding(.leading, 50)
                NibSidebarRow(title: "Reload", icon: "arrow.clockwise") {
                    reload()
                }
                Divider()
                    .padding(.leading, 50)
                NibSidebarRow(title: "Settings", icon: "gearshape") {
                    settings()
                }
                Toggle(isOn: $darkMode) {
                    Text("Dark Mode")
                        .font(.body.weight(.medium))
                }
                .tint(NibTheme.green)
                .frame(minHeight: 50)
                .padding(.horizontal, 14)
                .background(NibTheme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .padding(.top, 10)
            }
            .padding(.horizontal, 10)
            .padding(.bottom, 18)
        }
        .foregroundStyle(NibTheme.text)
        .background(NibTheme.background.ignoresSafeArea())
        .overlay(alignment: .trailing) {
            Rectangle()
                .fill(NibTheme.border)
                .frame(width: 0.5)
        }
    }
}

struct NibSidebarRow: View {
    var title: String
    var icon: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.body.weight(.medium))
                .frame(maxWidth: .infinity, minHeight: 50, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct SidebarDevicesView: View {
    var devices: [NibDevice]
    var status: NibNotificationStatus?

    var body: some View {
        Group {
            if devices.isEmpty {
                ContentUnavailableView("No devices", systemImage: "iphone.slash")
            } else {
                List(devices) { device in
                    HStack(spacing: 14) {
                        Image(systemName: icon(for: device.platform))
                            .font(.title3)
                            .foregroundStyle(device.lastError == nil ? NibTheme.green : NibTheme.amber)
                            .frame(width: 30)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(device.name)
                                .font(.headline)
                            Text(deviceStatus(device))
                                .font(.caption)
                                .foregroundStyle(device.lastError == nil ? NibTheme.muted : NibTheme.amber)
                        }
                    }
                    .padding(.vertical, 5)
                    .listRowBackground(NibTheme.surface)
                }
                .scrollContentBackground(.hidden)
            }
        }
    }

    private func icon(for platform: String) -> String {
        switch platform {
        case "ios": return "iphone"
        case "macos": return "macbook"
        case "watchos": return "applewatch"
        default: return "display"
        }
    }

    private func deviceStatus(_ device: NibDevice) -> String {
        if let error = device.lastError, !error.isEmpty {
            return "Delivery error"
        }
        if device.pushKind == "apns" {
            return status?.nativeReady == true ? "APNs ready" : "APNs connected"
        }
        return device.platform.capitalized
    }
}

struct NibStatusSurface: View {
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
                        .foregroundStyle(NibTheme.text)
                    Text(server)
                        .font(.footnote)
                        .foregroundStyle(NibTheme.muted)
                        .lineLimit(1)
                    Text(deviceLine)
                        .font(.footnote)
                        .foregroundStyle(NibTheme.muted2)
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
            .buttonStyle(NibIconButtonStyle())
        }
        .padding(20)
        .background(NibTheme.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(NibTheme.border)
        )
        .shadow(color: NibTheme.shadow, radius: 18, x: 0, y: 12)
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
    var devices: [NibDevice]
    var status: NibNotificationStatus?
    var sendingTest: Bool
    var sendTest: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(summary)
                        .font(.headline)
                        .foregroundStyle(NibTheme.text)
                    Text(statusLine)
                        .font(.footnote)
                        .foregroundStyle(NibTheme.muted)
                }
                Spacer()
                Circle()
                    .fill(statusDot)
                    .frame(width: 10, height: 10)
            }

            ForEach(devices.prefix(3)) { device in
                HStack(spacing: 10) {
                    Image(systemName: icon(for: device.platform))
                        .foregroundStyle(NibTheme.blue)
                        .frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(device.name)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(NibTheme.text)
                        Text(deviceDetail(device))
                            .font(.caption)
                            .foregroundStyle(device.lastError == nil ? NibTheme.muted : NibTheme.amber)
                    }
                    Spacer()
                }
            }

            if let readinessDetail {
                Text(readinessDetail)
                    .font(.caption)
                    .foregroundStyle(NibTheme.muted)
                    .lineLimit(2)
            }

            Button(action: sendTest) {
                HStack(spacing: 8) {
                    if sendingTest {
                        ProgressView()
                            .tint(NibTheme.text)
                    } else {
                        Image(systemName: "paperplane")
                    }
                    Text(sendingTest ? "Sending" : "Send test")
                    Spacer()
                }
            }
            .buttonStyle(NibSecondaryButtonStyle())
            .disabled(sendingTest)
        }
        .padding(18)
        .background(NibTheme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(NibTheme.border))
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
        guard let status else { return NibTheme.muted2.opacity(0.6) }
        if status.nativeReady == true || status.webReady == true {
            return status.apnsConfigured || (status.apnsDeviceCount ?? 0) == 0 ? NibTheme.green : NibTheme.amber
        }
        return NibTheme.amber
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

    private func deviceDetail(_ device: NibDevice) -> String {
        if let error = device.lastError, !error.isEmpty {
            return error
        }
        let capabilityText = device.capabilities.isEmpty ? device.pushKind : device.capabilities.joined(separator: ", ")
        return "\(device.platform) · \(capabilityText)"
    }
}

struct WaitingPaneSurface: View {
    var waitingPanes: [NibWaitingPane]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(waitingPanes.count == 1 ? "1 pane blocked" : "\(waitingPanes.count) panes blocked")
                        .font(.headline)
                        .foregroundStyle(NibTheme.text)
                    Text("Agents waiting for input")
                        .font(.footnote)
                        .foregroundStyle(NibTheme.muted)
                }
                Spacer()
                Image(systemName: "exclamationmark.triangle")
                    .foregroundStyle(NibTheme.amber)
            }

            ForEach(waitingPanes.prefix(4)) { pane in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(pane.window)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(NibTheme.text)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        Text("\(pane.session):\(pane.paneId)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(NibTheme.muted2)
                            .lineLimit(1)
                    }
                    Text(pane.reason)
                        .font(.footnote)
                        .foregroundStyle(NibTheme.muted)
                        .lineLimit(2)
                    Text(pane.since)
                        .font(.caption2)
                        .foregroundStyle(NibTheme.muted2)
                        .lineLimit(1)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(NibTheme.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(NibTheme.border))
            }
        }
        .padding(18)
        .background(NibTheme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(NibTheme.border))
    }
}

struct ProjectSurface: View {
    var projects: [NibProject]
    var inspect: (NibProject) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(summary)
                        .font(.headline)
                        .foregroundStyle(NibTheme.text)
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(NibTheme.muted)
                }
                Spacer()
            }

            ForEach(projects) { project in
                Button {
                    inspect(project)
                } label: {
                    HStack(spacing: 12) {
                        Circle()
                            .fill(project.status == "online" ? NibTheme.green : NibTheme.amber)
                            .frame(width: 9, height: 9)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(project.name)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(NibTheme.text)
                                .lineLimit(1)
                            Text(detail(project))
                                .font(.caption)
                                .foregroundStyle(NibTheme.muted)
                                .lineLimit(1)
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .foregroundStyle(NibTheme.blue)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(18)
        .background(NibTheme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(NibTheme.border))
    }

    private var summary: String {
        let online = projects.filter { $0.status == "online" }.count
        return online == 1 ? "1 project online" : "\(online) projects online"
    }

    private var subtitle: String {
        projects.count == 1 ? "Open the current target" : "Open current targets"
    }

    private func detail(_ project: NibProject) -> String {
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
    @EnvironmentObject private var client: NibClient
    @Environment(\.dismiss) private var dismiss
    @State var project: NibProject

    @State private var workspace: NibProjectWorkspace?
    @State private var activity: [NibActivityEvent] = []
    @State private var commandPresets: [NibCommandPreset] = []
    @State private var commandRuns: [NibCommandRun] = []
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
                                .foregroundStyle(project.status == "online" ? NibTheme.green : NibTheme.amber)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background((project.status == "online" ? NibTheme.green : NibTheme.amber).opacity(0.12), in: Capsule())
                            Spacer()
                            if let level = project.compatibility?.level {
                                Text(level)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(NibTheme.blue)
                            }
                        }

                        Text(project.name)
                            .font(.largeTitle.weight(.semibold))
                            .foregroundStyle(NibTheme.text)
                            .textSelection(.enabled)

                        Text(projectDetail)
                            .font(.body)
                            .foregroundStyle(NibTheme.muted)
                            .textSelection(.enabled)

                        if let sourcePath = project.sourcePath, !sourcePath.isEmpty {
                            Text(sourcePath)
                                .font(.caption)
                                .foregroundStyle(NibTheme.muted2)
                                .lineLimit(2)
                                .textSelection(.enabled)
                        }
                    }
                    .padding(22)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(NibTheme.surface, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).stroke(NibTheme.border))

                    HStack(spacing: 10) {
                        Button {
                            openWebsite()
                        } label: {
                            Label("Open website", systemImage: "globe")
                        }
                        .buttonStyle(NibSecondaryButtonStyle())

                        Button {
                            Task { await captureScreenshots() }
                        } label: {
                            if capturingScreenshots {
                                Label("Capturing", systemImage: "camera.viewfinder")
                            } else {
                                Label("Capture", systemImage: "camera.viewfinder")
                            }
                        }
                        .buttonStyle(NibSecondaryButtonStyle())
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
                            .foregroundStyle(NibTheme.text)

                        if let workspace {
                            Text("Drawer \(workspace.viewer.drawer) · \(workspace.viewer.activeTab) · \(workspace.viewer.viewport)")
                                .font(.caption)
                                .foregroundStyle(NibTheme.muted)
                        } else if loading {
                            Text("Loading workspace")
                                .font(.caption)
                                .foregroundStyle(NibTheme.muted)
                        }

                        TextField("Add a note", text: $noteText, axis: .vertical)
                            .lineLimit(2...5)
                            .textFieldStyle(.plain)
                            .padding(14)
                            .background(NibTheme.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(NibTheme.border))

                        Button {
                            Task { await saveNote() }
                        } label: {
                            Label(savingNote ? "Saving" : "Save note", systemImage: "square.and.pencil")
                        }
                        .buttonStyle(NibSecondaryButtonStyle())
                        .disabled(savingNote || noteText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                        ForEach(workspace?.notes.prefix(3).map { $0 } ?? []) { note in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(note.text)
                                    .font(.subheadline)
                                    .foregroundStyle(NibTheme.text)
                                Text(note.createdAt)
                                    .font(.caption)
                                    .foregroundStyle(NibTheme.muted2)
                            }
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(NibTheme.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        }
                    }
                    .padding(18)
                    .background(NibTheme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(NibTheme.border))

                    if !activity.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Activity")
                                .font(.headline)
                                .foregroundStyle(NibTheme.text)
                            ForEach(activity.prefix(4)) { event in
                                ActivityRow(event: event)
                                    .padding(.vertical, 4)
                            }
                        }
                        .padding(18)
                        .background(NibTheme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(NibTheme.border))
                    }
                }
                .padding(18)
            }
            .background(NibTheme.background.ignoresSafeArea())
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
                Text("This asks the nib server to terminate the backing local process.")
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

    private func applyCommandEvent(_ event: NibCommandEvent) {
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

    private func upsertCommandRun(_ run: NibCommandRun) {
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
    var project: NibProject
    var rechecking: Bool
    var settingRoute: String?
    var killing: Bool
    var recheck: () async -> Void
    var setRoute: (String) async -> Void
    var kill: () -> Void

    private let routeModes = ["direct", "pathProxy", "hostProxy"]

    private var selectedRoute: NibRouteInfo? {
        guard let preferred = project.preferredRoute else { return nil }
        return project.routes?[preferred]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Operations")
                    .font(.headline)
                    .foregroundStyle(NibTheme.text)
                Spacer()
                Button {
                    Task { await recheck() }
                } label: {
                    Image(systemName: rechecking ? "arrow.triangle.2.circlepath" : "arrow.clockwise")
                }
                .buttonStyle(NibIconButtonStyle())
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
                        .buttonStyle(NibRouteButtonStyle(active: active))
                        .opacity(route?.available == true ? 1 : 0.46)
                        .disabled(route?.available != true || settingRoute != nil || killing)
                    }
                }

                if let selectedRoute {
                    Text(selectedRoute.url)
                        .font(.caption)
                        .foregroundStyle(NibTheme.muted2)
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
                .buttonStyle(NibDangerButtonStyle())
                .disabled(rechecking || settingRoute != nil || killing)
            }
        }
        .padding(18)
        .background(NibTheme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(NibTheme.border))
    }

    private func routeLabel(_ mode: String) -> String {
        switch mode {
        case "direct": return "Direct"
        case "pathProxy": return "Path proxy"
        case "hostProxy": return "Host proxy"
        default: return mode
        }
    }

    private func routeDetail(_ route: NibRouteInfo?) -> String {
        guard let route else { return "Unavailable" }
        if let code = route.statusCode { return "HTTP \(code)" }
        if route.available { return "Available" }
        return route.message ?? "Unavailable"
    }
}

struct CommandActionSurface: View {
    var presets: [NibCommandPreset]
    var runs: [NibCommandRun]
    @Binding var customCommand: String
    var running: Bool
    var runPreset: (NibCommandPreset) async -> Void
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
                    .foregroundStyle(NibTheme.text)
                Spacer()
                Button {
                    Task { await refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(NibIconButtonStyle())
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
                        .buttonStyle(NibSecondaryButtonStyle())
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
                    .background(NibTheme.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(NibTheme.border))

                Button {
                    Task { await runCustom(customCommand) }
                } label: {
                    Label(running ? "Running" : "Run command", systemImage: "play")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(NibPrimaryButtonStyle())
                .disabled(!canRunCustom)
            }

            if !runs.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Recent")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(NibTheme.muted)
                    ForEach(runs.prefix(3)) { run in
                        CommandRunRow(run: run)
                    }
                }
            }
        }
        .padding(18)
        .background(NibTheme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(NibTheme.border))
    }
}

struct CommandRunRow: View {
    var run: NibCommandRun

    private var output: String {
        let stderr = run.stderrTail.trimmingCharacters(in: .whitespacesAndNewlines)
        if !stderr.isEmpty { return stderr }
        return run.stdoutTail.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var statusColor: Color {
        switch run.status {
        case "running": return NibTheme.blue
        case "exited": return NibTheme.green
        default: return NibTheme.amber
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
                    .foregroundStyle(NibTheme.text)
                    .lineLimit(2)
                Spacer(minLength: 8)
                Text(statusText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(statusColor)
            }

            Text(run.cwd)
                .font(.caption2)
                .foregroundStyle(NibTheme.muted2)
                .lineLimit(1)

            if !output.isEmpty {
                Text(output)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(run.stderrTail.isEmpty ? NibTheme.muted : NibTheme.amber)
                    .lineLimit(4)
                    .textSelection(.enabled)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(NibTheme.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(NibTheme.border.opacity(0.8)))
    }
}

struct ScreenshotStatusSurface: View {
    var screenshots: [String: NibScreenshotInfo]

    private let viewports = ["phone", "tablet", "desktop"]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Screenshots")
                .font(.headline)
                .foregroundStyle(NibTheme.text)
            HStack(spacing: 8) {
                ForEach(viewports, id: \.self) { viewport in
                    let info = screenshots[viewport]
                    VStack(alignment: .leading, spacing: 6) {
                        Image(systemName: icon(for: info))
                            .foregroundStyle(color(for: info))
                        Text(viewport.capitalized)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(NibTheme.text)
                        Text(detail(for: info))
                            .font(.caption2)
                            .foregroundStyle(NibTheme.muted)
                            .lineLimit(2)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(NibTheme.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(NibTheme.border))
                }
            }
        }
        .padding(18)
        .background(NibTheme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(NibTheme.border))
    }

    private func icon(for info: NibScreenshotInfo?) -> String {
        if info?.error != nil { return "exclamationmark.triangle" }
        if info?.url != nil { return "checkmark.circle" }
        return "circle.dashed"
    }

    private func color(for info: NibScreenshotInfo?) -> Color {
        if info?.error != nil { return NibTheme.amber }
        if info?.url != nil { return NibTheme.green }
        return NibTheme.muted2
    }

    private func detail(for info: NibScreenshotInfo?) -> String {
        guard let info else { return "Not captured" }
        if let error = info.error, !error.isEmpty { return error }
        if info.url != nil { return "\(info.width)x\(info.height)" }
        return "Waiting"
    }
}

struct ActivityRow: View {
    var event: NibActivityEvent

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(NibTheme.blue)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 4) {
                Text(event.message)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(NibTheme.text)
                Text(event.kind)
                    .font(.caption)
                    .foregroundStyle(NibTheme.muted)
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
    var request: NibRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline) {
                Text(request.title)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(NibTheme.text)
                Spacer()
                Text(request.status)
                    .font(.caption)
                    .foregroundStyle(statusColor)
            }
            Text(request.prompt)
                .font(.subheadline)
                .foregroundStyle(NibTheme.muted)
                .lineLimit(2)
            if let context = request.context, !context.isEmpty {
                Text(context)
                    .font(.caption)
                    .foregroundStyle(NibTheme.muted2)
                    .lineLimit(1)
            }
        }
    }

    private var statusColor: Color {
        switch request.status {
        case "open", "viewed": return NibTheme.blue
        case "answered", "acted", "resolved": return NibTheme.green
        case "stale", "expired": return NibTheme.amber
        default: return NibTheme.muted
        }
    }
}

struct RequestDetailView: View {
    @EnvironmentObject private var client: NibClient
    @Environment(\.openURL) private var openURL
    @Binding var request: NibRequest
    var onSubmitted: (NibRequest) -> Void
    @State private var reply = ""
    @State private var error: String?
    @State private var notice: String?
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var showingCamera = false
    @State private var safariRoute: SafariRoute?
    @State private var webRoute: WebRoute?
    @State private var sending = false

    private var cameraAvailable: Bool {
        #if os(visionOS)
        false
        #else
        UIImagePickerController.isSourceTypeAvailable(.camera)
        #endif
    }

    private var reviewImage: NibRequest.Attachment? {
        request.attachments.first { $0.contentType.hasPrefix("image/") || $0.type == "image" }
    }

    private var reviewVideo: NibRequest.Attachment? {
        request.visualReviewVideo
    }

    var body: some View {
        Group {
            if request.kind == "visual-review", reviewImage != nil || reviewVideo != nil {
                NativeVisualReviewWorkspace(
                    request: request,
                    imageURL: client.absoluteURL(reviewImage?.url),
                    videoURL: client.absoluteURL(reviewVideo?.url),
                    sending: sending,
                    uploadReply: { data, name in
                        _ = try await client.uploadResponseVideo(requestId: request.id, name: name, data: data)
                    },
                    submit: submitVisualReview
                )
            } else {
                standardRequestView
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

    private var standardRequestView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 12) {
                    Text(request.kind)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(NibTheme.blue)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(NibTheme.blue.opacity(0.12), in: Capsule())
                    Text(request.title)
                        .font(.largeTitle.weight(.semibold))
                        .foregroundStyle(NibTheme.text)
                        .textSelection(.enabled)
                    Text(request.prompt)
                        .font(.body)
                        .foregroundStyle(NibTheme.muted)
                        .textSelection(.enabled)
                    if let context = request.context, !context.isEmpty {
                        Text(context)
                            .font(.footnote)
                            .foregroundStyle(NibTheme.muted2)
                            .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(22)
                .background(NibTheme.surface, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).stroke(NibTheme.border))

                if let url = client.absoluteURL(request.target.url) ?? client.absoluteURL(request.target.appPath) {
                    Button {
                        webRoute = WebRoute(url: url, title: request.target.projectName ?? request.title)
                    } label: {
                        Label("Open website", systemImage: "globe")
                    }
                    .buttonStyle(NibSecondaryButtonStyle())
                }

                if !request.attachments.isEmpty {
                    AttachmentStrip(request: request)
                }

                HStack(spacing: 10) {
                    PhotosPicker(selection: $selectedPhoto, matching: .images) {
                        Label("Attach image", systemImage: "photo.on.rectangle")
                    }
                    .buttonStyle(NibSecondaryButtonStyle())
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
                        .buttonStyle(NibSecondaryButtonStyle())
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
                            .foregroundStyle(NibTheme.muted)
                        if let deviceName = response.device?.name {
                            Text("Answered on \(deviceName)")
                                .font(.subheadline)
                                .foregroundStyle(NibTheme.muted)
                        }
                    }
                    .padding(18)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(NibTheme.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                }
            }
            .padding(20)
        }
        .background(NibTheme.background)
        .navigationTitle("Request")
        .navigationBarTitleDisplayMode(.inline)
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
            await NibNotificationActions.clearDeliveredNotifications(requestId: request.id)
            onSubmitted(request)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func submitVisualReview(
        decision: String,
        comment: String?,
        annotations: [NibReviewAnnotation]
    ) async {
        sending = true
        defer { sending = false }
        do {
            request = try await client.respond(
                requestId: request.id,
                decision: decision,
                comment: comment,
                annotations: annotations
            )
            notice = decision == "approve" ? "Approved." : decision == "reject" ? "Rejected." : "Comment sent."
            error = nil
            await NibNotificationActions.clearDeliveredNotifications(requestId: request.id)
            onSubmitted(request)
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
                throw NSError(domain: "Nib", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not read image."])
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
                throw NSError(domain: "Nib", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not prepare image."])
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
    var request: NibRequest
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
                .buttonStyle(NibPrimaryButtonStyle())
                .disabled(sending)
            }

            if request.allowText {
                VStack(alignment: .leading, spacing: 10) {
                    TextField("Reply", text: $reply, axis: .vertical)
                        .lineLimit(3...6)
                        .padding(14)
                        .background(Color.white.opacity(0.74), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(NibTheme.border))
                    Button {
                        let text = reply.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task { await respond(RequestResponsePayload(text: text)) }
                    } label: {
                        Text("Send reply")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(NibPrimaryButtonStyle())
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
    @EnvironmentObject private var client: NibClient
    var request: NibRequest
    @State private var selectedImage: NibRequest.Attachment?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                ForEach(request.attachments) { attachment in
                    AttachmentTile(
                        attachment: attachment,
                        url: client.absoluteURL(attachment.url),
                        openImage: { selectedImage = attachment }
                    )
                }
            }
        }
        .fullScreenCover(item: $selectedImage) { attachment in
            NativeImageViewer(attachment: attachment, url: client.absoluteURL(attachment.url))
        }
    }
}

struct AttachmentTile: View {
    var attachment: NibRequest.Attachment
    var url: URL?
    var openImage: () -> Void

    private var isImage: Bool {
        attachment.type == "image" || attachment.contentType.hasPrefix("image/")
    }

    private var bytesLabel: String {
        ByteCountFormatter.string(fromByteCount: Int64(attachment.bytes), countStyle: .file)
    }

    var body: some View {
        Group {
            if isImage, url != nil {
                Button(action: openImage) {
                    content(url: url)
                }
                .accessibilityLabel("Open \(attachment.name) in Nib")
            } else if let url {
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
                        .fill(NibTheme.background)
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
                                    .foregroundStyle(NibTheme.muted)
                            case .empty:
                                ProgressView()
                                    .tint(NibTheme.muted)
                            @unknown default:
                                EmptyView()
                            }
                        }
                    } else {
                        Image(systemName: "photo")
                            .font(.title2)
                            .foregroundStyle(NibTheme.muted)
                    }
                }
                .frame(width: 188, height: 132)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))

                VStack(alignment: .leading, spacing: 3) {
                    Text(attachment.name)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(NibTheme.text)
                        .lineLimit(1)
                    Text(bytesLabel)
                        .font(.caption2)
                        .foregroundStyle(NibTheme.muted2)
                }
            }
            .padding(10)
            .frame(width: 208, alignment: .leading)
            .background(NibTheme.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(NibTheme.border))
            .shadow(color: Color.black.opacity(0.05), radius: 18, y: 10)
        } else {
            HStack(spacing: 10) {
                Image(systemName: "paperclip")
                    .font(.headline)
                    .foregroundStyle(NibTheme.muted)
                    .frame(width: 34, height: 34)
                    .background(NibTheme.background, in: Circle())
                VStack(alignment: .leading, spacing: 4) {
                    Text(attachment.name)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(NibTheme.text)
                        .lineLimit(1)
                    Text(bytesLabel)
                        .font(.caption2)
                        .foregroundStyle(NibTheme.muted2)
                }
            }
            .padding(12)
            .frame(width: 188, alignment: .leading)
            .background(NibTheme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(NibTheme.border))
        }
    }
}

struct NativeImageViewer: View {
    @Environment(\.dismiss) private var dismiss
    var attachment: NibRequest.Attachment
    var url: URL?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let url {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    case .failure:
                        ContentUnavailableView(
                            "Image unavailable",
                            systemImage: "photo.badge.exclamationmark",
                            description: Text("Nib could not load \(attachment.name).")
                        )
                        .foregroundStyle(.white)
                    case .empty:
                        ProgressView()
                            .tint(.white)
                    @unknown default:
                        EmptyView()
                    }
                }
                .padding(.horizontal, 12)
            } else {
                ContentUnavailableView("Image unavailable", systemImage: "photo.badge.exclamationmark")
                    .foregroundStyle(.white)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            HStack(spacing: 12) {
                Button(action: { dismiss() }) {
                    Image(systemName: "chevron.left")
                        .font(.title.weight(.regular))
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close image")

                Spacer(minLength: 0)

                Text(attachment.name)
                    .font(.headline)
                    .lineLimit(1)

                Spacer(minLength: 0)

                if let url {
                    ShareLink(item: url) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.title2.weight(.regular))
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Share image")
                } else {
                    Color.clear.frame(width: 44, height: 44)
                }
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .frame(height: 56)
            .background(Color(white: 0.10))
            .overlay(alignment: .bottom) {
                Divider().overlay(Color.white.opacity(0.12))
            }
        }
    }
}

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var client: NibClient
    @Binding var baseURLString: String
    var notificationStatus: NibNotificationStatus?
    var devices: [NibDevice]
    var waitingPanes: [NibWaitingPane]
    var sendingTestNotification: Bool
    var registerNotifications: () -> Void
    var sendTestNotification: () -> Void
    @AppStorage("nib.darkMode") private var darkMode = false
    @State private var pairingCode = ""
    @State private var authState = "Checking"
    @State private var authError: String?
    @State private var pairing = false
    @State private var diagnosticsExpanded = false

    var body: some View {
        Form {
            Section("Appearance") {
                Toggle(isOn: $darkMode) {
                    Label("Dark Mode", systemImage: darkMode ? "moon.fill" : "sun.max")
                }
            }

            Section {
                TextField("Server URL", text: $baseURLString)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
            } footer: {
                Text("Use the same Nib service URL that the CLI and notifications use.")
            }

            Section {
                LabeledContent("Status", value: authState)
                TextField("One-time pairing code", text: $pairingCode)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button {
                    Task { await redeemPairing() }
                } label: {
                    if pairing {
                        HStack {
                            ProgressView()
                            Text("Pairing")
                        }
                    } else {
                        Text("Pair device")
                    }
                }
                .disabled(pairing || pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if let authError {
                    Text(authError)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            } header: {
                Text("Authentication")
            } footer: {
                Text("Create a code with `nib auth pair`. It expires after 10 minutes and works once.")
            }

            Section("Advanced") {
                DisclosureGroup("Diagnostics", isExpanded: $diagnosticsExpanded) {
                    LabeledContent("App", value: Bundle.main.bundleIdentifier ?? "Unknown")
                    LabeledContent("Push entitlement", value: NibEntitlements.hasAPSEnvironment ? "Present" : "Missing")
                    LabeledContent("Registered devices", value: "\(devices.count)")
                    LabeledContent("APNs", value: apnsState)
                    LabeledContent("Waiting panes", value: "\(waitingPanes.count)")

                    if let environment = notificationStatus?.apnsEnvironment, !environment.isEmpty {
                        LabeledContent("Environment", value: environment)
                    }
                    if let topic = notificationStatus?.apnsTopic, !topic.isEmpty {
                        LabeledContent("Topic", value: topic)
                    }
                    if let issue = notificationStatus?.apnsLastError, !issue.isEmpty {
                        Text(issue)
                            .font(.caption)
                            .foregroundStyle(NibTheme.amber)
                            .textSelection(.enabled)
                    }

                    Button("Register notifications", action: registerNotifications)
                    Button(action: sendTestNotification) {
                        if sendingTestNotification {
                            HStack {
                                ProgressView()
                                Text("Sending test")
                            }
                        } else {
                            Text("Send test notification")
                        }
                    }
                    .disabled(sendingTestNotification)
                }
            }
        }
        .navigationTitle("Settings")
        .task(id: baseURLString) { await refreshAuthStatus() }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
    }

    private func refreshAuthStatus() async {
        client.configure(baseURLString: baseURLString)
        do {
            let status = try await client.authStatus()
            authState = status.authenticated ? "Paired" : "Not paired"
            authError = nil
        } catch {
            authState = "Not paired"
        }
    }

    private func redeemPairing() async {
        pairing = true
        defer { pairing = false }
        do {
            let platform: String
            #if os(visionOS)
            platform = "visionos"
            #else
            platform = "ios"
            #endif
            let status = try await client.redeemPairing(
                code: pairingCode.trimmingCharacters(in: .whitespacesAndNewlines),
                name: UIDevice.current.name,
                platform: platform
            )
            authState = status.authenticated ? "Paired" : "Not paired"
            pairingCode = ""
            authError = nil
        } catch {
            authError = error.localizedDescription
            authState = "Not paired"
        }
    }

    private var apnsState: String {
        if let error = notificationStatus?.apnsLastError, !error.isEmpty {
            return "Error"
        }
        if notificationStatus?.nativeReady == true {
            return "Ready"
        }
        if notificationStatus?.apnsConfigured == true {
            return "Configured"
        }
        return "Not configured"
    }
}

struct ToastView: View {
    var message: String?

    var body: some View {
        if let message {
            Text(message)
                .font(.footnote)
                .foregroundStyle(NibTheme.text)
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

#if os(visionOS)
struct CameraCaptureView: View {
    var onCapture: (UIImage) -> Void

    var body: some View {
        ContentUnavailableView(
            "Camera unavailable",
            systemImage: "camera.slash",
            description: Text("Choose an image from Photos instead.")
        )
    }
}
#else
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
#endif

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
            NibWebView(url: route.url)
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

struct NibWebView: UIViewRepresentable {
    var url: URL

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.backgroundColor = UIColor(NibTheme.background)
        webView.backgroundColor = UIColor(NibTheme.background)
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard webView.url != url else { return }
        webView.load(URLRequest(url: url))
    }
}

enum NibTheme {
    static let background = Color(red: 0.063, green: 0.063, blue: 0.063)
    static let surface = Color(red: 0.094, green: 0.094, blue: 0.094)
    static let text = Color(red: 0.949, green: 0.949, blue: 0.949)
    static let muted = Color(red: 0.800, green: 0.800, blue: 0.800)
    static let muted2 = Color(red: 0.620, green: 0.620, blue: 0.620)
    static let border = Color.white.opacity(0.14)
    static let blue = Color(red: 0.000, green: 0.471, blue: 0.831)
    static let green = Color(red: 0.180, green: 0.490, blue: 0.196)
    static let red = Color(red: 0.776, green: 0.157, blue: 0.157)
    static let amber = Color(red: 0.718, green: 0.475, blue: 0.122)
    static let shadow = Color.black.opacity(0.34)
}

struct NibPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .frame(minHeight: 50)
            .background(Color(red: 0.290, green: 0.290, blue: 0.290), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
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

struct NibSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(NibTheme.text)
            .padding(.horizontal, 13)
            .frame(minHeight: 42)
            .background(NibTheme.surface, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous).stroke(NibTheme.border))
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct NibRouteButtonStyle: ButtonStyle {
    var active: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(active ? .white : NibTheme.text)
            .padding(12)
            .frame(minHeight: 70)
            .background(
                active
                    ? Color(red: 0.170, green: 0.166, blue: 0.154)
                    : NibTheme.background,
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(active ? Color.white.opacity(0.10) : NibTheme.border))
            .opacity(configuration.isPressed ? 0.88 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct NibDangerButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(NibTheme.amber)
            .padding(.horizontal, 16)
            .frame(minHeight: 50)
            .background(NibTheme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(NibTheme.amber.opacity(0.48)))
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct NibIconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.title3.weight(.semibold))
            .foregroundStyle(NibTheme.text)
            .frame(width: 58, height: 46)
            .background(NibTheme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(NibTheme.border))
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
