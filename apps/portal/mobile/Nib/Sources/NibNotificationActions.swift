import Foundation
import UIKit
import UserNotifications

enum NibNotificationActions {
    static let open = "NIB_OPEN"
    static let choice0 = "NIB_CHOICE_0"
    static let choice1 = "NIB_CHOICE_1"
    static let choice2 = "NIB_CHOICE_2"
    static let text = "NIB_TEXT_REPLY"
    private static let pendingRequestKey = "nib.pendingNotification.requestId"
    private static let pendingProjectKey = "nib.pendingNotification.projectId"
    private static let pendingURLKey = "nib.pendingNotification.url"

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

    @MainActor
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
                NotificationCenter.default.post(name: .nibOpenRequest, object: requestId)
            }
            return
        }
        guard let requestId = payload["requestId"] as? String else {
            await openPayload(payload)
            return
        }
        let deviceId = payload["deviceId"] as? String ?? "ios-notification"
        if response.actionIdentifier == choice0 {
            if await respond(
                requestId: requestId,
                body: ["choiceIndex": 0, "deviceId": deviceId, "notificationResponse": true]
            ) {
                clearDeliveredNotification(identifier: response.notification.request.identifier)
            }
            return
        }
        if response.actionIdentifier == choice1 {
            if await respond(
                requestId: requestId,
                body: ["choiceIndex": 1, "deviceId": deviceId, "notificationResponse": true]
            ) {
                clearDeliveredNotification(identifier: response.notification.request.identifier)
            }
            return
        }
        if response.actionIdentifier == choice2 {
            if await respond(
                requestId: requestId,
                body: ["choiceIndex": 2, "deviceId": deviceId, "notificationResponse": true]
            ) {
                clearDeliveredNotification(identifier: response.notification.request.identifier)
            }
            return
        }
        if response.actionIdentifier == text, let textResponse = response as? UNTextInputNotificationResponse {
            let value = textResponse.userText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else { return }
            if await respond(
                requestId: requestId,
                body: ["text": value, "deviceId": deviceId, "notificationResponse": true]
            ) {
                clearDeliveredNotification(identifier: response.notification.request.identifier)
            }
        }
    }

    @MainActor
    private static func openPayload(_ payload: [String: Any]) async {
        if let feedbackId = payload["feedbackId"] as? String, !feedbackId.isEmpty {
            await markFeedbackClicked(feedbackId: feedbackId)
        }
        if let projectId = payload["projectId"] as? String, !projectId.isEmpty {
            storePendingProjectId(projectId)
            await MainActor.run {
                NotificationCenter.default.post(name: .nibOpenProject, object: projectId)
            }
            return
        }
        if let url = payloadURL(payload) {
            storePendingWebURL(url)
            await MainActor.run {
                NotificationCenter.default.post(name: .nibOpenWebURL, object: url)
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

    static func clearDeliveredNotifications(requestId: String) async {
        let center = UNUserNotificationCenter.current()
        let identifiers = await center.deliveredNotifications()
            .filter { notification in
                let payload = nibPayload(from: notification.request.content.userInfo)
                return payload["requestId"] as? String == requestId
            }
            .map(\.request.identifier)
        guard !identifiers.isEmpty else { return }
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
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

    private static func respond(requestId: String, body: [String: Any]) async -> Bool {
        guard let url = endpoint("/api/requests/\(requestId)/respond"),
              JSONSerialization.isValidJSONObject(body),
              let data = try? JSONSerialization.data(withJSONObject: body)
        else {
            return false
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = data
        authorize(&request)
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let httpResponse = response as? HTTPURLResponse
        else {
            return false
        }
        return (200..<300).contains(httpResponse.statusCode)
    }

    private static func clearDeliveredNotification(identifier: String) {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [identifier])
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
