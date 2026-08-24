import Foundation
import Testing
import UserNotifications
@testable import Nib

struct NibMacNotificationRoutingTests {
    @Test
    func registersSharedNibCategoryIdentifiers() {
        let identifiers = Set(NibMacNotificationActions.categories().map(\.identifier))

        #expect(identifiers == Set(NibMacNotificationActions.categoryIdentifiers))
        #expect(identifiers.contains("NIB_APPROVE_REJECT"))
        #expect(identifiers.contains("NIB_TEXT"))
    }

    @Test
    func resolvesDefaultRequestDeepLink() {
        let route = NibMacNotificationRoute.resolve(
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: ["nib": ["requestId": "req-123"]]
        )

        #expect(route == .openRequest("req-123"))
    }

    @Test
    func resolvesChoiceAndTextActions() {
        let userInfo: [AnyHashable: Any] = ["requestId": "req-123"]

        #expect(NibMacNotificationRoute.resolve(
            actionIdentifier: NibMacNotificationActions.choice1,
            userInfo: userInfo
        ) == .respondChoice(requestID: "req-123", choiceIndex: 1))
        #expect(NibMacNotificationRoute.resolve(
            actionIdentifier: NibMacNotificationActions.text,
            userInfo: userInfo,
            text: " Looks good "
        ) == .respondText(requestID: "req-123", text: "Looks good"))
    }

    @Test
    func resolvesFallbackURL() throws {
        let url = try #require(URL(string: "https://nib.example.test/projects/portal"))
        let route = NibMacNotificationRoute.resolve(
            actionIdentifier: NibMacNotificationActions.open,
            userInfo: ["url": url.absoluteString]
        )

        #expect(route == .openURL(url))
    }
}
