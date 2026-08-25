import Foundation
import AppKit
import NibNotifications
import UserNotifications

enum NibMacNotificationActions {
    static let open = NibNotificationIdentifiers.open
    static let choice0 = NibNotificationIdentifiers.choice0
    static let choice1 = NibNotificationIdentifiers.choice1
    static let choice2 = NibNotificationIdentifiers.choice2
    static let text = NibNotificationIdentifiers.text

    static let categoryIdentifiers = NibNotificationIdentifiers.categories

    static func categories() -> Set<UNNotificationCategory> {
        NibNotificationContract.categories()
    }
}

enum NibMacNotificationRoute: Equatable {
    case openRequest(String)
    case openProject(String)
    case openURL(URL)
    case respondChoice(requestID: String, choiceIndex: Int)
    case respondText(requestID: String, text: String)

    static func resolve(
        actionIdentifier: String,
        userInfo: [AnyHashable: Any],
        text: String? = nil
    ) -> Self? {
        guard let route = NibNotificationContract.resolve(
            actionIdentifier: actionIdentifier,
            userInfo: userInfo,
            text: text
        ) else { return nil }
        switch route {
        case .openRequest(let requestID): return .openRequest(requestID)
        case .openProject(let projectID): return .openProject(projectID)
        case .openURL(let url): return .openURL(url)
        case .respondChoice(let requestID, let choiceIndex):
            return .respondChoice(requestID: requestID, choiceIndex: choiceIndex)
        case .respondText(let requestID, let text):
            return .respondText(requestID: requestID, text: text)
        }
    }

    static func payload(from userInfo: [AnyHashable: Any]) -> [String: Any] {
        NibNotificationContract.payload(from: userInfo)
    }

}

@MainActor
final class NibMacNotificationController: NSObject, UNUserNotificationCenterDelegate {
    private let store: NibMacRequestStore
    private let navigator: NibMacRequestNavigator

    init(store: NibMacRequestStore, navigator: NibMacRequestNavigator = .shared) {
        self.store = store
        self.navigator = navigator
    }

    func register() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(NibMacNotificationActions.categories())
        center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            Task { @MainActor in
                if let error {
                    self.store.setNotificationRegistrationError(error)
                    return
                }
                if granted {
                    NSApplication.shared.registerForRemoteNotifications()
                }
            }
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound, .badge]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let text = (response as? UNTextInputNotificationResponse)?.userText
        guard let route = NibMacNotificationRoute.resolve(
            actionIdentifier: response.actionIdentifier,
            userInfo: response.notification.request.content.userInfo,
            text: text
        ) else {
            return
        }
        let requestID = NibNotificationContract.requestID(
            from: response.notification.request.content.userInfo
        ) ?? "unknown"
        let idempotencyKey = NibNotificationContract.idempotencyKey(
            requestID: requestID,
            notificationIdentifier: response.notification.request.identifier,
            actionIdentifier: response.actionIdentifier
        )
        await handle(route, idempotencyKey: idempotencyKey)
    }

    func handleRemoteNotification(userInfo: [AnyHashable: Any]) async -> Bool {
        guard let requestID = NibNotificationContract.resolvedRequestID(from: userInfo) else {
            return false
        }
        let center = UNUserNotificationCenter.current()
        let identifiers = await center.deliveredNotifications()
            .filter { notification in
                NibMacNotificationRoute.payload(from: notification.request.content.userInfo)["requestId"] as? String == requestID
            }
            .map(\.request.identifier)
        if !identifiers.isEmpty {
            center.removeDeliveredNotifications(withIdentifiers: identifiers)
        }
        await store.reloadAll()
        return true
    }

    private func handle(_ route: NibMacNotificationRoute, idempotencyKey: String) async {
        switch route {
        case .openRequest(let requestID):
            await store.reload()
            navigator.open(requestID: requestID)
        case .openProject(let projectID):
            if let project = store.projects.first(where: { $0.id == projectID }),
               let url = store.projectURL(for: project) {
                navigator.open(url)
            } else if let url = URL(string: "/projects/\(projectID)", relativeTo: store.baseURL)?.absoluteURL {
                navigator.open(url)
            }
        case .openURL(let url):
            navigator.open(url)
        case .respondChoice(let requestID, let choiceIndex):
            _ = try? await store.respondToNotification(
                requestID: requestID,
                choiceIndex: choiceIndex,
                idempotencyKey: idempotencyKey
            )
        case .respondText(let requestID, let text):
            _ = try? await store.respondToNotification(
                requestID: requestID,
                text: text,
                idempotencyKey: idempotencyKey
            )
        }
    }
}
