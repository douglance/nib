import AppKit
import Foundation

@MainActor
final class NibMacRequestNavigator: ObservableObject {
    static let shared = NibMacRequestNavigator()

    @Published private(set) var lastError: String?

    static func requestURL(requestID: String, portalURL: URL) -> URL? {
        URL(string: "/r/\(requestID)", relativeTo: portalURL)?.absoluteURL
    }

    func open(requestID: String, portalURL: URL) {
        guard let url = Self.requestURL(requestID: requestID, portalURL: portalURL) else {
            lastError = "The request link could not be built."
            return
        }
        open(url)
    }

    func open(_ url: URL) {
        if NSWorkspace.shared.open(url) {
            lastError = nil
        } else {
            lastError = "Could not open Nib."
        }
    }
}
