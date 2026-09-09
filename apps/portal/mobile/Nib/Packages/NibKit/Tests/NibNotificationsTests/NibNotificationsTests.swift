import Foundation
import Testing
import UserNotifications
@testable import NibNotifications

@Suite("Shared notification contract")
struct NibNotificationsTests {
    @Test("All native apps register the same categories")
    func categories() {
        let actual = Set(NibNotificationContract.categories().map(\.identifier))
        #expect(actual == Set(NibNotificationIdentifiers.categories))
    }

    @Test("Nested and flat APNs payloads resolve identically")
    func payloads() {
        let nested: [AnyHashable: Any] = ["nib": ["requestId": "request-1"]]
        let flat: [AnyHashable: Any] = ["requestId": "request-1"]
        #expect(NibNotificationContract.requestID(from: nested) == "request-1")
        #expect(NibNotificationContract.requestID(from: flat) == "request-1")
    }

    @Test("Actions resolve to shared navigation and feedback routes")
    func routes() throws {
        let request: [AnyHashable: Any] = ["nib": ["requestId": "request-1"]]
        #expect(NibNotificationContract.resolve(
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: request
        ) == .openRequest("request-1"))
        #expect(NibNotificationContract.resolve(
            actionIdentifier: NibNotificationIdentifiers.choice1,
            userInfo: request
        ) == .respondChoice(requestID: "request-1", choiceIndex: 1))
        #expect(NibNotificationContract.resolve(
            actionIdentifier: NibNotificationIdentifiers.text,
            userInfo: request,
            text: " Looks good "
        ) == .respondText(requestID: "request-1", text: "Looks good"))

        let projectURL = try #require(URL(string: "https://nib.example.test/project/one"))
        #expect(NibNotificationContract.resolve(
            actionIdentifier: NibNotificationIdentifiers.open,
            userInfo: ["url": projectURL.absoluteString]
        ) == .openURL(projectURL))
    }

    @Test("Acceptance review notifications open the authorized web flow and never resolve response routes")
    func acceptanceReviewOpensWebFlow() throws {
        let reviewURL = try #require(URL(string: "https://nibtool.com/acceptance/projects/project-1/reviews/review-1"))
        let payload: [AnyHashable: Any] = [
            "nib": [
                "type": "acceptance-review",
                "requestId": "review-1",
                "projectId": "project-1",
                "url": reviewURL.absoluteString,
                "choices": [],
                "allowText": false
            ]
        ]

        for action in [
            UNNotificationDefaultActionIdentifier,
            NibNotificationIdentifiers.open,
            NibNotificationIdentifiers.choice0,
            NibNotificationIdentifiers.choice1,
            NibNotificationIdentifiers.text
        ] {
            #expect(NibNotificationContract.resolve(
                actionIdentifier: action,
                userInfo: payload,
                text: "approve"
            ) == .openURL(reviewURL))
        }
    }

    @Test("Resolution and idempotency identities are deterministic")
    func resolution() {
        let resolution: [AnyHashable: Any] = [
            "nib": ["type": "request-resolved", "requestId": "request-1"]
        ]
        #expect(NibNotificationContract.resolvedRequestID(from: resolution) == "request-1")
        #expect(NibNotificationContract.resolvedRequestID(from: ["type": "request-created"]) == nil)
        #expect(NibNotificationContract.idempotencyKey(
            requestID: "request-1",
            notificationIdentifier: "push-1",
            actionIdentifier: NibNotificationIdentifiers.choice0
        ) == "notification:request-1:push-1:NIB_CHOICE_0")
    }

    @Test("Unsigned package tests do not invent an APNs environment")
    func environment() {
        #expect(NibNotificationContract.apnsEnvironment == nil)
    }
}
