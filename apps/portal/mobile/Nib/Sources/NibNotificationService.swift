import Foundation
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        guard let bestAttemptContent = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        self.bestAttemptContent = bestAttemptContent

        guard let attachment = richAttachment(from: request.content.userInfo) else {
            contentHandler(bestAttemptContent)
            return
        }

        URLSession.shared.downloadTask(with: attachment.url) { [weak self] temporaryURL, response, _ in
            guard let self, let bestAttemptContent = self.bestAttemptContent else { return }
            if let temporaryURL,
               let localURL = try? moveAttachment(
                from: temporaryURL,
                response: response,
                attachment: attachment
               ),
               let notificationAttachment = try? UNNotificationAttachment(
                identifier: "nib-rich-attachment",
                url: localURL,
                options: nil
               ) {
                bestAttemptContent.attachments = [notificationAttachment]
            }
            self.complete(bestAttemptContent)
        }.resume()
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler, let bestAttemptContent {
            contentHandler(bestAttemptContent)
        }
    }

    private func complete(_ content: UNNotificationContent) {
        contentHandler?(content)
        contentHandler = nil
    }
}

private struct RichAttachment {
    let url: URL
    let name: String
    let contentType: String
}

private func richAttachment(from userInfo: [AnyHashable: Any]) -> RichAttachment? {
    guard let nib = userInfo["nib"] as? [AnyHashable: Any],
          let attachment = nib["richAttachment"] as? [AnyHashable: Any],
          let rawURL = attachment["url"] as? String,
          let url = URL(string: rawURL) else {
        return nil
    }
    let name = (attachment["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    let contentType = (attachment["contentType"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    return RichAttachment(
        url: url,
        name: sanitizedFileName(name?.isEmpty == false ? name! : url.lastPathComponent),
        contentType: contentType?.isEmpty == false ? contentType! : "image/png"
    )
}

private func moveAttachment(from temporaryURL: URL, response: URLResponse?, attachment: RichAttachment) throws -> URL {
    let extensionHint = fileExtension(for: attachment.contentType, fallback: attachment.name)
    let localURL = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString)
        .appendingPathExtension(extensionHint)
    if FileManager.default.fileExists(atPath: localURL.path) {
        try FileManager.default.removeItem(at: localURL)
    }
    if let httpResponse = response as? HTTPURLResponse, !(200..<300).contains(httpResponse.statusCode) {
        throw URLError(.badServerResponse)
    }
    try FileManager.default.moveItem(at: temporaryURL, to: localURL)
    return localURL
}

private func fileExtension(for contentType: String, fallback: String) -> String {
    switch contentType.lowercased() {
    case "image/jpeg", "image/jpg":
        return "jpg"
    case "image/gif":
        return "gif"
    case "image/heic":
        return "heic"
    default:
        let fallbackExtension = (fallback as NSString).pathExtension
        return fallbackExtension.isEmpty ? "png" : fallbackExtension
    }
}

private func sanitizedFileName(_ value: String) -> String {
    let lastPathComponent = (value as NSString).lastPathComponent
    return lastPathComponent.isEmpty ? "attachment.png" : lastPathComponent
}
