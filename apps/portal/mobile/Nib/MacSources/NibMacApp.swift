import AppKit
import NibDomain
import NibFeatures
import SwiftUI

@main
struct NibMacApp: App {
    @NSApplicationDelegateAdaptor(NibMacAppDelegate.self) private var appDelegate

    var body: some Scene {
        Window("Nib", id: "main") {
            NibMacLaunchView(
                store: appDelegate.store,
                account: appDelegate.account,
                onAccessChange: appDelegate.setAccountAccess
            )
        }
        .defaultSize(width: 1280, height: 840)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(after: .appInfo) {
                Button("Open Portal") {
                    guard appDelegate.accountAccess else { return }
                    NibMacRequestNavigator.shared.open(appDelegate.store.baseURL)
                }
                .keyboardShortcut("o", modifiers: [.command, .shift])
                .disabled(!appDelegate.accountAccess)
            }
            CommandMenu("Request") {
                Button("Refresh") {
                    guard appDelegate.accountAccess else { return }
                    Task { await appDelegate.store.reloadAll() }
                }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(!appDelegate.accountAccess)
                Button("Copy Portal Link") {
                    guard appDelegate.accountAccess else { return }
                    copyPortalLink(appDelegate.store.baseURL)
                }
                .keyboardShortcut("c", modifiers: [.command, .shift])
                .disabled(!appDelegate.accountAccess)
            }
            CommandMenu("Capture") {
                Button("Capture Region") {
                    guard appDelegate.accountAccess else { return }
                    NotificationCenter.default.post(name: .nibMacCaptureRegion, object: nil)
                }
                .keyboardShortcut("4", modifiers: [.command, .shift])
                .disabled(!appDelegate.accountAccess)
                Button("Refresh Window Targets") {
                    guard appDelegate.accountAccess else { return }
                    NotificationCenter.default.post(name: .nibMacCaptureWindow, object: nil)
                }
                .disabled(!appDelegate.accountAccess)
                Button("Refresh Display Targets") {
                    guard appDelegate.accountAccess else { return }
                    NotificationCenter.default.post(name: .nibMacCaptureDisplay, object: nil)
                }
                .disabled(!appDelegate.accountAccess)
            }
        }

        MenuBarExtra {
            NibAccountGate(
                session: appDelegate.account,
                style: .compact,
                onAccessChange: appDelegate.setAccountAccess
            ) {
                NibMenuBarRequestsView(store: appDelegate.store)
            }
        } label: {
            NibMacMenuBarLabel(store: appDelegate.store)
        }
        .menuBarExtraStyle(.window)

        Settings {
            NibMacSettingsView(store: appDelegate.store)
        }
    }

    private func copyPortalLink(_ url: URL) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url.absoluteString, forType: .string)
    }
}

private struct NibMacLaunchView: View {
    @ObservedObject var store: NibMacRequestStore
    @ObservedObject var account: NibAccountSession
    var onAccessChange: (Bool) -> Void

    @ViewBuilder
    var body: some View {
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--nib-settings-preview") {
            NibMacSettingsView(store: store)
                .frame(minWidth: 480, minHeight: 280)
        } else if NibMacPreviewState.current() != nil {
            NibMacRootView(store: store)
                .frame(minWidth: 960, minHeight: 620)
        } else {
            authenticatedContent
        }
#else
        authenticatedContent
#endif
    }

    private var authenticatedContent: some View {
        NibAccountGate(session: account, onAccessChange: onAccessChange) {
            NibMacRootView(store: store)
                .frame(minWidth: 960, minHeight: 620)
        }
    }
}

@MainActor
final class NibMacAppDelegate: NSObject, NSApplicationDelegate, ObservableObject {
    @Published private(set) var accountAccess = false
    let store: NibMacRequestStore
    let account: NibAccountSession
    let previewState = NibMacPreviewState.current()
    private lazy var notificationController = NibMacNotificationController(store: store)
    private var fallbackMainWindow: NSWindow?
    private var pendingRequestID: String?

    override init() {
        let store = NibMacRequestStore()
        self.store = store
        self.account = NibAccountSession(
            client: store.client,
            platform: "macos",
            deviceName: Host.current().localizedName ?? "Nib Mac"
        )
        super.init()
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.regular)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard ProcessInfo.processInfo.environment["NIB_TESTING"] != "1" else {
            return
        }
        ensureMainWindowIsVisible()
        captureRenderedPreviewIfRequested()

        if ProcessInfo.processInfo.arguments.contains("--nib-code-entry-preview") {
            account.showCodeEntryPreview()
            return
        }

        if ProcessInfo.processInfo.arguments.contains("--nib-onboarding-preview") {
            account.showSignedOutPreview()
            return
        }

        if let previewState {
            store.applyPreviewState(
                requests: previewState.requests,
                projects: previewState.projects,
                devices: previewState.devices,
                activityEvents: previewState.activityEvents,
                connectionState: previewState.connectionState
            )
            updateDockBadge()
            return
        }
    }

    func setAccountAccess(_ allowed: Bool) {
        guard previewState == nil,
              !ProcessInfo.processInfo.arguments.contains("--nib-onboarding-preview"),
              !ProcessInfo.processInfo.arguments.contains("--nib-code-entry-preview"),
              accountAccess != allowed else { return }
        accountAccess = allowed
        if allowed {
            notificationController.register()
            store.start()
            openPendingRequestIfPossible()
        } else {
            store.stopAndClear()
        }
        updateDockBadge()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            guard let requestID = NibMacRequestNavigator.requestID(from: url) else { continue }
            pendingRequestID = requestID
            ensureMainWindowIsVisible(delay: 0)
            openPendingRequestIfPossible()
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        updateDockBadge()
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        if !flag {
            ensureMainWindowIsVisible(delay: 0)
        }
        return true
    }

    func application(
        _ application: NSApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        guard accountAccess else { return }
        Task {
            await store.registerMacPushDevice(
                token: deviceToken,
                topic: Bundle.main.bundleIdentifier
            )
        }
    }

    func application(
        _ application: NSApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        store.setNotificationRegistrationError(error)
    }

    func application(_ application: NSApplication, didReceiveRemoteNotification userInfo: [String: Any]) {
        guard accountAccess else { return }
        Task {
            _ = await notificationController.handleRemoteNotification(userInfo: userInfo)
            updateDockBadge()
        }
    }

    private func updateDockBadge() {
        let count = store.badges.dock
        NSApplication.shared.dockTile.badgeLabel = count == 0 ? nil : "\(count)"
    }

    private func openPendingRequestIfPossible() {
        guard accountAccess || previewState != nil,
              let requestID = pendingRequestID else { return }
        Task {
            if previewState == nil {
                await store.reload()
            }
            guard pendingRequestID == requestID else { return }
            pendingRequestID = nil
            NibMacRequestNavigator.shared.open(requestID: requestID)
        }
    }

    private func ensureMainWindowIsVisible(delay: TimeInterval = 0.5) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            let hasMainWindow = NSApplication.shared.windows.contains {
                $0.isVisible
                    && $0.styleMask.contains(.titled)
                    && $0.canBecomeMain
                    && $0.frame.width >= 600
                    && $0.frame.height >= 400
            }
            guard !hasMainWindow else { return }

            let rootView = AnyView(NibMacLaunchView(
                store: self.store,
                account: self.account,
                onAccessChange: self.setAccountAccess
            ))
            let controller = NSHostingController(rootView: rootView)
            let window = NSWindow(contentViewController: controller)
            window.title = "Nib"
            window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
            window.setContentSize(NSSize(width: 1280, height: 840))
            window.center()
            window.makeKeyAndOrderFront(nil)
            self.fallbackMainWindow = window
            NSApplication.shared.activate()
        }
    }

    private func captureRenderedPreviewIfRequested() {
#if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        guard let argumentIndex = arguments.firstIndex(of: "--nib-screenshot-path"),
              arguments.indices.contains(argumentIndex + 1) else {
            return
        }

        let outputURL = URL(fileURLWithPath: arguments[argumentIndex + 1])
        captureRenderedPreview(at: outputURL, attemptsRemaining: 20)
#endif
    }

#if DEBUG
    private func captureRenderedPreview(at outputURL: URL, attemptsRemaining: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            let settingsPreview = ProcessInfo.processInfo.arguments.contains("--nib-settings-preview")
            let window = NSApplication.shared.windows
                .filter {
                    $0.isVisible
                        && $0.styleMask.contains(.titled)
                        && $0.canBecomeMain
                        && (settingsPreview || ($0.frame.width >= 600 && $0.frame.height >= 400))
                }
                .max { lhs, rhs in
                    lhs.frame.width * lhs.frame.height < rhs.frame.width * rhs.frame.height
                }
            guard let window else {
                if attemptsRemaining > 1 {
                    self.captureRenderedPreview(at: outputURL, attemptsRemaining: attemptsRemaining - 1)
                }
                return
            }
            window.setContentSize(settingsPreview
                ? NSSize(width: 520, height: 340)
                : NSSize(width: 1280, height: 840))

            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                guard let view = window.contentView,
                      let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
                    return
                }
                view.cacheDisplay(in: view.bounds, to: bitmap)
                guard let data = bitmap.representation(using: .png, properties: [:]) else { return }
                try? FileManager.default.createDirectory(
                    at: outputURL.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try? data.write(to: outputURL, options: .atomic)
            }
        }
    }
#endif
}

private struct NibMacRootView: View {
    @ObservedObject var store: NibMacRequestStore
    @ObservedObject private var requestNavigator = NibMacRequestNavigator.shared
    @State private var selection: NibMacSidebarSection?
    @State private var detailSelection: NibMacDetailSelection
    @State private var historyFilter: NibMacHistoryFilter
    @State private var searchText = ""
    @StateObject private var libraryAdapter = NibCloudLibraryAdapter()
    @State private var captureError: String?
    @State private var shareableContent = NibMacCaptureShareableContent(displays: [], windows: [])

    init(store: NibMacRequestStore) {
        self.store = store
        let previewState = NibMacPreviewState.current()
        _selection = State(initialValue: previewState?.sidebarSection ?? .inbox)
        _detailSelection = State(initialValue: NibMacDetailSelection(
            requestID: previewState?.selectedRequestID,
            libraryItemID: previewState?.selectedLibraryItemID
        ))
        _historyFilter = State(initialValue: previewState?.historyFilter ?? .all)
    }

    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(NibMacSidebarSection.allCases) { section in
                    Button {
                        selection = section
                    } label: {
                        HStack(spacing: 10) {
                            Label(section.title, systemImage: section.systemImage)
                            Spacer()
                            let count = store.badges.sidebar[section] ?? 0
                            if count > 0 {
                                Text("\(count)")
                                    .font(.caption2.weight(.semibold))
                                    .padding(.horizontal, 7)
                                    .padding(.vertical, 2)
                                    .background(.primary.opacity(0.1), in: Capsule())
                            }
                        }
                        .foregroundStyle(selection == section ? Color.white : Color.primary)
                        .padding(.horizontal, 10)
                        .frame(height: 34)
                        .background(
                            selection == section ? Color.accentColor : Color.clear,
                            in: RoundedRectangle(cornerRadius: 7)
                        )
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }
            .padding(10)
            .background(Color(nsColor: .windowBackgroundColor))
            .navigationSplitViewColumnWidth(min: 190, ideal: 210, max: 240)
        } content: {
            sectionContent
                .navigationSplitViewColumnWidth(min: 380, ideal: 420, max: 480)
        } detail: {
            requestDetail
                .background(Color(nsColor: .windowBackgroundColor))
                .navigationSplitViewColumnWidth(min: 480, ideal: 620)
        }
        .navigationSplitViewStyle(.balanced)
        .searchable(text: $searchText, placement: .toolbar, prompt: "Search")
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    Task { await captureInteractiveRegion() }
                } label: {
                    Image(systemName: "selection.pin.in.out")
                }
                .help("Capture Region")
                Menu {
                    if shareableContent.windows.isEmpty {
                        Button("Refresh Windows") {
                            Task { await reloadShareableContent() }
                        }
                    } else {
                        ForEach(shareableContent.windows, id: \.id) { window in
                            Button(windowMenuTitle(window)) {
                                Task { await captureWindow(id: window.id) }
                            }
                        }
                    }
                } label: {
                    Image(systemName: "macwindow")
                }
                .help("Capture Window")
                Menu {
                    if shareableContent.displays.isEmpty {
                        Button("Refresh Displays") {
                            Task { await reloadShareableContent() }
                        }
                    } else {
                        ForEach(shareableContent.displays, id: \.id) { display in
                            Button(display.name) {
                                Task { await captureDisplay(id: display.id) }
                            }
                        }
                    }
                } label: {
                    Image(systemName: "display")
                }
                .help("Capture Display")
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task {
                        await store.reloadAll()
                        libraryAdapter.configure(baseURL: store.baseURL)
                        await libraryAdapter.refresh()
                    }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help("Refresh")
                .keyboardShortcut("r", modifiers: .command)
            }
        }
        .task {
            libraryAdapter.configure(baseURL: store.baseURL)
            if NibMacPreviewState.current() != nil {
                libraryAdapter.applyDeterministicMockState()
            }
            if NibMacPreviewState.current() == nil {
                await store.reloadDashboard()
                await libraryAdapter.refresh()
                await reloadShareableContent()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .nibMacCaptureRegion)) { _ in
            Task { await captureInteractiveRegion() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .nibMacCaptureWindow)) { _ in
            Task { await reloadShareableContent() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .nibMacCaptureDisplay)) { _ in
            Task { await reloadShareableContent() }
        }
        .onChange(of: store.badges.dock) { _, count in
            NSApplication.shared.dockTile.badgeLabel = count == 0 ? nil : "\(count)"
        }
        .onChange(of: requestNavigator.requestOpenIntent, initial: true) { _, intent in
            guard let intent else { return }
            searchText = ""
            selection = store.historyRequests.contains { $0.id == intent.requestID }
                ? .history
                : .inbox
            detailSelection.selectRequest(intent.requestID)
        }
        .preferredColorScheme(NibMacPreviewState.current() == nil ? nil : .light)
    }

    @ViewBuilder
    private var sectionContent: some View {
        switch selection ?? .inbox {
        case .inbox:
            requestList(
                title: "Inbox",
                requests: filtered(store.inboxRequests),
                emptyTitle: "Inbox is clear",
                emptyMessage: "New requests will appear here on this Mac."
            )
        case .history:
            historyList
        case .projects:
            projectList
        case .devices:
            deviceList
        case .activity:
            activityList
        }
    }

    private var historyList: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                ForEach(NibMacHistoryFilter.allCases) { filter in
                    Button(filter.title) {
                        historyFilter = filter
                    }
                    .buttonStyle(.plain)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(historyFilter == filter ? Color.white : Color.primary)
                    .padding(.horizontal, 10)
                    .frame(height: 28)
                    .background(
                        historyFilter == filter ? Color.accentColor : Color(nsColor: .controlBackgroundColor),
                        in: Capsule()
                    )
                }
                Spacer(minLength: 0)
            }
            .padding(12)

            NibLibraryStatusView(
                queuedCount: allLibraryItems.filter { $0.status == .queued || $0.status == .uploading }.count,
                availableCount: allLibraryItems.filter { $0.status == .available }.count,
                isOffline: store.connectionState == .reconnecting || libraryAdapter.isOffline
            )
            .padding(.horizontal, 8)

            if let message = libraryAdapter.errorMessage ?? captureError ?? store.notificationError {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
            }

            NibLibraryListView(
                items: filteredLibraryItems,
                selectedID: detailSelection.libraryItemID,
                select: { item in
                    detailSelection.selectLibraryItem(item.id)
                }
            )

            Divider()

            requestList(
                title: "Request History",
                requests: filtered(historyFilter.filtered(store.historyRequests)),
                emptyTitle: "No matching requests",
                emptyMessage: "Approved, rejected, commented, and capture requests will appear here."
            )
        }
    }

    private func requestList(
        title: String,
        requests: [NibRequest],
        emptyTitle: String,
        emptyMessage: String
    ) -> some View {
        List(selection: requestSelection) {
            if store.connectionState == .reconnecting {
                NibMacReconnectingRow {
                    store.start()
                }
            } else if requests.isEmpty {
                NibMacEmptyRow(title: emptyTitle, message: emptyMessage)
            } else {
                Section(title) {
                    ForEach(requests) { request in
                        NibMacRequestRow(request: request)
                            .tag(request.id)
                            .contextMenu {
                                Button("Open Request") { open(request) }
                                Button("Copy Request Link") { copyLink(for: request) }
                            }
                    }
                }
            }
        }
        .navigationTitle(title)
    }

    private var projectList: some View {
        List {
            if store.projects.isEmpty {
                NibMacEmptyRow(title: "No projects", message: "Projects registered with Nib will appear here.")
            } else {
                ForEach(filteredProjects) { project in
                    Button {
                        if let url = store.projectURL(for: project) {
                            NibMacRequestNavigator.shared.open(url)
                        }
                    } label: {
                        NibMacProjectRow(project: project)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .navigationTitle("Projects")
    }

    private var deviceList: some View {
        List {
            if store.devices.isEmpty {
                NibMacEmptyRow(title: "No devices", message: "Paired phones, watches, and Macs will appear here.")
            } else {
                ForEach(filteredDevices) { device in
                    NibMacDeviceRow(device: device)
                }
            }
        }
        .navigationTitle("Devices")
    }

    private var activityList: some View {
        List {
            if store.activityEvents.isEmpty {
                NibMacEmptyRow(title: "No activity", message: "Recent request and project events will appear here.")
            } else {
                ForEach(filteredActivity) { event in
                    NibMacActivityRow(event: event)
                }
            }
        }
        .navigationTitle("Activity")
    }

    @ViewBuilder
    private var requestDetail: some View {
        if let item = selectedLibraryItem {
            NibMacLibraryDetailPane(item: item, adapter: libraryAdapter)
        } else if let request = selectedRequest {
            NibMacRequestDetailView(request: request, store: store)
        } else {
            ContentUnavailableView {
                Label("Select a request", systemImage: "sidebar.left")
            } description: {
                Text("Choose a request from Inbox or History.")
            }
        }
    }

    private var selectedRequest: NibRequest? {
        guard let selectedRequestID = detailSelection.requestID else { return nil }
        return store.requests.first { $0.id == selectedRequestID }
    }

    private var selectedLibraryItem: NibLibraryItem? {
        guard let selectedLibraryItemID = detailSelection.libraryItemID else { return nil }
        return allLibraryItems.first { $0.id == selectedLibraryItemID }
    }

    private var requestSelection: Binding<String?> {
        Binding(
            get: { detailSelection.requestID },
            set: { detailSelection.selectRequest($0) }
        )
    }

    private var historyLibraryItems: [NibLibraryItem] {
        store.historyRequests.compactMap(\.macLibraryItem)
    }

    private var allLibraryItems: [NibLibraryItem] {
        NibLibrary.sorted(libraryAdapter.items + store.captureLibraryItems + historyLibraryItems)
    }

    private var filteredLibraryItems: [NibLibraryItem] {
        NibLibrary.filter(allLibraryItems, query: normalizedSearch)
    }

    private var filteredProjects: [NibProject] {
        let query = normalizedSearch
        guard !query.isEmpty else { return store.projects }
        return store.projects.filter {
            $0.name.localizedCaseInsensitiveContains(query)
                || $0.status.localizedCaseInsensitiveContains(query)
        }
    }

    private var filteredDevices: [NibDevice] {
        let query = normalizedSearch
        guard !query.isEmpty else { return store.devices }
        return store.devices.filter {
            $0.name.localizedCaseInsensitiveContains(query)
                || $0.platform.localizedCaseInsensitiveContains(query)
        }
    }

    private var filteredActivity: [NibActivityEvent] {
        let query = normalizedSearch
        guard !query.isEmpty else { return store.activityEvents }
        return store.activityEvents.filter {
            $0.message.localizedCaseInsensitiveContains(query)
                || $0.kind.localizedCaseInsensitiveContains(query)
        }
    }

    private var normalizedSearch: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func filtered(_ requests: [NibRequest]) -> [NibRequest] {
        let query = normalizedSearch
        guard !query.isEmpty else { return requests }
        return requests.filter {
            $0.title.localizedCaseInsensitiveContains(query)
                || $0.prompt.localizedCaseInsensitiveContains(query)
                || ($0.source?.localizedCaseInsensitiveContains(query) ?? false)
                || ($0.target.projectName?.localizedCaseInsensitiveContains(query) ?? false)
        }
    }

    private func open(_ request: NibRequest) {
        if let url = store.reviewURL(for: request), request.kind == "acceptance-review" {
            NibMacRequestNavigator.shared.open(url)
            return
        }
        NibMacRequestNavigator.shared.open(requestID: request.id)
    }

    private func captureInteractiveRegion() async {
        do {
            let artifact = try await NibMacCaptureService().captureInteractiveRegion()
            store.recordCaptureArtifact(artifact)
            captureError = nil
            selection = .history
        } catch {
            captureError = error.localizedDescription
        }
    }

    private func captureWindow(id: CGWindowID) async {
        do {
            let artifact = try await NibMacCaptureService().captureWindow(id: id)
            store.recordCaptureArtifact(artifact)
            captureError = nil
            selection = .history
        } catch {
            captureError = error.localizedDescription
        }
    }

    private func captureDisplay(id: CGDirectDisplayID) async {
        do {
            let artifact = try await NibMacCaptureService().captureDisplay(id: id)
            store.recordCaptureArtifact(artifact)
            captureError = nil
            selection = .history
        } catch {
            captureError = error.localizedDescription
        }
    }

    private func reloadShareableContent() async {
        do {
            shareableContent = try await NibMacCaptureService().shareableContent()
            captureError = nil
        } catch {
            captureError = error.localizedDescription
        }
    }

    private func windowMenuTitle(_ window: NibMacCaptureWindow) -> String {
        let title = window.title.isEmpty ? "Untitled" : window.title
        return "\(window.applicationName) - \(title)"
    }

    private func copyLink(for request: NibRequest) {
        guard let url = store.reviewURL(for: request) else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url.absoluteString, forType: .string)
    }
}

private struct NibMacMenuBarLabel: View {
    @ObservedObject var store: NibMacRequestStore

    var body: some View {
        Image(systemName: store.badges.menuBar == 0
            ? "pencil.tip.crop.circle"
            : "pencil.tip.crop.circle.badge.plus")
            .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        let count = store.badges.menuBar
        return count == 0 ? "Nib, no waiting requests" : "Nib, \(count) waiting requests"
    }
}

private struct NibMenuBarRequestsView: View {
    @ObservedObject var store: NibMacRequestStore
    @ObservedObject private var navigator = NibMacRequestNavigator.shared
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
                Task { await store.reloadAll() }
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
        } else if store.inboxRequests.isEmpty {
            emptyState
        } else {
            requestList
        }
    }

    private var requestList: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(store.inboxRequests.count) waiting")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)

            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(store.inboxRequests) { request in
                        Button {
                            open(request)
                        } label: {
                            NibMacRequestRow(request: request)
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button("Open Request") { open(request) }
                            Button("Copy Request Link") { copyLink(for: request) }
                        }

                        if request.id != store.inboxRequests.last?.id {
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
                store.start()
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
            if let error = navigator.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Button("Open Nib") {
                    navigator.open(store.baseURL)
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
        if let url = store.reviewURL(for: request), request.kind == "acceptance-review" {
            navigator.open(url)
            return
        }
        navigator.open(requestID: request.id)
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
                if let uploadState = request.macUploadState {
                    HStack(spacing: 8) {
                        Text(uploadState.label)
                        if case .uploading(let progress) = uploadState {
                            ProgressView(value: progress)
                                .frame(width: 72)
                        }
                    }
                    .font(.caption2)
                    .foregroundStyle(.orange)
                }
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
        return "\(label) - \(request.status)"
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

private struct NibMacLibraryDetailPane: View {
    let item: NibLibraryItem
    @ObservedObject var adapter: NibCloudLibraryAdapter

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(item.name)
                    .font(.title2.weight(.semibold))
                Spacer()
                if let previewURL = adapter.previewURL(for: item) {
                    Button {
                        NibMacRequestNavigator.shared.open(previewURL)
                    } label: {
                        Label("Preview", systemImage: "eye")
                    }
                }
                if let downloadURL = adapter.downloadURL(for: item) {
                    Button {
                        NibMacRequestNavigator.shared.open(downloadURL)
                    } label: {
                        Label("Download", systemImage: "arrow.down.circle")
                    }
                }
                Button {
                    Task {
                        _ = await adapter.createNewNib(from: item)
                    }
                } label: {
                    Label("Create New Nib", systemImage: "plus.square.on.square")
                }
            }

            NibLibraryDetailView(item: item)
                .frame(maxWidth: 560)

            Spacer()
        }
        .padding(28)
        .navigationTitle(item.name)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

private struct NibMacRequestDetailView: View {
    let request: NibRequest
    @ObservedObject var store: NibMacRequestStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(request.title)
                            .font(.title2.weight(.semibold))
                        Text(request.prompt)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button {
                        if let url = store.reviewURL(for: request), request.kind == "acceptance-review" {
                            NibMacRequestNavigator.shared.open(url)
                        } else {
                            NibMacRequestNavigator.shared.open(requestID: request.id)
                        }
                    } label: {
                        Label("Open", systemImage: "arrow.up.right.square")
                    }
                }

                if let body = request.body, !body.isEmpty {
                    Text(body)
                        .textSelection(.enabled)
                }

                Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 10) {
                    GridRow {
                        Text("Status").foregroundStyle(.secondary)
                        Text(request.status)
                    }
                    GridRow {
                        Text("Source").foregroundStyle(.secondary)
                        Text(request.source ?? "Unknown")
                    }
                    if let project = request.target.projectName {
                        GridRow {
                            Text("Project").foregroundStyle(.secondary)
                            Text(project)
                        }
                    }
                    GridRow {
                        Text("Updated").foregroundStyle(.secondary)
                        Text(request.updatedAt)
                    }
                }

                if !request.attachments.isEmpty {
                    Section("Attachments") {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(request.attachments) { attachment in
                                Label(attachment.name, systemImage: attachmentIcon(attachment))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                if let response = request.latestResponse {
                    Section("Latest Response") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(response.choice ?? response.kind)
                                .font(.headline)
                            Text(response.text)
                                .textSelection(.enabled)
                        }
                    }
                }

            }
            .padding(28)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(request.title)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func attachmentIcon(_ attachment: NibRequest.Attachment) -> String {
        if attachment.contentType.lowercased().hasPrefix("image/") { return "photo" }
        if attachment.contentType.lowercased().hasPrefix("video/") { return "video" }
        if attachment.contentType.lowercased() == "application/pdf" { return "doc.richtext" }
        return "paperclip"
    }
}

private struct NibMacProjectRow: View {
    let project: NibProject

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(project.name)
                .font(.body.weight(.medium))
            Text("\(project.status) - \(project.directUrl)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 6)
    }
}

private struct NibMacDeviceRow: View {
    let device: NibDevice

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: device.platform == "macos" ? "desktopcomputer" : "iphone")
                .foregroundStyle(NibMacTheme.blue)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 4) {
                Text(device.name)
                Text("\(device.platform) - \(device.pushKind)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 6)
    }
}

private struct NibMacActivityRow: View {
    let event: NibActivityEvent

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(event.message)
            Text("\(event.kind) - \(event.createdAt)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 6)
    }
}

private struct NibMacEmptyRow: View {
    let title: String
    let message: String

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: "tray")
        } description: {
            Text(message)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 42)
    }
}

private struct NibMacReconnectingRow: View {
    var retry: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            Label("Reconnecting", systemImage: "network.slash")
                .font(.headline)
            Text("Nib will reconnect to your portal automatically.")
                .foregroundStyle(.secondary)
            Button("Retry now", action: retry)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 42)
    }
}

private struct NibMacSettingsView: View {
    @ObservedObject var store: NibMacRequestStore

    var body: some View {
        Form {
            NibAccountSection(
                client: store.client,
                platform: "macos",
                deviceName: Host.current().localizedName ?? "Nib Mac"
            )
        }
        .formStyle(.grouped)
        .padding(20)
        .frame(width: 440)
    }
}

private enum NibMacTheme {
    static let blue = Color(red: 0, green: 0.47, blue: 0.83)
}

private extension Notification.Name {
    static let nibMacCaptureRegion = Notification.Name("nib.mac.capture.region")
    static let nibMacCaptureWindow = Notification.Name("nib.mac.capture.window")
    static let nibMacCaptureDisplay = Notification.Name("nib.mac.capture.display")
}
