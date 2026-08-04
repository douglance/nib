import UIKit
@preconcurrency import UserNotifications
@preconcurrency import UserNotificationsUI

@MainActor
final class NibNotificationContentViewController: UIViewController, @preconcurrency UNNotificationContentExtension, UITextFieldDelegate {
    private let textField = UITextField()
    private var payload: [String: Any] = [:]

    override func viewDidLoad() {
        super.viewDidLoad()

        view.backgroundColor = .clear
        view.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16)

        textField.borderStyle = .none
        textField.backgroundColor = .secondarySystemBackground
        textField.layer.cornerRadius = 18
        textField.clipsToBounds = true
        textField.font = .preferredFont(forTextStyle: .body)
        textField.adjustsFontForContentSizeCategory = true
        textField.placeholder = "Add a note..."
        textField.returnKeyType = .done
        textField.delegate = self
        textField.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 1))
        textField.leftViewMode = .always
        textField.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(textField)

        NSLayoutConstraint.activate([
            textField.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            textField.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            textField.topAnchor.constraint(equalTo: view.layoutMarginsGuide.topAnchor),
            textField.bottomAnchor.constraint(equalTo: view.layoutMarginsGuide.bottomAnchor),
            textField.heightAnchor.constraint(greaterThanOrEqualToConstant: 52)
        ])
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let size = CGSize(width: view.bounds.width, height: 72)
        if preferredContentSize != size {
            preferredContentSize = size
        }
    }

    func didReceive(_ notification: UNNotification) {
        payload = nibPayload(from: notification.request.content.userInfo)
        configureActions()
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return true
    }

    private var normalizedText: String? {
        let value = textField.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? nil : value
    }

    private var responseURL: URL? {
        if let value = payload["responseUrl"] as? String, let url = URL(string: value) {
            return url
        }
        guard let requestId = payload["requestId"] as? String,
              let requestURLString = payload["url"] as? String,
              let requestURL = URL(string: requestURLString),
              var components = URLComponents(url: requestURL, resolvingAgainstBaseURL: false)
        else {
            return nil
        }
        components.path = "/api/requests/\(requestId)/respond"
        components.query = nil
        components.fragment = nil
        return components.url
    }

    private func configureActions() {
        let choices = payload["choices"] as? [String] ?? []
        var actions = choices.prefix(3).enumerated().map { index, choice in
            UNNotificationAction(
                identifier: "NIB_CHOICE_\(index)",
                title: choice,
                options: []
            )
        }
        actions.append(
            UNNotificationAction(
                identifier: "NIB_OPEN",
                title: "Open",
                options: [.foreground]
            )
        )
        extensionContext?.notificationActions = actions
    }

    func didReceive(
        _ response: UNNotificationResponse,
        completionHandler completion: @escaping (UNNotificationContentExtensionResponseOption) -> Void
    ) {
        guard let choiceIndex = choiceIndex(for: response.actionIdentifier),
              let url = responseURL
        else {
            completion(.dismissAndForwardAction)
            return
        }

        var responseBody: [String: Any] = [
            "choiceIndex": choiceIndex,
            "deviceId": payload["deviceId"] as? String ?? "ios-notification-content",
            "notificationResponse": true
        ]
        if let text = normalizedText {
            responseBody["text"] = text
        }

        textField.isEnabled = false
        Task {
            if await submit(responseBody, to: url) {
                UNUserNotificationCenter.current().removeDeliveredNotifications(
                    withIdentifiers: [response.notification.request.identifier]
                )
                completion(.dismiss)
            } else {
                textField.isEnabled = true
                textField.placeholder = "Couldn't submit. Try again."
                completion(.doNotDismiss)
            }
        }
    }

    private func choiceIndex(for actionIdentifier: String) -> Int? {
        switch actionIdentifier {
        case "NIB_CHOICE_0": 0
        case "NIB_CHOICE_1": 1
        case "NIB_CHOICE_2": 2
        default: nil
        }
    }

    private func submit(_ responseBody: [String: Any], to url: URL) async -> Bool {
        guard JSONSerialization.isValidJSONObject(responseBody),
              let body = try? JSONSerialization.data(withJSONObject: responseBody)
        else {
            return false
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = body

        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let httpResponse = response as? HTTPURLResponse
        else {
            return false
        }
        return (200..<300).contains(httpResponse.statusCode)
    }

    private func nibPayload(from userInfo: [AnyHashable: Any]) -> [String: Any] {
        if let value = userInfo["nib"] as? [String: Any] {
            return value
        }
        if let value = userInfo["nib"] as? NSDictionary {
            return value as? [String: Any] ?? [:]
        }
        return userInfo.reduce(into: [String: Any]()) { result, item in
            if let key = item.key as? String {
                result[key] = item.value
            }
        }
    }
}
