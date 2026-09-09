import XCTest
@testable import Nib

@MainActor
final class NibMacRequestStoreTests: XCTestCase {
    func testApplySortsRequestsAndKeepsOnlyActiveItemsInMenu() throws {
        let older = try request(id: "older", status: "open", updatedAt: "2026-07-23T10:00:00.000Z")
        let newer = try request(id: "newer", status: "answered", updatedAt: "2026-07-23T11:00:00.000Z")
        let store = NibMacRequestStore()

        store.apply(NibRequestSocketEvent(type: "request", action: "created", request: older))
        store.apply(NibRequestSocketEvent(type: "request", action: "responded", request: newer))

        XCTAssertEqual(store.requests.map(\.id), ["newer", "older"])
        XCTAssertEqual(store.activeRequests.map(\.id), ["older"])
    }

    func testReviewURLUsesFixedNibCloudOriginOnAnyMac() throws {
        let request = try request(id: "request-id", status: "open", updatedAt: "2026-07-23T11:00:00.000Z")
        let store = NibMacRequestStore()

        XCTAssertEqual(store.reviewURL(for: request)?.absoluteString, "https://nibtool.com/r/request-id")
    }

    func testAcceptanceReviewUsesMetadataReviewURL() throws {
        let request = try acceptanceReview()
        let store = NibMacRequestStore()

        XCTAssertEqual(request.acceptanceReviewURL?.absoluteString, "https://nibtool.com/acceptance/projects/project-1/reviews/review-1")
        XCTAssertEqual(store.reviewURL(for: request)?.absoluteString, "https://nibtool.com/acceptance/projects/project-1/reviews/review-1")
        XCTAssertTrue(request.choices.isEmpty)
        XCTAssertFalse(request.allowText)
    }

    func testVisualReviewProvidesImageAndDecisionMapping() throws {
        let request = try request(id: "request-id", status: "open", updatedAt: "2026-07-23T11:00:00.000Z")

        XCTAssertEqual(request.visualReviewImage?.contentType, "image/png")
        XCTAssertEqual(request.visualReviewDecision(choiceIndex: 0), "approve")
        XCTAssertEqual(request.visualReviewDecision(choiceIndex: 1), "reject")
        XCTAssertNil(request.visualReviewDecision(choiceIndex: 2))
    }

    func testRequestNavigatorUsesPortalRequestURLContract() throws {
        let portal = try XCTUnwrap(URL(string: "https://nib.example.test/"))
        XCTAssertEqual(
            NibMacRequestNavigator.requestURL(requestID: "req-123", portalURL: portal)?.absoluteString,
            "https://nib.example.test/r/req-123"
        )
    }

    func testRequestNavigatorKeepsRequestOpeningNative() throws {
        let navigator = NibMacRequestNavigator()

        navigator.open(requestID: "req-123")

        XCTAssertEqual(
            navigator.requestOpenIntent,
            NibMacRequestOpenIntent(requestID: "req-123", sequence: 1)
        )
        XCTAssertNil(navigator.lastError)
    }

    func testRequestNavigatorResolvesNativeRequestURL() throws {
        let url = try XCTUnwrap(URL(string: "nib://request/req-123"))

        XCTAssertEqual(NibMacRequestNavigator.requestID(from: url), "req-123")
    }

    private func request(
        id: String,
        status: String,
        updatedAt: String,
        title: String = "Review",
        prompt: String = "Approve this?"
    ) throws -> NibRequest {
        let json = """
        {
          "id": "\(id)",
          "kind": "visual-review",
          "title": "\(title)",
          "prompt": "\(prompt)",
          "body": null,
          "context": null,
          "choices": [],
          "allowText": true,
          "target": {},
          "status": "\(status)",
          "priority": "normal",
          "source": "nib",
          "createdAt": "2026-07-23T10:00:00.000Z",
          "updatedAt": "\(updatedAt)",
          "attachments": [
            {
              "id": "preview",
              "requestId": "\(id)",
              "name": "review.png",
              "type": "image",
              "contentType": "image/png",
              "bytes": 1024,
              "url": "/api/requests/\(id)/attachments/preview",
              "createdAt": "2026-07-23T10:00:00.000Z"
            }
          ],
          "responses": []
        }
        """
        return try JSONDecoder().decode(NibRequest.self, from: Data(json.utf8))
    }

    private func acceptanceReview() throws -> NibRequest {
        let json = """
        {
          "id": "review-1",
          "kind": "acceptance-review",
          "title": "Acceptance review",
          "prompt": "Review build acceptance.",
          "body": null,
          "context": null,
          "choices": [],
          "allowText": false,
          "target": {
            "projectId": "project-1",
            "projectName": "Project 1",
            "appPath": null,
            "url": null
          },
          "status": "open",
          "priority": "normal",
          "source": "nib",
          "createdAt": "2026-07-23T10:00:00.000Z",
          "updatedAt": "2026-07-23T11:00:00.000Z",
          "attachments": [],
          "responses": [],
          "metadata": {
            "reviewUrl": "https://nibtool.com/acceptance/projects/project-1/reviews/review-1",
            "subject": { "nested": true }
          }
        }
        """
        return try JSONDecoder().decode(NibRequest.self, from: Data(json.utf8))
    }
}
