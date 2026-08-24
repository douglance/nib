import Foundation
import XCTest
@testable import Nib

@MainActor
private final class FakeNibAccountClient: NibAccountClientProtocol {
    var status = NibAccountSessionTests.sampleStatus
    var authShouldFail = false
    var beginCount = 0
    var pollCount = 0
    var codeCount = 0
    var submittedCode: String?
    var transientPollFailures = 0
    var pollStatus: NibAuthStatus?
    var logoutCount = 0
    var deleteCount = 0

    func authStatus() async throws -> NibAuthStatus {
        if authShouldFail { throw URLError(.userAuthenticationRequired) }
        return status
    }

    func beginEmailSignIn(email: String, name: String, platform: String) async throws -> NibPendingSignIn {
        beginCount += 1
        return NibPendingSignIn(
            challengeId: "challenge-\(beginCount)",
            verifier: "verifier",
            expiresAt: Date().addingTimeInterval(600),
            email: email
        )
    }

    func pollEmailSignIn(_ pending: NibPendingSignIn) async throws -> NibAuthStatus? {
        pollCount += 1
        if transientPollFailures > 0 {
            transientPollFailures -= 1
            throw URLError(.networkConnectionLost)
        }
        return pollStatus
    }

    func redeemEmailSignInCode(_ code: String, pending: NibPendingSignIn) async throws -> NibAuthStatus {
        codeCount += 1
        submittedCode = code
        return status
    }

    func logout() async throws -> NibAuthLogout {
        logoutCount += 1
        return NibAuthLogout(revoked: true)
    }

    func deleteAccount() async throws -> NibAccountDeletion {
        deleteCount += 1
        return NibAccountDeletion(deleted: true)
    }
}

@MainActor
final class NibAccountSessionTests: XCTestCase {
    static let sampleStatus = NibAuthStatus(
        authenticated: true,
        account: .init(id: "account-1", email: "doug@example.com"),
        session: .init(id: "session-1", name: "Doug's Mac", platform: "macos")
    )

    func testOnlySignedInPhaseAllowsAppAccess() {
        let pending = NibPendingSignIn(
            challengeId: "challenge",
            verifier: "verifier",
            expiresAt: Date().addingTimeInterval(600),
            email: "doug@example.com"
        )

        XCTAssertFalse(NibAccountPhase.checking.allowsAppAccess)
        XCTAssertFalse(NibAccountPhase.signedOut.allowsAppAccess)
        XCTAssertFalse(NibAccountPhase.waiting(pending).allowsAppAccess)
        XCTAssertTrue(NibAccountPhase.signedIn(Self.sampleStatus).allowsAppAccess)
    }

    func testFailedRefreshLocksTheApp() async {
        let client = FakeNibAccountClient()
        client.authShouldFail = true
        let session = makeSession(client: client)

        await session.refresh()

        XCTAssertEqual(session.phase, .signedOut)
        XCTAssertFalse(session.phase.allowsAppAccess)
    }

    func testSendingLinkEntersWaitingStateWithoutBlockingResend() async {
        let client = FakeNibAccountClient()
        let session = makeSession(client: client, automaticallyPoll: false)
        session.email = "  doug@example.com  "

        await session.sendLink()

        XCTAssertEqual(client.beginCount, 1)
        XCTAssertEqual(session.pendingSignIn?.email, "doug@example.com")
        XCTAssertFalse(session.working)
        XCTAssertFalse(session.phase.allowsAppAccess)
    }

    func testTransientPollingFailureRecoversAndUnlocksApp() async {
        let client = FakeNibAccountClient()
        client.transientPollFailures = 1
        client.pollStatus = Self.sampleStatus
        let session = makeSession(
            client: client,
            sleep: { _ in await Task.yield() }
        )
        session.email = "doug@example.com"

        await session.sendLink()
        await waitUntil { session.phase.allowsAppAccess }

        XCTAssertEqual(client.pollCount, 2)
        XCTAssertEqual(session.status, Self.sampleStatus)
        XCTAssertTrue(session.phase.allowsAppAccess)
    }

    func testEmailCodeUnlocksAppAndClearsCode() async {
        let client = FakeNibAccountClient()
        let session = makeSession(client: client, automaticallyPoll: false)
        session.email = "doug@example.com"
        await session.sendLink()
        session.signInCode = "123 456"

        await session.submitCode()

        XCTAssertEqual(client.codeCount, 1)
        XCTAssertEqual(client.submittedCode, "123456")
        XCTAssertEqual(session.status, Self.sampleStatus)
        XCTAssertEqual(session.signInCode, "")
        XCTAssertTrue(session.phase.allowsAppAccess)
    }

    func testSignOutImmediatelyLocksTheApp() async {
        let client = FakeNibAccountClient()
        let session = makeSession(client: client, initialPhase: .signedIn(Self.sampleStatus))

        await session.signOut()

        XCTAssertEqual(client.logoutCount, 1)
        XCTAssertEqual(session.phase, .signedOut)
        XCTAssertFalse(session.phase.allowsAppAccess)
    }

    private func makeSession(
        client: FakeNibAccountClient,
        initialPhase: NibAccountPhase = .checking,
        automaticallyPoll: Bool = true,
        sleep: @escaping (Duration) async throws -> Void = { duration in
            try await Task.sleep(for: duration)
        }
    ) -> NibAccountSession {
        NibAccountSession(
            client: client,
            platform: "macos",
            deviceName: "Doug's Mac",
            initialPhase: initialPhase,
            pollInterval: .zero,
            automaticallyPoll: automaticallyPoll,
            sleep: sleep
        )
    }

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<100 {
            if condition() { return }
            await Task.yield()
        }
    }
}
