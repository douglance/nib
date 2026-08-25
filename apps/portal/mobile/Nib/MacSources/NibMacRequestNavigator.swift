import AppKit
import Foundation

struct NibMacRequestOpenIntent: Equatable {
    let requestID: String
    let sequence: UInt
}

@MainActor
final class NibMacRequestNavigator: ObservableObject {
    static let shared = NibMacRequestNavigator()

    @Published private(set) var lastError: String?
    @Published private(set) var requestOpenIntent: NibMacRequestOpenIntent?
    private var nextRequestOpenSequence: UInt = 0

    static func requestURL(requestID: String, portalURL: URL) -> URL? {
        URL(string: "/r/\(requestID)", relativeTo: portalURL)?.absoluteURL
    }

    static func requestID(from url: URL) -> String? {
        guard url.scheme?.lowercased() == "nib",
              url.host?.lowercased() == "request",
              let requestID = url.pathComponents.dropFirst().first,
              !requestID.isEmpty else {
            return nil
        }
        return requestID
    }

    func open(requestID: String) {
        guard !requestID.isEmpty else {
            lastError = "The request could not be opened."
            return
        }
        nextRequestOpenSequence &+= 1
        requestOpenIntent = NibMacRequestOpenIntent(
            requestID: requestID,
            sequence: nextRequestOpenSequence
        )
        NSApplication.shared.activate(ignoringOtherApps: true)
        let titledWindows = NSApplication.shared.windows.filter {
            $0.styleMask.contains(.titled)
        }
        let mainWindow = titledWindows.first { $0.identifier?.rawValue == "main" }
            ?? titledWindows.max {
                $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
            }
        mainWindow?.makeKeyAndOrderFront(nil)
        lastError = nil
    }

    func open(_ url: URL) {
        if NSWorkspace.shared.open(url) {
            lastError = nil
        } else {
            lastError = "Could not open Nib."
        }
    }
}
