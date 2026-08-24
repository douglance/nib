import SwiftUI

enum NibAuthPollingPolicy {
    static func shouldRetry(_ error: Error) -> Bool {
        guard let urlError = error as? URLError else { return false }
        switch urlError.code {
        case .timedOut,
             .cannotFindHost,
             .cannotConnectToHost,
             .networkConnectionLost,
             .dnsLookupFailed,
             .notConnectedToInternet,
             .internationalRoamingOff,
             .callIsActive,
             .dataNotAllowed,
             .backgroundSessionWasDisconnected:
            return true
        default:
            return false
        }
    }
}

enum NibAuthURLRouting {
    static func isVerificationURL(_ url: URL, serviceURL: URL) -> Bool {
        guard url.scheme?.lowercased() == serviceURL.scheme?.lowercased(),
              url.host?.lowercased() == serviceURL.host?.lowercased(),
              url.port == serviceURL.port,
              url.path == "/auth/verify" else {
            return false
        }
        return true
    }
}

@MainActor
protocol NibAccountClientProtocol: AnyObject {
    func authStatus() async throws -> NibAuthStatus
    func beginEmailSignIn(email: String, name: String, platform: String) async throws -> NibPendingSignIn
    func pollEmailSignIn(_ pending: NibPendingSignIn) async throws -> NibAuthStatus?
    func redeemEmailSignInCode(_ code: String, pending: NibPendingSignIn) async throws -> NibAuthStatus
    func logout() async throws -> NibAuthLogout
    func deleteAccount() async throws -> NibAccountDeletion
}

extension NibClient: NibAccountClientProtocol {}

enum NibAccountPhase: Equatable {
    case checking
    case signedOut
    case waiting(NibPendingSignIn)
    case signedIn(NibAuthStatus)

    var allowsAppAccess: Bool {
        if case .signedIn = self { return true }
        return false
    }
}

@MainActor
final class NibAccountSession: ObservableObject {
    @Published var email = ""
    @Published var signInCode = ""
    @Published private(set) var phase: NibAccountPhase
    @Published private(set) var working = false
    @Published private(set) var errorMessage: String?

    private let client: any NibAccountClientProtocol
    private let platform: String
    private let deviceName: String
    private let pollInterval: Duration
    private let automaticallyPoll: Bool
    private let now: () -> Date
    private let sleep: (Duration) async throws -> Void
    private var pollingTask: Task<Void, Never>?

    init(
        client: any NibAccountClientProtocol,
        platform: String,
        deviceName: String,
        initialPhase: NibAccountPhase = .checking,
        pollInterval: Duration = .seconds(2),
        automaticallyPoll: Bool = true,
        now: @escaping () -> Date = Date.init,
        sleep: @escaping (Duration) async throws -> Void = { duration in
            try await Task.sleep(for: duration)
        }
    ) {
        self.client = client
        self.platform = platform
        self.deviceName = deviceName
        self.phase = initialPhase
        self.pollInterval = pollInterval
        self.automaticallyPoll = automaticallyPoll
        self.now = now
        self.sleep = sleep
    }

    var status: NibAuthStatus? {
        guard case .signedIn(let status) = phase else { return nil }
        return status
    }

    var pendingSignIn: NibPendingSignIn? {
        guard case .waiting(let pending) = phase else { return nil }
        return pending
    }

    func refresh() async {
        pollingTask?.cancel()
        pollingTask = nil
        phase = .checking
        do {
            phase = .signedIn(try await client.authStatus())
            errorMessage = nil
        } catch {
            phase = .signedOut
            errorMessage = nil
        }
    }

    func sendLink() async {
        let address = (pendingSignIn?.email ?? email)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty, address.contains("@") else {
            errorMessage = "Enter a valid email address."
            return
        }

        pollingTask?.cancel()
        working = true
        errorMessage = nil
        do {
            let pending = try await client.beginEmailSignIn(
                email: address,
                name: deviceName,
                platform: platform
            )
            email = address
            signInCode = ""
            phase = .waiting(pending)
            working = false
            guard automaticallyPoll else { return }
            pollingTask = Task { [weak self] in
                guard let self else { return }
                await self.poll(pending)
            }
        } catch {
            working = false
            errorMessage = error.localizedDescription
        }
    }

    func submitCode() async {
        guard let pending = pendingSignIn else { return }
        let code = signInCode.filter(\.isNumber)
        guard code.count == 6 else {
            errorMessage = "Enter the six-digit code from your email."
            return
        }

        pollingTask?.cancel()
        pollingTask = nil
        working = true
        errorMessage = nil
        defer { working = false }
        do {
            phase = .signedIn(try await client.redeemEmailSignInCode(code, pending: pending))
            email = ""
            signInCode = ""
            NotificationCenter.default.post(name: .nibAccountChanged, object: nil)
        } catch {
            errorMessage = "That code is invalid or expired. Request a new code and try again."
            guard automaticallyPoll else { return }
            pollingTask = Task { [weak self] in
                guard let self else { return }
                await self.poll(pending)
            }
        }
    }

    func useDifferentEmail() {
        pollingTask?.cancel()
        pollingTask = nil
        phase = .signedOut
        errorMessage = nil
        email = ""
        signInCode = ""
    }

    func signOut() async {
        pollingTask?.cancel()
        working = true
        errorMessage = nil
        defer { working = false }
        do {
            _ = try await client.logout()
            phase = .signedOut
            email = ""
            signInCode = ""
            NotificationCenter.default.post(name: .nibAccountChanged, object: nil)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func deleteAccount() async {
        pollingTask?.cancel()
        working = true
        errorMessage = nil
        defer { working = false }
        do {
            _ = try await client.deleteAccount()
            phase = .signedOut
            email = ""
            signInCode = ""
            NotificationCenter.default.post(name: .nibAccountChanged, object: nil)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func showSignedOutPreview() {
        pollingTask?.cancel()
        pollingTask = nil
        phase = .signedOut
        working = false
        errorMessage = nil
        email = "doug@example.com"
        signInCode = ""
    }

    func showCodeEntryPreview() {
        pollingTask?.cancel()
        pollingTask = nil
        phase = .waiting(NibPendingSignIn(
            challengeId: "preview",
            verifier: "preview",
            expiresAt: Date().addingTimeInterval(600),
            email: "doug@example.com"
        ))
        working = false
        errorMessage = nil
        email = "doug@example.com"
        signInCode = "123"
    }

    private func poll(_ signIn: NibPendingSignIn) async {
        while now() < signIn.expiresAt, !Task.isCancelled {
            do {
                if let account = try await client.pollEmailSignIn(signIn) {
                    phase = .signedIn(account)
                    email = ""
                    errorMessage = nil
                    pollingTask = nil
                    NotificationCenter.default.post(name: .nibAccountChanged, object: nil)
                    return
                }
            } catch {
                if Task.isCancelled { return }
                if NibAuthPollingPolicy.shouldRetry(error) {
                    try? await sleep(pollInterval)
                    continue
                }
                errorMessage = error.localizedDescription
                pollingTask = nil
                return
            }

            do {
                try await sleep(pollInterval)
            } catch {
                return
            }
        }

        guard !Task.isCancelled,
              pendingSignIn?.challengeId == signIn.challengeId else { return }
        errorMessage = "This sign-in request expired. Send a new code."
        pollingTask = nil
    }
}

enum NibOnboardingStyle {
    case standard
    case compact
}

struct NibAccountGate<Content: View>: View {
    @ObservedObject var session: NibAccountSession
    var style: NibOnboardingStyle = .standard
    var onAccessChange: (Bool) -> Void = { _ in }
    @ViewBuilder var content: () -> Content

    var body: some View {
        Group {
            switch session.phase {
            case .signedIn:
                content()
            case .checking:
                NibAccountCheckingView()
            case .signedOut, .waiting:
                NibOnboardingView(session: session, style: style)
            }
        }
        .task {
            if ProcessInfo.processInfo.arguments.contains("--nib-code-entry-preview") {
                session.showCodeEntryPreview()
            } else if ProcessInfo.processInfo.arguments.contains("--nib-onboarding-preview") {
                session.showSignedOutPreview()
            } else if session.phase == .checking {
                await session.refresh()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .nibAccountChanged)) { _ in
            guard !ProcessInfo.processInfo.arguments.contains("--nib-onboarding-preview"),
                  !ProcessInfo.processInfo.arguments.contains("--nib-code-entry-preview") else { return }
            Task { await session.refresh() }
        }
        .onAppear {
            onAccessChange(session.phase.allowsAppAccess)
        }
        .onChange(of: session.phase) { _, phase in
            onAccessChange(phase.allowsAppAccess)
        }
    }
}

private struct NibAccountCheckingView: View {
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "pencil.tip.crop.circle")
                .font(.system(size: 42, weight: .medium))
                .foregroundStyle(.tint)
            ProgressView()
            Text("Opening Nib...")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("nib.onboarding.checking")
    }
}

struct NibOnboardingView: View {
    @ObservedObject var session: NibAccountSession
    var style: NibOnboardingStyle = .standard

    private var compact: Bool {
        #if os(watchOS)
        true
        #else
        style == .compact
        #endif
    }

    var body: some View {
        ScrollView {
            VStack(spacing: compact ? 16 : 24) {
                brand
                if let pending = session.pendingSignIn {
                    waiting(pending)
                } else {
                    signIn
                }
            }
            .frame(maxWidth: compact ? 380 : 460)
            .padding(.horizontal, compact ? 18 : 32)
            .padding(.vertical, compact ? 20 : 48)
            .frame(maxWidth: .infinity, minHeight: compact ? nil : 560)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            ZStack {
                Color(red: 0.035, green: 0.039, blue: 0.051)
                RadialGradient(
                    colors: [Color.blue.opacity(0.18), Color.clear],
                    center: .topLeading,
                    startRadius: 0,
                    endRadius: compact ? 320 : 720
                )
            }
            .ignoresSafeArea()
        }
        .preferredColorScheme(.dark)
        .accessibilityIdentifier("nib.onboarding")
    }

    private var brand: some View {
        VStack(spacing: compact ? 8 : 12) {
            Image(systemName: "pencil.tip.crop.circle")
                .font(.system(size: compact ? 42 : 58, weight: .medium))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("Nib")
                .font(compact ? .title2.bold() : .largeTitle.bold())
            Text("Your review history, on every device.")
                .font(compact ? .footnote : .title3)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    private var signIn: some View {
        VStack(spacing: 14) {
            Text("Sign in with your email")
                .font(compact ? .headline : .title2.bold())
                Text("We will email you a six-digit sign-in code. No password needed.")
                .font(compact ? .caption : .body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            emailField

            Button {
                Task { await session.sendLink() }
            } label: {
                HStack {
                    if session.working { ProgressView().controlSize(.small) }
                    Text(session.working ? "Sending..." : "Email me a sign-in code")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(.blue)
            .controlSize(compact ? .regular : .large)
            .disabled(session.working || session.email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("nib.onboarding.sendLink")

            errorMessage

            Text("By continuing, you agree to use Nib Cloud for your Nib files and review history.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
    }

    @ViewBuilder
    private var emailField: some View {
        #if os(macOS)
        TextField("you@example.com", text: $session.email)
            .textFieldStyle(.roundedBorder)
            .textContentType(.emailAddress)
            .onSubmit { Task { await session.sendLink() } }
            .accessibilityLabel("Email address")
            .accessibilityIdentifier("nib.onboarding.email")
        #elseif os(watchOS)
        TextField("Email", text: $session.email)
            .textContentType(.emailAddress)
            .onSubmit { Task { await session.sendLink() } }
            .accessibilityLabel("Email address")
            .accessibilityIdentifier("nib.onboarding.email")
        #else
        TextField("you@example.com", text: $session.email)
            .textFieldStyle(.roundedBorder)
            .textContentType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.emailAddress)
            .submitLabel(.continue)
            .onSubmit { Task { await session.sendLink() } }
            .accessibilityLabel("Email address")
            .accessibilityIdentifier("nib.onboarding.email")
        #endif
    }

    private func waiting(_ pending: NibPendingSignIn) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "envelope.badge")
                .font(.system(size: compact ? 30 : 40))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("Check your email")
                .font(compact ? .headline : .title2.bold())
            Text("We sent a six-digit code to \(pending.email). Enter it here to sign in.")
                .font(compact ? .caption : .body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            codeField

            Button {
                Task { await session.submitCode() }
            } label: {
                HStack {
                    if session.working { ProgressView().controlSize(.small) }
                    Text(session.working ? "Signing in..." : "Sign in")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(.blue)
            .controlSize(compact ? .regular : .large)
            .disabled(session.working || session.signInCode.filter(\.isNumber).count != 6)
            .accessibilityIdentifier("nib.onboarding.submitCode")

            errorMessage

            Button("Send again") {
                Task { await session.sendLink() }
            }
            .buttonStyle(.borderedProminent)
            .tint(.blue)
            .disabled(session.working)

            Button("Use a different email") {
                session.useDifferentEmail()
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .disabled(session.working)
        }
    }

    @ViewBuilder
    private var codeField: some View {
        #if os(macOS)
        TextField("123456", text: $session.signInCode)
            .textFieldStyle(.roundedBorder)
            .textContentType(.oneTimeCode)
            .onSubmit { Task { await session.submitCode() } }
            .accessibilityLabel("Six-digit sign-in code")
            .accessibilityIdentifier("nib.onboarding.code")
        #elseif os(iOS) || os(visionOS)
        TextField("123456", text: $session.signInCode)
            .textContentType(.oneTimeCode)
            .keyboardType(.numberPad)
            .accessibilityLabel("Six-digit sign-in code")
            .accessibilityIdentifier("nib.onboarding.code")
        #else
        TextField("123456", text: $session.signInCode)
            .textContentType(.oneTimeCode)
            .accessibilityLabel("Six-digit sign-in code")
            .accessibilityIdentifier("nib.onboarding.code")
        #endif
    }

    @ViewBuilder
    private var errorMessage: some View {
        if let message = session.errorMessage {
            Label(message, systemImage: "exclamationmark.circle.fill")
                .font(.caption)
                .foregroundStyle(.red)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("nib.onboarding.error")
        }
    }
}

struct NibAccountSection: View {
    @StateObject private var session: NibAccountSession
    @State private var confirmingDeletion = false

    init(client: NibClient, platform: String, deviceName: String) {
        _session = StateObject(wrappedValue: NibAccountSession(
            client: client,
            platform: platform,
            deviceName: deviceName
        ))
    }

    var body: some View {
        Section("Account") {
            switch session.phase {
            case .checking:
                HStack {
                    ProgressView()
                    Text("Checking account...")
                }
            case .signedIn(let status):
                LabeledContent("Email", value: status.account.email)
                LabeledContent("Service", value: "nibtool.com")
                Button("Sign Out") {
                    Task { await session.signOut() }
                }
                .disabled(session.working)
                Button("Delete Account...", role: .destructive) {
                    confirmingDeletion = true
                }
                .disabled(session.working)
            case .waiting(let pending):
                LabeledContent("Email", value: pending.email)
                TextField("Six-digit code", text: $session.signInCode)
                    .textContentType(.oneTimeCode)
                    .accessibilityLabel("Six-digit sign-in code")
                Button(session.working ? "Signing In..." : "Sign In") {
                    Task { await session.submitCode() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(session.working || session.signInCode.filter(\.isNumber).count != 6)
                Button("Send Again") {
                    Task { await session.sendLink() }
                }
                .disabled(session.working)
                Button("Use a Different Email") {
                    session.useDifferentEmail()
                }
                .disabled(session.working)
            case .signedOut:
                Text("Use one Nib account on every device.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                settingsEmailField
                Button(session.working ? "Sending..." : "Email Me a Sign-In Code") {
                    Task { await session.sendLink() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(session.working || session.email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            if let message = session.errorMessage {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .task { await session.refresh() }
        .confirmationDialog(
            "Delete your Nib account?",
            isPresented: $confirmingDeletion,
            titleVisibility: .visible
        ) {
            Button("Delete Account", role: .destructive) {
                Task { await session.deleteAccount() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Billing stops first. Your Nib files, review history, devices, generated images, and account are then permanently deleted. This cannot be undone.")
        }
    }

    @ViewBuilder
    private var settingsEmailField: some View {
        #if os(macOS)
        LabeledContent("Email") {
            TextField("", text: $session.email, prompt: Text("you@example.com"))
                .labelsHidden()
                .textFieldStyle(.roundedBorder)
                .textContentType(.emailAddress)
                .accessibilityLabel("Nib account email")
                .frame(maxWidth: 280)
        }
        #elseif os(watchOS)
        TextField("Email", text: $session.email)
            .textContentType(.emailAddress)
            .accessibilityLabel("Nib account email")
        #else
        TextField("Email", text: $session.email)
            .textContentType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityLabel("Nib account email")
        #endif
    }
}
