import Foundation
import UserNotifications

public enum NibNotificationIdentifiers {
    public static let open = "NIB_OPEN"
    public static let choice0 = "NIB_CHOICE_0"
    public static let choice1 = "NIB_CHOICE_1"
    public static let choice2 = "NIB_CHOICE_2"
    public static let text = "NIB_TEXT_REPLY"

    public static let categories = [
        "NIB_OPEN",
        "NIB_APPROVAL",
        "NIB_CHOICE",
        "NIB_TEXT",
        "NIB_SHIP_HOLD_REVISE",
        "NIB_APPROVE_HOLD",
        "NIB_APPROVE_REJECT",
        "NIB_ALLOW_DENY",
        "NIB_YES_NO",
        "NIB_SHIP_HOLD",
        "NIB_USE_REVISE"
    ]
}

public enum NibNotificationRoute: Equatable, Sendable {
    case openRequest(String)
    case openProject(String)
    case openURL(URL)
    case respondChoice(requestID: String, choiceIndex: Int)
    case respondText(requestID: String, text: String)
}

public enum NibNotificationContract {
    public static var apnsEnvironment: String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "NibAPNSEnvironment") as? String else {
            return nil
        }
        switch value.lowercased() {
        case "development", "sandbox": return "sandbox"
        case "production": return "production"
        default: return nil
        }
    }

    public static func categories() -> Set<UNNotificationCategory> {
        let openAction = UNNotificationAction(
            identifier: NibNotificationIdentifiers.open,
            title: "Open",
            options: [.foreground]
        )
        let firstAction = choiceAction(index: 0, title: "First")
        let secondAction = choiceAction(index: 1, title: "Second")
        let thirdAction = choiceAction(index: 2, title: "Third")
        let textAction = UNTextInputNotificationAction(
            identifier: NibNotificationIdentifiers.text,
            title: "Reply",
            options: [],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Reply"
        )

        return Set([
            UNNotificationCategory(identifier: "NIB_OPEN", actions: [openAction], intentIdentifiers: []),
            choiceCategory("NIB_APPROVAL", "Approve", "Hold", openAction),
            UNNotificationCategory(
                identifier: "NIB_CHOICE",
                actions: [firstAction, secondAction, thirdAction, textAction, openAction],
                intentIdentifiers: []
            ),
            UNNotificationCategory(identifier: "NIB_TEXT", actions: [textAction, openAction], intentIdentifiers: []),
            threeChoiceCategory("NIB_SHIP_HOLD_REVISE", "Ship", "Hold", "Revise", openAction),
            choiceCategory("NIB_APPROVE_HOLD", "Approve", "Hold", openAction),
            choiceCategory("NIB_APPROVE_REJECT", "Approve", "Reject", openAction),
            choiceCategory("NIB_ALLOW_DENY", "Allow", "Deny", openAction),
            choiceCategory("NIB_YES_NO", "Yes", "No", openAction),
            choiceCategory("NIB_SHIP_HOLD", "Ship", "Hold", openAction),
            choiceCategory("NIB_USE_REVISE", "Use it", "Revise", openAction)
        ])
    }

    public static func resolve(
        actionIdentifier: String,
        userInfo: [AnyHashable: Any],
        text: String? = nil
    ) -> NibNotificationRoute? {
        let payload = payload(from: userInfo)
        if actionIdentifier == UNNotificationDefaultActionIdentifier
            || actionIdentifier == NibNotificationIdentifiers.open {
            if let requestID = nonEmptyString(payload["requestId"]) {
                return .openRequest(requestID)
            }
            return fallbackOpenRoute(payload: payload)
        }

        guard let requestID = nonEmptyString(payload["requestId"]) else {
            return fallbackOpenRoute(payload: payload)
        }
        switch actionIdentifier {
        case NibNotificationIdentifiers.choice0:
            return .respondChoice(requestID: requestID, choiceIndex: 0)
        case NibNotificationIdentifiers.choice1:
            return .respondChoice(requestID: requestID, choiceIndex: 1)
        case NibNotificationIdentifiers.choice2:
            return .respondChoice(requestID: requestID, choiceIndex: 2)
        case NibNotificationIdentifiers.text:
            guard let value = text?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
                return nil
            }
            return .respondText(requestID: requestID, text: value)
        default:
            return fallbackOpenRoute(payload: payload)
        }
    }

    public static func payload(from userInfo: [AnyHashable: Any]) -> [String: Any] {
        if let nested = userInfo["nib"] as? [String: Any] {
            return nested
        }
        if let nested = userInfo["nib"] as? NSDictionary {
            return nested as? [String: Any] ?? [:]
        }
        return userInfo.reduce(into: [String: Any]()) { result, item in
            if let key = item.key as? String {
                result[key] = item.value
            }
        }
    }

    public static func resolvedRequestID(from userInfo: [AnyHashable: Any]) -> String? {
        let value = payload(from: userInfo)
        guard value["type"] as? String == "request-resolved" else { return nil }
        return nonEmptyString(value["requestId"])
    }

    public static func requestID(from userInfo: [AnyHashable: Any]) -> String? {
        nonEmptyString(payload(from: userInfo)["requestId"])
    }

    public static func idempotencyKey(
        requestID: String,
        notificationIdentifier: String,
        actionIdentifier: String
    ) -> String {
        "notification:\(requestID):\(notificationIdentifier):\(actionIdentifier)"
    }

    private static func fallbackOpenRoute(payload: [String: Any]) -> NibNotificationRoute? {
        if let projectID = nonEmptyString(payload["projectId"]) {
            return .openProject(projectID)
        }
        if let value = nonEmptyString(payload["url"]), let url = URL(string: value) {
            return .openURL(url)
        }
        return nil
    }

    private static func choiceAction(index: Int, title: String) -> UNNotificationAction {
        UNNotificationAction(identifier: "NIB_CHOICE_\(index)", title: title, options: [])
    }

    private static func choiceCategory(
        _ identifier: String,
        _ firstTitle: String,
        _ secondTitle: String,
        _ openAction: UNNotificationAction
    ) -> UNNotificationCategory {
        UNNotificationCategory(
            identifier: identifier,
            actions: [choiceAction(index: 0, title: firstTitle), choiceAction(index: 1, title: secondTitle), openAction],
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
                choiceAction(index: 0, title: firstTitle),
                choiceAction(index: 1, title: secondTitle),
                choiceAction(index: 2, title: thirdTitle),
                openAction
            ],
            intentIdentifiers: []
        )
    }

    private static func nonEmptyString(_ value: Any?) -> String? {
        guard let string = value as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
