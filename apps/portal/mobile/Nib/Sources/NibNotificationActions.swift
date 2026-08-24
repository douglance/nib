import Foundation
import NibNotifications
import UIKit
import UserNotifications

enum NibNotificationActions {
    static let open = NibNotificationIdentifiers.open
    static let choice0 = NibNotificationIdentifiers.choice0
    static let choice1 = NibNotificationIdentifiers.choice1
    static let choice2 = NibNotificationIdentifiers.choice2
    static let text = NibNotificationIdentifiers.text
    private static let pendingRequestKey = "nib.pendingNotification.requestId"
    private static let pendingProjectKey = "nib.pendingNotification.projectId"
    private static let pendingURLKey = "nib.pendingNotification.url"

    static func register() {
        UNUserNotificationCenter.current().setNotificationCategories(NibNotificationContract.categories())
    }

    @MainActor
    static func handle(response: UNNotificationResponse) async {
        let payload = nibPayload(from: response.notification.request.content.userInfo)
        if let deviceId = payload["deviceId"] as? String, !deviceId.isEmpty {
            NibDefaults.rememberRegisteredDeviceID(deviceId)
        }
        let text = (response as? UNTextInputNotificationResponse)?.userText
        guard let route = NibNotificationContract.resolve(
            actionIdentifier: response.actionIdentifier,
            userInfo: response.notification.request.content.userInfo,
            text: text
        ) else {
            if response.actionIdentifier == UNNotificationDefaultActionIdentifier
                || response.actionIdentifier == open {
                await openPayload(payload)
            }
            return
        }
        switch route {
        case .openRequest(let requestId):
            storePendingRequestId(requestId)
            await markClicked(requestId: requestId)
            NotificationCenter.default.post(name: .nibOpenRequest, object: requestId)
        case .openProject, .openURL:
            await openPayload(payload)
        case .respondChoice(let requestId, let choiceIndex):
            let deviceId = payload["deviceId"] as? String ?? "ios-notification"
            if await respond(
                requestId: requestId,
                body: ["choiceIndex": choiceIndex, "deviceId": deviceId, "notificationResponse": true],
                idempotencyKey: notificationIdempotencyKey(response, requestId: requestId)
            ) {
                clearDeliveredNotification(identifier: response.notification.request.identifier)
            }
        case .respondText(let requestId, let value):
            let deviceId = payload["deviceId"] as? String ?? "ios-notification"
            if await respond(
                requestId: requestId,
                body: ["text": value, "deviceId": deviceId, "notificationResponse": true],
                idempotencyKey: notificationIdempotencyKey(response, requestId: requestId)
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

    @MainActor
    static func handleRemoteNotification(userInfo: [AnyHashable: Any]) async -> Bool {
        guard let requestId = NibNotificationContract.resolvedRequestID(from: userInfo) else {
            return false
        }
        await clearDeliveredNotifications(requestId: requestId)
        await MainActor.run {
            NotificationCenter.default.post(name: .nibRequestsChanged, object: requestId)
        }
        return true
    }

    private static func nibPayload(from userInfo: [AnyHashable: Any]) -> [String: Any] {
        NibNotificationContract.payload(from: userInfo)
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

    private static func respond(requestId: String, body: [String: Any], idempotencyKey: String) async -> Bool {
        guard let url = endpoint("/api/requests/\(requestId)/respond"),
              JSONSerialization.isValidJSONObject(body),
              let data = try? JSONSerialization.data(withJSONObject: body)
        else {
            return false
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue(idempotencyKey, forHTTPHeaderField: "idempotency-key")
        request.httpBody = data
        authorize(&request)
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let httpResponse = response as? HTTPURLResponse
        else {
            return false
        }
        return (200..<300).contains(httpResponse.statusCode)
    }

    private static func notificationIdempotencyKey(_ response: UNNotificationResponse, requestId: String) -> String {
        NibNotificationContract.idempotencyKey(
            requestID: requestId,
            notificationIdentifier: response.notification.request.identifier,
            actionIdentifier: response.actionIdentifier
        )
    }

    private static func clearDeliveredNotification(identifier: String) {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [identifier])
    }

    private static func endpoint(_ path: String) -> URL? {
        let base = NibDefaults.defaultBaseURLString
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
