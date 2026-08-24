import Foundation
import Testing
@testable import Nib

@MainActor
struct NibMacNavigationModelTests {
    @Test
    func sidebarSectionsMatchMacSliceOrder() {
        #expect(NibMacSidebarSection.allCases.map(\.title) == [
            "Inbox",
            "History",
            "Projects",
            "Devices",
            "Activity"
        ])
    }

    @Test
    func historyFiltersClassifyCompletedRequests() throws {
        let approved = try request(id: "approved", status: "answered", decision: "approve", comment: nil)
        let rejected = try request(id: "rejected", status: "answered", decision: "reject", comment: "Move the button.")
        let commented = try request(id: "commented", status: "answered", decision: "comment", comment: "Need another pass.")
        let captured = try request(
            id: "captured",
            status: "answered",
            decision: "approve",
            comment: nil,
            attachmentType: "video",
            attachmentContentType: "video/mp4"
        )

        let history = [approved, rejected, commented, captured]

        #expect(NibMacHistoryFilter.all.filtered(history).map(\.id) == ["approved", "rejected", "commented", "captured"])
        #expect(NibMacHistoryFilter.approved.filtered(history).map(\.id) == ["approved", "captured"])
        #expect(NibMacHistoryFilter.rejected.filtered(history).map(\.id) == ["rejected"])
        #expect(NibMacHistoryFilter.commented.filtered(history).map(\.id) == ["commented"])
        #expect(NibMacHistoryFilter.captures.filtered(history).map(\.id) == ["captured"])
    }

    @Test
    func storeSeparatesInboxHistoryAndBadges() throws {
        let store = NibMacRequestStore()
        let open = try request(id: "open", status: "open", decision: nil, comment: nil, updatedAt: "2026-07-23T12:00:00.000Z")
        let approved = try request(id: "approved", status: "answered", decision: "approve", comment: nil, updatedAt: "2026-07-23T11:00:00.000Z")
        let rejected = try request(id: "rejected", status: "answered", decision: "reject", comment: "No.", updatedAt: "2026-07-23T10:00:00.000Z")

        store.apply(NibRequestSocketEvent(type: "request", action: "created", request: rejected))
        store.apply(NibRequestSocketEvent(type: "request", action: "responded", request: approved))
        store.apply(NibRequestSocketEvent(type: "request", action: "created", request: open))

        #expect(store.inboxRequests.map(\.id) == ["open"])
        #expect(store.historyRequests.map(\.id) == ["approved", "rejected"])
        #expect(store.badges.sidebar[.inbox] == 1)
        #expect(store.badges.sidebar[.history] == 2)
        #expect(store.badges.dock == 1)
        #expect(store.badges.menuBar == 1)
    }

    @Test
    func deterministicPreviewStatesSelectMeaningfulDetail() {
        #expect(NibMacPreviewState.populated.selectedRequestID == "approve-layout")
        #expect(NibMacPreviewState.uploading.selectedRequestID == "uploading-capture")
        #expect(NibMacPreviewState.historyAll.selectedLibraryItemID == "file-child")
        #expect(NibMacPreviewState.historyRejected.selectedRequestID == "rejected-state")
        #expect(NibMacPreviewState.empty.selectedRequestID == nil)
    }

    private func request(
        id: String,
        status: String,
        decision: String?,
        comment: String?,
        updatedAt: String = "2026-07-23T11:00:00.000Z",
        attachmentType: String = "image",
        attachmentContentType: String = "image/png"
    ) throws -> NibRequest {
        let response: String
        if let decision {
            response = """
            {
              "id": "\(id)-response",
              "kind": "visual-review",
              "text": "\(comment ?? decision)",
              "choice": "\(decision)",
              "choiceIndex": 0,
              "deviceId": null,
              "device": null,
              "createdAt": "2026-07-23T12:00:00.000Z"
            }
            """
        } else {
            response = ""
        }

        let json = """
        {
          "id": "\(id)",
          "kind": "visual-review",
          "title": "Review \(id)",
          "prompt": "Approve this?",
          "body": null,
          "context": null,
          "choices": [],
          "allowText": true,
          "target": {
            "projectId": "project-\(id)",
            "projectName": "Project \(id)",
            "appPath": null,
            "url": null
          },
          "status": "\(status)",
          "priority": "normal",
          "source": "nib",
          "createdAt": "2026-07-23T10:00:00.000Z",
          "updatedAt": "\(updatedAt)",
          "attachments": [
            {
              "id": "\(id)-attachment",
              "requestId": "\(id)",
              "name": "capture",
              "type": "\(attachmentType)",
              "contentType": "\(attachmentContentType)",
              "bytes": 1024,
              "url": "/api/requests/\(id)/attachments/capture",
              "createdAt": "2026-07-23T10:00:00.000Z"
            }
          ],
          "responses": [\(response)]
        }
        """
        return try JSONDecoder().decode(NibRequest.self, from: Data(json.utf8))
    }
}
