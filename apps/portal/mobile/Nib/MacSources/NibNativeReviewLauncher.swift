import AppKit
import Combine
import Foundation

@MainActor
final class NibNativeReviewLauncher: ObservableObject {
    static let shared = NibNativeReviewLauncher()

    @Published private(set) var lastError: String?
    private var processes: [String: Process] = [:]
    private var reviewers: [String: NSRunningApplication] = [:]

    static func arguments(requestID: String, portalURL: URL) -> [String] {
        [
            "request",
            "review",
            requestID,
            "--portal",
            portalURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        ]
    }

    func open(requestID: String, portalURL: URL, bundle: Bundle = .main) {
        if let process = processes[requestID], process.isRunning {
            if let reviewer = reviewers[requestID] {
                activate(reviewer)
            } else {
                activateReviewer(
                    requestID: requestID,
                    helper: process.executableURL!,
                    launchedProcess: process
                )
            }
            return
        }

        let helper = bundle.bundleURL
            .appendingPathComponent("Contents/Helpers/nib-reviewer", isDirectory: false)
        guard FileManager.default.isExecutableFile(atPath: helper.path) else {
            lastError = "The bundled native reviewer is missing or is not executable."
            return
        }

        let process = Process()
        process.executableURL = helper
        process.arguments = Self.arguments(requestID: requestID, portalURL: portalURL)
        process.terminationHandler = { [weak self] process in
            Task { @MainActor in
                self?.processes.removeValue(forKey: requestID)
                self?.reviewers.removeValue(forKey: requestID)
                if process.terminationStatus != 0 {
                    self?.lastError = "The native reviewer exited before completing the request."
                }
            }
        }
        do {
            try process.run()
            processes[requestID] = process
            lastError = nil
            activateReviewer(
                requestID: requestID,
                helper: helper,
                launchedProcess: process
            )
        } catch {
            lastError = "Could not launch the native reviewer: \(error.localizedDescription)"
        }
    }

    private func activateReviewer(
        requestID: String,
        helper: URL,
        launchedProcess: Process
    ) {
        let helperPath = helper.resolvingSymlinksInPath().path
        let parentPID = launchedProcess.processIdentifier
        Task { @MainActor [weak self] in
            for _ in 0..<30 {
                try? await Task.sleep(for: .milliseconds(100))
                guard launchedProcess.isRunning else { return }
                let reviewer = NSWorkspace.shared.runningApplications
                    .filter {
                        $0.processIdentifier > parentPID
                            && $0.activationPolicy == .regular
                            && $0.executableURL?.resolvingSymlinksInPath().path == helperPath
                    }
                    .max { $0.processIdentifier < $1.processIdentifier }
                if let reviewer {
                    self?.reviewers[requestID] = reviewer
                    self?.activate(reviewer)
                    return
                }
            }
            self?.lastError = "The native reviewer opened but could not be brought forward."
        }
    }

    private func activate(_ reviewer: NSRunningApplication) {
        NSApplication.shared.yieldActivation(to: reviewer)
        reviewer.activate(options: [.activateAllWindows])
    }
}
